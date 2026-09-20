/**
 * The Cloudflare Workers telemetry composition: the OpenTelemetry JS SDK's
 * tracer and meter providers, an `AsyncLocalStorage` context manager, the W3C
 * propagator, a `console.log` logger, and per-request export over
 * `fetch`. The apps, middleware and decorators only see the runtime-neutral
 * `Telemetry` and `StructuredLogger` ports it returns, exactly as on Node.
 *
 * Why not the Node composition: a Worker isolate has no long-lived process,
 * no `require` hook, no background timers between requests and no `http`
 * module. So:
 *
 * - Spans are buffered in memory ({@link RequestFlushSpanProcessor}) and
 *   exported by {@link WorkersTelemetryRuntime.flush}, which the entrypoint
 *   hands to `ctx.waitUntil` after the response. No `BatchSpanProcessor`
 *   timer runs.
 * - Metrics are collected by a manual reader ({@link RequestMetricReader})
 *   with DELTA temporality on the same flush: each flush exports what was
 *   recorded since the previous one in this isolate, so every recording is
 *   exported once. No periodic reader runs.
 * - Each flush costs at most one OTLP subrequest per signal, bounded by
 *   `otlp.timeoutMs`, and never rejects. A failed export is dropped and
 *   logged once, never retried.
 * - Logs are the runtime-neutral console JSON logger (the same record
 *   contract, redaction and correlation as Pino) with {@link logRecord} as
 *   its sink: one `console.log` call per record, logging the record object,
 *   which Workers Logs indexes field by field and Logpush ships. No OTel
 *   Logs SDK.
 *
 * Nothing here is awaited on a response path or inside a database
 * transaction.
 *
 * @module
 */

