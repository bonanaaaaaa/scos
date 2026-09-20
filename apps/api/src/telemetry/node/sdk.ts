/**
 * The Node.js/Lambda telemetry composition: SDK providers, exporters,
 * AsyncLocalStorage context management, Pino log correlation and the
 * runtime's logger. Everything Node-specific lives under `telemetry/node/`;
 * the apps, decorators and HTTP middleware only see the runtime-neutral
 * `Telemetry` and `StructuredLogger` ports it returns. Called once by a
 * runtime entrypoint after configuration is validated and before any logger
 * is created or request is served.
 *
 * - Traces and metrics use the stable SDKs with explicit configuration;
 *   nothing is read from the environment by this module.
 * - Logs are Pino JSON on stdout. `PinoInstrumentation` runs in
 *   correlation-only mode (`disableLogSending: true`): it adds `trace_id`,
 *   `span_id` and `trace_flags` and sends nothing. No OpenTelemetry Logs SDK,
 *   LoggerProvider or log exporter is configured.
 * - Spans are exported by a bounded `BatchSpanProcessor`; metrics by a
 *   bounded periodic reader. Export happens in the background: a slow or
 *   failing collector never delays or changes a response.
 * - Idempotent: a second call returns the first runtime (for example a warm
 *   Lambda environment reusing the module).
 *
 * @module
 */

import {
  DiagLogLevel,
  ROOT_CONTEXT,
  type MeterProvider as ApiMeterProvider,
  type TracerProvider as ApiTracerProvider,
  context,
  diag,
  metrics,
  propagation,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  type SpanExporter,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { DestinationStream } from "pino";

import type { StructuredLogger } from "#http/logger";
import type { TelemetryConfig } from "#telemetry/config";
import { resourceAttributes } from "#telemetry/log-record";
import { createPinoLogger } from "#telemetry/node/pino-logger";
import { type Telemetry, createTelemetry } from "#telemetry/telemetry";

/** Bounds of the span export queue (see docs/observability.md). */
export const SPAN_BATCH_LIMITS = Object.freeze({
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 1000,
});

/** Default bound for {@link TelemetryRuntime.forceFlush} and `shutdown`. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

export interface TelemetryRuntime {
  readonly telemetry: Telemetry;
  /** Pino logger with the resource attributes on every record. */
  readonly logger: StructuredLogger;
  /** Exports what is buffered, bounded by `timeoutMs`. Never rejects. */
  forceFlush(timeoutMs?: number): Promise<void>;
  /** Flushes and stops the providers, bounded by `timeoutMs`. Never rejects; idempotent. */
  shutdown(timeoutMs?: number): Promise<void>;
}

/** Test seams: in-memory exporters and a log capture stream. */
export interface TelemetryOverrides {
  readonly spanExporter?: SpanExporter;
  readonly metricReader?: MetricReader;
  readonly logDestination?: DestinationStream;
}

let contextManagerRegistered = false;

/**
 * Registers AsyncLocalStorage context propagation, once per process: each
 * request's context follows its own async chain, so concurrent requests
 * never see each other's span.
 */
export function ensureContextManager(): void {
  if (!contextManagerRegistered) {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    contextManagerRegistered = true;
  }
}

function spanExporterFor(config: TelemetryConfig): SpanExporter | undefined {
  const { exporter, endpoint } = config.traces;
  if (exporter === "console") {
    return new ConsoleSpanExporter();
  }
  if (exporter === "otlp" && endpoint !== undefined) {
    return new OTLPTraceExporter({ url: endpoint, timeoutMillis: config.otlp.timeoutMs });
  }
  return undefined;
}

function metricExporterFor(config: TelemetryConfig): PushMetricExporter | undefined {
  const { exporter, endpoint } = config.metrics;
  if (exporter === "console") {
    return new ConsoleMetricExporter();
  }
  if (exporter === "otlp" && endpoint !== undefined) {
    return new OTLPMetricExporter({
      url: endpoint,
      timeoutMillis: config.otlp.timeoutMs,
      // Explicit, so OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE is not read.
      temporalityPreference: AggregationTemporality.CUMULATIVE,
    });
  }
  return undefined;
}

function spanProcessorsFor(
  config: TelemetryConfig,
  overrides: TelemetryOverrides,
): SpanProcessor[] {
  const exporter = overrides.spanExporter ?? spanExporterFor(config);
  if (exporter === undefined) {
    // Spans are still created and sampled, so logs stay correlated; they are
    // simply not exported.
    return [];
  }
  return [
    new BatchSpanProcessor({
      exporter,
      ...SPAN_BATCH_LIMITS,
      exportTimeoutMillis: config.otlp.timeoutMs,
    }),
  ];
}

function metricReadersFor(config: TelemetryConfig, overrides: TelemetryOverrides): MetricReader[] {
  if (overrides.metricReader !== undefined) {
    return [overrides.metricReader];
  }
  const exporter = metricExporterFor(config);
  if (exporter === undefined) {
    return [];
  }
  return [
    new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: config.metrics.exportIntervalMs,
      exportTimeoutMillis: config.metrics.exportTimeoutMs,
    }),
  ];
}

