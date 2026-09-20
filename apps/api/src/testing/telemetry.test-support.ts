/**
 * Unit-test telemetry: in-memory span and metric exporters over real SDK
 * providers, and a capture stream for Pino's JSON output.
 */

import type { Attributes } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  AggregationTemporality,
  type DataPoint,
  type Histogram,
  InMemoryMetricExporter,
  MeterProvider,
  type MetricData,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  type ReadableSpan,
  type Sampler,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { DestinationStream } from "pino";

import type { Environment } from "#config";
import { parseHealthConfig } from "#endpoints/health/config";
import type { TelemetryConfig } from "#telemetry/config";
import { ensureContextManager } from "#telemetry/node/sdk";
import { type Telemetry, createTelemetry } from "#telemetry/telemetry";

export interface LogCapture {
  readonly destination: DestinationStream;
  /** Every `write` Pino made, unmodified. */
  readonly writes: string[];
  /** Each written line parsed as JSON. */
  records(): Record<string, unknown>[];
}

export function captureLogs(): LogCapture {
  const writes: string[] = [];
  return {
    destination: { write: (chunk: string) => void writes.push(chunk) },
    writes,
    records: () =>
      writes
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export interface TestTelemetry {
  readonly telemetry: Telemetry;
  readonly spans: InMemorySpanExporter;
  finished(): ReadableSpan[];
  span(name: string): ReadableSpan;
  /** Collects metrics now and returns the data points of `name`. */
  points<Value = number>(name: string): Promise<DataPoint<Value>[]>;
  histogram(name: string): Promise<DataPoint<Histogram>[]>;
  /** Collects metrics now and returns every metric's data. */
  metrics(): Promise<MetricData[]>;
  shutdown(): Promise<void>;
}

export function testTelemetry(sampler: Sampler = new AlwaysOnSampler()): TestTelemetry {
  ensureContextManager();
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000,
  });
  const tracerProvider = new TracerProvider({
    sampler,
    spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const telemetry = createTelemetry({
    tracerProvider,
    meterProvider,
    propagator: new W3CTraceContextPropagator(),
  });

  const metrics = async (): Promise<MetricData[]> => {
    await reader.forceFlush();
    const latest = metricExporter.getMetrics().at(-1);
    return latest?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];
  };

  const points = async <Value>(name: string): Promise<DataPoint<Value>[]> => {
    const metric = (await metrics()).find((candidate) => candidate.descriptor.name === name);
    return (metric?.dataPoints ?? []) as DataPoint<Value>[];
  };

  return {
    telemetry,
    spans,
    finished: () => spans.getFinishedSpans(),
    span(name) {
      const found = spans.getFinishedSpans().filter((span) => span.name === name);
      if (found.length !== 1) {
        throw new Error(`expected one span named ${name}, found ${found.length}`);
      }
      return found[0] as ReadableSpan;
    },
    points,
    histogram: (name) => points<Histogram>(name),
    metrics,
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

/** Data point attributes, for order-independent comparison. */
export function attributesOf(points: readonly { attributes: Attributes }[]): Attributes[] {
  return points.map((point) => point.attributes);
}

/** The telemetry configuration `environment` parses to; throws if invalid. */
export function parseTelemetryConfig(environment: Environment): TelemetryConfig {
  const result = parseHealthConfig(environment);
  if (!result.success) {
    throw new Error(`invalid telemetry configuration: ${result.errors.join("; ")}`);
  }
  return result.config.telemetry;
}

/** What an environment without any telemetry variable parses to, written out. */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  resource: { serviceName: "scos-api", serviceVersion: "0.0.0", deploymentEnvironment: "local" },
  logLevel: "info",
  otlp: { protocol: "http/protobuf", timeoutMs: 10_000 },
  traces: { exporter: "none", samplerRatio: 1 },
  metrics: { exporter: "none", exportIntervalMs: 60_000, exportTimeoutMs: 30_000 },
};