import {
  ROOT_CONTEXT,
  TraceFlags,
  context,
  metrics as metricsApi,
  trace,
} from "@opentelemetry/api";
import { type ExportResult, W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  MeterProvider,
  MetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  ConsoleSpanExporter,
  ParentBasedSampler,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import { type StructuredLogger, createConsoleJsonLogger } from "#http/logger";
import type { WorkersTelemetryConfig } from "#telemetry/config";
import { resourceAttributes } from "#telemetry/log-record";
import { type Telemetry, createTelemetry } from "#telemetry/telemetry";

import { ensureWorkersContextManager } from "./context";
import { OtlpFetchMetricExporter, OtlpFetchSpanExporter, type OtlpSignal } from "./otlp-exporter";

/**
 * Bounds of the span buffer. A request produces fewer than ten spans; the
 * buffer only fills if exports keep failing to drain it, and then new spans
 * are dropped rather than growing memory.
 */
export const WORKERS_SPAN_LIMITS = Object.freeze({
  maxQueueSize: 2048,
  /** Spans per OTLP request; one request per flush. */
  maxExportBatchSize: 512,
});

export interface WorkersTelemetryRuntime {
  readonly telemetry: Telemetry;
  /** `console.log` logger with the resource attributes on every record. */
  readonly logger: StructuredLogger;
  /**
   * Exports buffered spans (one batch) and the metrics recorded since the
   * last flush, at most one request per signal. Resolves within the OTLP
   * timeout plus a small margin; never rejects. Hand it to `ctx.waitUntil`.
   */
  flush(): Promise<void>;
  /** Spans dropped because the buffer was full, since the isolate started. */
  droppedSpans(): number;
}

/** Test seams: exporters in place of OTLP, and the logger's sink. */
export interface WorkersTelemetryOverrides {
  readonly spanExporter?: SpanExporter;
  readonly metricExporter?: PushMetricExporter;
  readonly fetch?: typeof fetch;
  readonly write?: (line: string) => void;
}

/**
 * The Workers log sink: the record as an object, one `console.log` call per
 * record. Workers Logs extracts and indexes the fields of a logged object
 * (a logged string is stored as an opaque message), and Logpush and Tail
 * Workers receive it as structured data. The line is the logger's own
 * `JSON.stringify` output, already redacted, so parsing it back is lossless.
 */
export function logRecord(line: string): void {
  // oxlint-disable-next-line no-console -- the console is the Worker's log sink.
  console.log(JSON.parse(line) as Record<string, unknown>);
}

/** Calls `exporter.export` and resolves with its result; never rejects. */
function exportWith<Items>(
  exporter: { export(items: Items, callback: (result: ExportResult) => void): void },
  items: Items,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      exporter.export(items, () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Buffers ended, sampled spans until {@link exportBatch}; no timers. Ended
 * spans are not exported on the response path.
 */
export class RequestFlushSpanProcessor implements SpanProcessor {
  readonly #exporter: SpanExporter;
  readonly #buffer: ReadableSpan[] = [];
  #dropped = 0;

  constructor(exporter: SpanExporter) {
    this.#exporter = exporter;
  }

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) {
      return;
    }
    if (this.#buffer.length >= WORKERS_SPAN_LIMITS.maxQueueSize) {
      this.#dropped += 1;
      return;
    }
    this.#buffer.push(span);
  }

  /** Exports up to one batch; concurrent calls export disjoint spans. */
  async exportBatch(): Promise<void> {
    const batch = this.#buffer.splice(0, WORKERS_SPAN_LIMITS.maxExportBatchSize);
    if (batch.length > 0) {
      await exportWith(this.#exporter, batch);
    }
  }

  dropped(): number {
    return this.#dropped;
  }

  forceFlush(): Promise<void> {
    return this.exportBatch();
  }

  async shutdown(): Promise<void> {
    await this.exportBatch();
  }
}

/**
 * A pull reader: collects when {@link collectAndExport} is called, with
 * DELTA temporality, and exports nothing when nothing was recorded.
 */
export class RequestMetricReader extends MetricReader {
  readonly #exporter: PushMetricExporter;

  constructor(exporter: PushMetricExporter) {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.DELTA });
    this.#exporter = exporter;
  }

  async collectAndExport(): Promise<void> {
    const { resourceMetrics } = await this.collect();
    const recorded = resourceMetrics.scopeMetrics.some((scope) =>
      scope.metrics.some((metric) => metric.dataPoints.length > 0),
    );
    if (recorded) {
      await exportWith(this.#exporter, resourceMetrics);
    }
  }

  protected override async onForceFlush(): Promise<void> {}

  protected override async onShutdown(): Promise<void> {}
}

/** Resolves when `work` settles or after `timeoutMs`, whichever is first. */
async function bounded(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Extra time a flush may take beyond the OTLP request bound (serialization). */
const FLUSH_MARGIN_MS = 250;

function spanExporterFor(
  config: WorkersTelemetryConfig,
  overrides: WorkersTelemetryOverrides,
  onFailure: (signal: OtlpSignal, reason: string) => void,
): SpanExporter | undefined {
  if (overrides.spanExporter !== undefined) {
    return overrides.spanExporter;
  }
  const { exporter, endpoint } = config.traces;
  if (exporter === "console") {
    return new ConsoleSpanExporter();
  }
  if (exporter === "otlp" && endpoint !== undefined) {
    return new OtlpFetchSpanExporter({
      url: endpoint,
      headers: config.otlp.headers,
      timeoutMs: config.otlp.timeoutMs,
      onFailure,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
  }
  return undefined;
}

function metricExporterFor(
  config: WorkersTelemetryConfig,
  overrides: WorkersTelemetryOverrides,
  onFailure: (signal: OtlpSignal, reason: string) => void,
): PushMetricExporter | undefined {
  if (overrides.metricExporter !== undefined) {
    return overrides.metricExporter;
  }
  const { exporter, endpoint } = config.metrics;
  if (exporter === "console") {
    return new ConsoleMetricExporter({ temporalitySelector: () => AggregationTemporality.DELTA });
  }
  if (exporter === "otlp" && endpoint !== undefined) {
    return new OtlpFetchMetricExporter({
      url: endpoint,
      headers: config.otlp.headers,
      timeoutMs: config.otlp.timeoutMs,
      onFailure,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
  }
  return undefined;
}

/**
 * Builds the Worker's telemetry, once per isolate (the entrypoint caches it).
 * Registers the context manager globally; nothing else global.
 */
export function createWorkersTelemetry(
  config: WorkersTelemetryConfig,
  overrides: WorkersTelemetryOverrides = {},
): WorkersTelemetryRuntime {
  const base = resourceAttributes(config.resource);
  const logger = createConsoleJsonLogger({
    level: config.logLevel,
    base,
    write: overrides.write ?? logRecord,
  });
  const propagator = new W3CTraceContextPropagator();

  if (!config.enabled) {
    return {
      telemetry: createTelemetry({
        tracerProvider: trace.getTracerProvider(),
        meterProvider: metricsApi.getMeterProvider(),
        propagator,
      }),
      logger,
      flush: async () => undefined,
      droppedSpans: () => 0,
    };
  }

  ensureWorkersContextManager();
  // Export failures are reported outside any request's context, so they are
  // never correlated with the request whose flush happened to carry them.
  const onFailure = (signal: OtlpSignal, reason: string) =>
    context.with(ROOT_CONTEXT, () =>
      logger.warn("OpenTelemetry export failed", {
        "scos.telemetry.signal": signal,
        diagnostic: reason,
      }),
    );
  const spanExporter = spanExporterFor(config, overrides, onFailure);
  const metricExporter = metricExporterFor(config, overrides, onFailure);
  const spanProcessor =
    spanExporter === undefined ? undefined : new RequestFlushSpanProcessor(spanExporter);
  const metricReader =
    metricExporter === undefined ? undefined : new RequestMetricReader(metricExporter);
  const resource = resourceFromAttributes(base);

  const tracerProvider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.traces.samplerRatio),
    }),
    spanLimits: { attributeCountLimit: 128, attributeValueLengthLimit: 1024, eventCountLimit: 128 },
    // Spans are still created and sampled without an exporter, so logs stay
    // correlated; they are simply not exported.
    spanProcessors: spanProcessor === undefined ? [] : [spanProcessor],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: metricReader === undefined ? [] : [metricReader],
  });

  return {
    telemetry: createTelemetry({ tracerProvider, meterProvider, propagator }),
    logger,
    flush: () =>
      bounded(
        Promise.allSettled([spanProcessor?.exportBatch(), metricReader?.collectAndExport()]),
        config.otlp.timeoutMs + FLUSH_MARGIN_MS,
      ),
    droppedSpans: () => spanProcessor?.dropped() ?? 0,
  };
}