/** Resolves when `work` settles or after `timeoutMs`, whichever is first. */
async function bounded(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Longest diagnostic summary kept in a log record. */
const DIAGNOSTIC_MAX_LENGTH = 200;

/**
 * The first line of an SDK diagnostic, without stack frames, URLs or
 * addresses, and bounded in length. Export failures otherwise carry full
 * stacks and the collector's address.
 */
export function summarizeDiagnostic(message: unknown): string {
  let text = typeof message === "string" ? message : "";
  try {
    const parsed = JSON.parse(text) as { message?: unknown; stack?: unknown };
    const inner = parsed.message ?? parsed.stack;
    text = typeof inner === "string" ? inner : text;
  } catch {
    // Not JSON: use the text as it is.
  }
  const firstLine = text.split(/\r?\n|\\n/)[0] ?? "";
  return firstLine
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\[?[0-9a-f:.]*[0-9a-f]\]?:\d{1,5}\b/gi, "[address]")
    .slice(0, DIAGNOSTIC_MAX_LENGTH);
}

/**
 * Routes the SDK's own warnings (for example failed exports) to the logger,
 * summarized, and outside any request's context: an export started while a
 * request was active must not be correlated with that request.
 */
function routeDiagnostics(logger: StructuredLogger): void {
  const warn = (message: string) =>
    context.with(ROOT_CONTEXT, () =>
      logger.warn("OpenTelemetry SDK diagnostic", { diagnostic: summarizeDiagnostic(message) }),
    );
  diag.setLogger(
    { error: warn, warn, info: () => undefined, debug: () => undefined, verbose: () => undefined },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  );
}

interface Providers {
  readonly tracerProvider: TracerProvider;
  readonly meterProvider: MeterProvider;
}

function buildProviders(
  config: TelemetryConfig,
  resource: Resource,
  overrides: TelemetryOverrides,
): Providers {
  return {
    tracerProvider: new TracerProvider({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(config.traces.samplerRatio),
      }),
      spanLimits: {
        attributeCountLimit: 128,
        attributeValueLengthLimit: 1024,
        eventCountLimit: 128,
      },
      forceFlushTimeoutMillis: DEFAULT_FLUSH_TIMEOUT_MS,
      spanProcessors: spanProcessorsFor(config, overrides),
    }),
    meterProvider: new MeterProvider({ resource, readers: metricReadersFor(config, overrides) }),
  };
}

/**
 * Builds a runtime without touching process-wide state other than the
 * context manager; {@link startTelemetry} adds the global registrations.
 */
export function createTelemetryRuntime(
  config: TelemetryConfig,
  overrides: TelemetryOverrides = {},
): TelemetryRuntime & { readonly providers?: Providers } {
  const base = resourceAttributes(config.resource);
  const logger = () =>
    createPinoLogger({
      level: config.logLevel,
      base,
      ...(overrides.logDestination === undefined ? {} : { destination: overrides.logDestination }),
    });

  if (!config.enabled) {
    return {
      telemetry: createTelemetry({
        tracerProvider: trace.getTracerProvider(),
        meterProvider: metrics.getMeterProvider(),
        propagator: new W3CTraceContextPropagator(),
      }),
      logger: logger(),
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
  }

  ensureContextManager();
  const providers = buildProviders(config, resourceFromAttributes(base), overrides);
  const { tracerProvider, meterProvider } = providers;
  let stopping: Promise<void> | undefined;
  return {
    providers,
    telemetry: createTelemetry({ ...providers, propagator: new W3CTraceContextPropagator() }),
    logger: logger(),
    forceFlush: (timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) =>
      bounded(
        Promise.allSettled([
          tracerProvider.forceFlush(),
          meterProvider.forceFlush({ timeoutMillis: timeoutMs }),
        ]),
        timeoutMs,
      ),
    shutdown(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) {
      stopping ??= bounded(
        Promise.allSettled([
          tracerProvider.shutdown(),
          meterProvider.shutdown({ timeoutMillis: timeoutMs }),
        ]),
        timeoutMs,
      );
      return stopping;
    },
  };
}

let logCorrelationRegistered = false;

/**
 * Registers the AsyncLocalStorage context manager and `PinoInstrumentation`
 * in correlation-only mode (`disableLogSending: true`,
 * `disableLogCorrelation: false`), once per process. Must run before the
 * first Pino logger is created: the instrumentation patches Pino through
 * Node's require hook when `createPinoLogger` first loads it.
 */
export function registerLogCorrelation(): void {
  ensureContextManager();
  if (!logCorrelationRegistered) {
    registerInstrumentations({
      instrumentations: [
        new PinoInstrumentation({ disableLogSending: true, disableLogCorrelation: false }),
      ],
    });
    logCorrelationRegistered = true;
  }
}

let running: TelemetryRuntime | undefined;

/**
 * Starts telemetry for this process, once. Order matters: the context
 * manager, global providers and `PinoInstrumentation` are registered before
 * the first Pino logger is created (Pino is only loaded by
 * `createPinoLogger` in `pino-logger.ts`), so the instrumentation patches Pino in both `tsx` and
 * the esbuild bundle.
 */
export function startTelemetry(
  config: TelemetryConfig,
  overrides: TelemetryOverrides = {},
): TelemetryRuntime {
  if (running !== undefined) {
    return running;
  }
  if (config.enabled) {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    registerLogCorrelation();
  }
  const runtime = createTelemetryRuntime(config, overrides);
  if (runtime.providers !== undefined) {
    trace.setGlobalTracerProvider(runtime.providers.tracerProvider as ApiTracerProvider);
    metrics.setGlobalMeterProvider(runtime.providers.meterProvider as ApiMeterProvider);
    routeDiagnostics(runtime.logger);
  }
  running = runtime;
  return runtime;
}
