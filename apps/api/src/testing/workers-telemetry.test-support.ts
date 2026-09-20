/**
 * Workers telemetry under test: the real Workers runtime
 * (`createWorkersTelemetry`) with in-memory exporters in place of the OTLP
 * `fetch` exporters, and helpers to read what its per-request flushes
 * exported. Runs inside workerd (`*.workers.test.ts`); imports nothing from
 * the Node composition.
 */

import type { Attributes } from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  DataPointType,
  type Histogram,
  InMemoryMetricExporter,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";

import { parseWorkerConfig } from "#config";
import type { WorkersTelemetryConfig } from "#telemetry/config";
import {
  type WorkersTelemetryOverrides,
  type WorkersTelemetryRuntime,
  createWorkersTelemetry,
} from "#telemetry/workers/sdk";

/** A syntactically valid connection string nothing listens on. */
export const UNREACHABLE_DATABASE_URL = "postgresql://scos:secret-password@127.0.0.1:1/scos";

/** The Worker configuration parsed from `variables`, as the entrypoint would. */
export function workerTelemetryConfig(
  variables: Readonly<Record<string, string>> = {},
): WorkersTelemetryConfig {
  const result = parseWorkerConfig({ DATABASE_URL: UNREACHABLE_DATABASE_URL, ...variables });
  if (!result.success) {
    throw new Error(result.errors.join("; "));
  }
  return result.config.telemetry;
}

function attributesKey(attributes: Attributes): string {
  return JSON.stringify(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)));
}

function mergePoint(
  type: DataPointType,
  total: DataPoint<unknown>,
  delta: DataPoint<unknown>,
): DataPoint<unknown> {
  if (type === DataPointType.HISTOGRAM) {
    const a = total.value as Histogram;
    const b = delta.value as Histogram;
    return {
      ...total,
      endTime: delta.endTime,
      value: {
        ...a,
        count: a.count + b.count,
        sum: (a.sum ?? 0) + (b.sum ?? 0),
        min: Math.min(a.min ?? Infinity, b.min ?? Infinity),
        max: Math.max(a.max ?? -Infinity, b.max ?? -Infinity),
        buckets: {
          boundaries: a.buckets.boundaries,
          counts: a.buckets.counts.map((count, index) => count + (b.buckets.counts[index] ?? 0)),
        },
      },
    };
  }
  return {
    ...total,
    endTime: delta.endTime,
    value: (total.value as number) + (delta.value as number),
  };
}

/**
 * Adds up DELTA exports into the cumulative view the contract reads: one
 * point per attribute set, in first-seen order, per metric.
 */
export function accumulateDeltas(exported: readonly MetricData[]): MetricData[] {
  const byName = new Map<string, { metric: MetricData; points: Map<string, DataPoint<unknown>> }>();
  for (const metric of exported) {
    if (metric.aggregationTemporality !== AggregationTemporality.DELTA) {
      throw new Error(`${metric.descriptor.name} was not exported with DELTA temporality`);
    }
    const entry = byName.get(metric.descriptor.name) ?? { metric, points: new Map() };
    byName.set(metric.descriptor.name, entry);
    for (const point of metric.dataPoints as DataPoint<unknown>[]) {
      const key = attributesKey(point.attributes);
      const total = entry.points.get(key);
      entry.points.set(
        key,
        total === undefined ? point : mergePoint(metric.dataPointType, total, point),
      );
    }
  }
  return [...byName.values()].map(
    ({ metric, points }) =>
      ({
        ...metric,
        aggregationTemporality: AggregationTemporality.CUMULATIVE,
        dataPoints: [...points.values()],
      }) as MetricData,
  );
}

export interface WorkersTestTelemetry {
  readonly runtime: WorkersTelemetryRuntime;
  readonly spanExporter: InMemorySpanExporter;
  readonly metricExporter: InMemoryMetricExporter;
  /** Every JSON line the runtime's logger wrote. */
  readonly lines: string[];
  /** Flushes, then returns every span exported so far. */
  spans(): Promise<ReadableSpan[]>;
  /** Flushes, then returns every metric exported so far, accumulated. */
  metrics(): Promise<MetricData[]>;
  /** Each flush's exported metrics, as sent (DELTA). */
  exports(): MetricData[][];
}

export function workersTestTelemetry(
  variables: Readonly<Record<string, string>> = {},
  overrides: WorkersTelemetryOverrides = {},
): WorkersTestTelemetry {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const lines: string[] = [];
  const runtime = createWorkersTelemetry(
    workerTelemetryConfig({ LOG_LEVEL: "info", ...variables }),
    { spanExporter, metricExporter, write: (line) => lines.push(line), ...overrides },
  );
  const exports = () =>
    metricExporter
      .getMetrics()
      .map((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  return {
    runtime,
    spanExporter,
    metricExporter,
    lines,
    async spans() {
      await runtime.flush();
      return spanExporter.getFinishedSpans();
    },
    async metrics() {
      await runtime.flush();
      return accumulateDeltas(exports().flat());
    },
    exports,
  };
}
