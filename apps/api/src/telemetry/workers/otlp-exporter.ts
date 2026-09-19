/**
 * OTLP/HTTP (protobuf) export over `fetch` for Cloudflare Workers.
 *
 * The `@opentelemetry/exporter-*-otlp-proto` packages send through Node's
 * `http` module, or, in their browser build, through `fetch` with browser-only
 * options (`keepalive`, `mode`) and a retrying transport with backoff timers.
 * None of that fits a Worker, where export runs under `ctx.waitUntil` after
 * the response and every attempt is a subrequest. So this module serializes
 * with the SDK's own `@opentelemetry/otlp-transformer` and posts once:
 *
 * - one `fetch` per call, bounded by `timeoutMs` (an `AbortSignal` timeout);
 * - no retries: a failed batch is dropped and reported, never re-queued, so a
 *   collector outage costs at most one subrequest per signal per request;
 * - never throws; the result callback gets SUCCESS or FAILED, and `onFailure`
 *   receives a sanitized reason (never the URL, headers or response body).
 *
 * @module
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";

export type OtlpSignal = "traces" | "metrics";

export interface OtlpFetchOptions {
  /** The full signal URL, for example `http://localhost:4318/v1/traces`. */
  readonly url: string;
  /** Collector headers (credentials), from the OTEL_EXPORTER_OTLP_HEADERS secret. */
  readonly headers: Readonly<Record<string, string>>;
  /** Bound of the request, in milliseconds. */
  readonly timeoutMs: number;
  /** Called once per failed export with a reason safe to log. */
  readonly onFailure?: (signal: OtlpSignal, reason: string) => void;
  /** The `fetch` to use; the global one by default (a test seam). */
  readonly fetch?: typeof fetch;
}

/** A short reason that never contains the endpoint, headers or response body. */
export function failureReason(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : error.name;
  }
  return "unknown error";
}

/**
 * Posts one serialized OTLP request. Resolves SUCCESS for a 2xx response and
 * FAILED otherwise; never rejects.
 */
export async function postOtlp(
  signal: OtlpSignal,
  body: Uint8Array | undefined,
  options: OtlpFetchOptions,
): Promise<ExportResult> {
  const fail = (reason: string): ExportResult => {
    try {
      options.onFailure?.(signal, reason);
    } catch {
      // Reporting is best effort.
    }
    return { code: ExportResultCode.FAILED };
  };
  if (body === undefined) {
    return fail("serialization failed");
  }
  try {
    const response = await (options.fetch ?? fetch)(options.url, {
      method: "POST",
      headers: { ...options.headers, "content-type": "application/x-protobuf" },
      // The serializer allocates a plain ArrayBuffer-backed array.
      body: body as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    // Release the connection; the body (a partial-success message) is not needed.
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? { code: ExportResultCode.SUCCESS } : fail(`HTTP ${response.status}`);
  } catch (error) {
    return fail(failureReason(error));
  }
}

/** A `SpanExporter` that posts each batch once with {@link postOtlp}. */
export class OtlpFetchSpanExporter implements SpanExporter {
  readonly #options: OtlpFetchOptions;

  constructor(options: OtlpFetchOptions) {
    this.#options = options;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    void postOtlp("traces", ProtobufTraceSerializer.serializeRequest(spans), this.#options).then(
      resultCallback,
    );
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

/**
 * A `PushMetricExporter` that posts each collection once with
 * {@link postOtlp}. Temporality is DELTA: each Worker request exports only
 * what was recorded since the previous export in the same isolate.
 */
export class OtlpFetchMetricExporter implements PushMetricExporter {
  readonly #options: OtlpFetchOptions;

  constructor(options: OtlpFetchOptions) {
    this.#options = options;
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    void postOtlp(
      "metrics",
      ProtobufMetricsSerializer.serializeRequest(metrics),
      this.#options,
    ).then(resultCallback);
  }

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA;
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
