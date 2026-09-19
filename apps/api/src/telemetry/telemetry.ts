/**
 * The telemetry port the adapters record with: one tracer, the W3C
 * propagator, the HTTP server duration histogram and the submission counter.
 * Built from any tracer provider, meter provider and propagator, so a
 * runtime composition (`telemetry/node/sdk.ts` for Node/Lambda) passes SDK
 * providers, tests pass in-memory ones and a disabled runtime the API's
 * no-op providers.
 *
 * Runtime-neutral: only `@opentelemetry/api` and semantic-convention
 * constants. Only `apps/api` depends on OpenTelemetry; `packages/core` and
 * `packages/persistence` stay free of it (their ports are decorated in the
 * compositions, see `telemetry/decorators.ts`).
 *
 * @module
 */

import {
  type Counter,
  type Histogram,
  type MeterProvider,
  type Span,
  SpanStatusCode,
  type TextMapPropagator,
  type Tracer,
  type TracerProvider,
  ValueType,
} from "@opentelemetry/api";
import {
  ATTR_DB_RESPONSE_STATUS_CODE,
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_TYPE,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from "@opentelemetry/semantic-conventions";

import { PACKAGE_VERSION } from "./config";
import { sanitizeError } from "./log-record";

/** Instrumentation scope name of every span and metric this adapter records. */
export const INSTRUMENTATION_SCOPE = "@scos/api";

/**
 * The semantic-conventions version the attribute names follow: the pinned
 * `@opentelemetry/semantic-conventions` package (a unit test keeps them equal).
 */
export const SEMCONV_VERSION = "1.43.0";
export const SEMCONV_SCHEMA_URL = `https://opentelemetry.io/schemas/${SEMCONV_VERSION}`;

/** Stable HTTP semantic conventions' advised bucket boundaries, in seconds. */
export const HTTP_SERVER_DURATION_BUCKETS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]);

export const SUBMISSIONS_METRIC = "scos.order.submissions";

/** Bounded attributes of {@link SUBMISSIONS_METRIC} and the SubmitOrder span. */
export const ATTR_SUBMISSION_OUTCOME = "scos.submission.outcome";
export const ATTR_SUBMISSION_REPLAYED = "scos.submission.replayed";
export const ATTR_SUBMISSION_REJECTION_REASON = "scos.submission.rejection_reason";
/** A PostgreSQL SQLSTATE or Prisma error code on a failed span, when known. */
export const ATTR_ERROR_CODE = "scos.error.code";

export const SUBMISSION_OUTCOMES = [
  "accepted",
  "rejected",
  "conflict",
  "invalid",
  "unavailable",
  "error",
] as const;
export type SubmissionOutcome = (typeof SUBMISSION_OUTCOMES)[number];

export interface Telemetry {
  readonly tracer: Tracer;
  readonly propagator: TextMapPropagator;
  /** `http.server.request.duration`, seconds. */
  readonly httpServerDuration: Histogram;
  /** `scos.order.submissions`: one per completed SubmitOrder call, replays included. */
  readonly submissions: Counter;
}

export interface TelemetryProviders {
  readonly tracerProvider: TracerProvider;
  readonly meterProvider: MeterProvider;
  /** The W3C Trace Context propagator (`traceparent`/`tracestate`). */
  readonly propagator: TextMapPropagator;
}

export function createTelemetry({
  tracerProvider,
  meterProvider,
  propagator,
}: TelemetryProviders): Telemetry {
  const scope = { schemaUrl: SEMCONV_SCHEMA_URL };
  const tracer = tracerProvider.getTracer(INSTRUMENTATION_SCOPE, PACKAGE_VERSION, scope);
  const meter = meterProvider.getMeter(INSTRUMENTATION_SCOPE, PACKAGE_VERSION, scope);
  return {
    tracer,
    propagator,
    httpServerDuration: meter.createHistogram(METRIC_HTTP_SERVER_REQUEST_DURATION, {
      description: "Duration of HTTP server requests.",
      unit: "s",
      valueType: ValueType.DOUBLE,
      advice: { explicitBucketBoundaries: [...HTTP_SERVER_DURATION_BUCKETS] },
    }),
    submissions: meter.createCounter(SUBMISSIONS_METRIC, {
      description:
        "Completed order submission requests by outcome, including replays of an accepted Order. Not a count of new Orders.",
      unit: "{submission}",
      valueType: ValueType.INT,
    }),
  };
}

/**
 * Marks `span` failed with a sanitized `exception` event: the error's class
 * name and, for database errors, its code (plus `db.response.status_code`
 * when the SQLSTATE is known). The message and stack are never
 * recorded; they can contain SQL, parameters or connection details.
 */
export function recordFailure(span: Span, error: unknown): string {
  const { type, code, sqlState } = sanitizeError(error);
  span.addEvent("exception", {
    [ATTR_EXCEPTION_TYPE]: type,
    ...(code === undefined ? {} : { [ATTR_ERROR_CODE]: code }),
  });
  span.setAttribute(ATTR_ERROR_TYPE, type);
  if (code !== undefined) {
    span.setAttribute(ATTR_ERROR_CODE, code);
  }
  if (sqlState !== undefined) {
    span.setAttribute(ATTR_DB_RESPONSE_STATUS_CODE, sqlState);
  }
  span.setStatus({ code: SpanStatusCode.ERROR });
  return type;
}
