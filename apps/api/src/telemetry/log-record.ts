/**
 * The runtime-neutral log record contract every logger adapter follows: the
 * Pino adapter on Node/Lambda (`telemetry/node/pino-logger.ts`), the console
 * JSON logger (`http/logger.ts`) and a future Workers adapter (follow-up PR
 * under #17). One JSON object per call, with these fields
 * (docs/observability.md, "Log record contract"):
 *
 * | Field                                          | OTel LogRecord                         |
 * | ---------------------------------------------- | -------------------------------------- |
 * | `time` (ISO 8601 UTC, ms)                      | Timestamp                              |
 * | `level` (`trace` ... `fatal`)                  | SeverityText                           |
 * | `severity_number` (1, 5, 9, 13, 17, 21)        | SeverityNumber                         |
 * | `msg`                                          | Body                                   |
 * | `trace_id`, `span_id`, `trace_flags`           | TraceId, SpanId, TraceFlags            |
 * | `service.name`, `service.version`,             | Resource                               |
 * | `deployment.environment.name`                  |                                        |
 * | every other key                                | Attributes                             |
 *
 * Only `@opentelemetry/api` and semantic-convention constants are imported
 * here, so every runtime can share it.
 *
 * @module
 */

import { type Context, context, isSpanContextValid, trace } from "@opentelemetry/api";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import type { TelemetryResource } from "./config";

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Pino level -> OpenTelemetry SeverityNumber: the start of each severity
 * range, the same mapping `@opentelemetry/instrumentation-pino` uses when it
 * sends logs itself.
 */
export const OTEL_SEVERITY_NUMBERS: Readonly<Record<LogLevelName, number>> = Object.freeze({
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
});

/** Pino's numeric levels, for level filtering in non-Pino adapters. */
export const LEVEL_VALUES: Readonly<Record<LogLevelName | "silent", number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
});

/**
 * Keys whose values are replaced with {@link REDACTION_CENSOR} at the top
 * level and one level down (which covers `headers.*`): credentials,
 * connection strings, request bodies and customer coordinates. Complements
 * the rule that code never logs those values in the first place.
 */
export const REDACTED_KEYS = Object.freeze([
  "authorization",
  "cookie",
  "password",
  "token",
  "secret",
  "databaseUrl",
  "DATABASE_URL",
  "connectionString",
  "body",
  "latitude",
  "longitude",
  "destination",
] as const);

export const REDACTION_CENSOR = "[REDACTED]";

/** {@link REDACTED_KEYS} as Pino `redact` paths: top level and one level down. */
export const REDACT_PATHS: readonly string[] = REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]);

const REDACTED = new Set<string>(REDACTED_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function censorKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, REDACTED.has(key) ? REDACTION_CENSOR : item]),
  );
}

/** The same redaction as {@link REDACT_PATHS}, for adapters without Pino. */
export function redact(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      if (REDACTED.has(key)) {
        return [key, REDACTION_CENSOR];
      }
      return [key, isPlainObject(value) ? censorKeys(value) : value];
    }),
  );
}

/** Only the name of an error class, when it looks like one. */
const SAFE_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,99}$/;
/** PostgreSQL SQLSTATE (`40001`) or Prisma (`P2002`) error codes. */
const SAFE_CODE = /^(?:[0-9A-Z]{5}|P\d{4})$/;

/**
 * An error reduced to what is safe to record in any signal: its class name
 * and, when it is a database error code, that code. Messages are dropped
 * because database and driver messages can contain SQL, parameters or
 * connection details.
 */
export interface SanitizedError {
  readonly type: string;
  /** The PostgreSQL SQLSTATE when known, else a safe Prisma code. */
  readonly code?: string;
  /** The PostgreSQL SQLSTATE (`db.response.status_code`), when known. */
  readonly sqlState?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function safeCode(value: unknown): string | undefined {
  const code = field(value, "code");
  return typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
}

function asSqlState(value: unknown): string | undefined {
  return typeof value === "string" && SQLSTATE.test(value) ? value : undefined;
}

/**
 * Whether `value` looks like a pg `DatabaseError`: a PostgreSQL error
 * response always carries `severity` (for example `ERROR`). A bare `code`
 * is not enough, since Node errno codes such as `EPIPE` have the same shape.
 */
function isPostgresErrorResponse(value: unknown): boolean {
  return typeof field(value, "severity") === "string";
}

/**
 * The SQLSTATE of a database error, from places where only a SQLSTATE can
 * be: a Prisma error's `meta.code` or `meta.driverAdapterError.cause.originalCode`
 * (PrismaPg, for example `P2010` wrapping a `55P03` lock timeout), or the
 * `code` of a pg `DatabaseError`. Never a bare `.code`, which may be a Node
 * errno (`EPIPE`) or a Prisma code (`P2010`).
 */
function sqlStateOf(value: unknown): string | undefined {
  const meta = field(value, "meta");
  return (
    asSqlState(field(meta, "code")) ??
    asSqlState(field(field(field(meta, "driverAdapterError"), "cause"), "originalCode")) ??
    (isPostgresErrorResponse(value) ? asSqlState(field(value, "code")) : undefined)
  );
}

/**
 * The error's class name and database codes, from the error or its direct
 * `cause` (persistence wraps driver errors such as a lock timeout in
 * `TransientSubmissionError`). The SQLSTATE is preferred over a Prisma code.
 */
export function sanitizeError(error: unknown): SanitizedError {
  if (!(error instanceof Error)) {
    return { type: typeof error === "object" && error !== null ? "Object" : typeof error };
  }
  const type = SAFE_NAME.test(error.name) ? error.name : "Error";
  const sqlState = sqlStateOf(error) ?? sqlStateOf(error.cause);
  const code = sqlState ?? safeCode(error) ?? safeCode(error.cause);
  return {
    type,
    ...(code === undefined ? {} : { code }),
    ...(sqlState === undefined ? {} : { sqlState }),
  };
}

/**
 * Stack frames only (`at fn (file:line:col)`). The first line of a stack
 * repeats the message, so it is dropped with any other non-frame line.
 */
function stackFrames(error: Error): readonly string[] {
  return (error.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .map((line) => line.trim());
}

/**
 * Keys the logger itself owns: severity, time, body, trace correlation and
 * resource fields. Log details and child bindings may not set them.
 */
export const RESERVED_LOG_KEYS: ReadonlySet<string> = new Set([
  "level",
  "severity_number",
  "severity_text",
  "time",
  "msg",
  "trace_id",
  "span_id",
  "trace_flags",
  "deployment.environment.name",
]);

/** Prefix given to a reserved key found in log details or bindings. */
export const RESERVED_KEY_PREFIX = "detail.";

export function isReservedLogKey(key: string): boolean {
  return RESERVED_LOG_KEYS.has(key) || key.startsWith("service.");
}

/**
 * Prepares log details or child bindings: reserved keys are prefixed with
 * {@link RESERVED_KEY_PREFIX} (so `{ trace_id: "x" }` can never pose as trace
 * correlation or shadow `level`), and every top-level Error becomes its
 * sanitized form plus stack frames.
 */
export function sanitizeDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    const name = isReservedLogKey(key) ? `${RESERVED_KEY_PREFIX}${key}` : key;
    safe[name] =
      value instanceof Error ? { ...sanitizeError(value), stack: stackFrames(value) } : value;
  }
  return safe;
}

/**
 * `trace_id`, `span_id` and `trace_flags` (two lowercase hex digits) of the
 * span in `active`, or nothing when there is no valid span context. The same
 * fields PinoInstrumentation injects; IDs are never invented.
 */
export function correlationFields(active: Context = context.active()): Record<string, string> {
  const spanContext = trace.getSpanContext(active);
  if (spanContext === undefined || !isSpanContextValid(spanContext)) {
    return {};
  }
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: `0${spanContext.traceFlags.toString(16)}`.slice(-2),
  };
}

/** Resource attributes, identical on traces, metrics and every log record. */
export function resourceAttributes(resource: TelemetryResource): Record<string, string> {
  return {
    [ATTR_SERVICE_NAME]: resource.serviceName,
    [ATTR_SERVICE_VERSION]: resource.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: resource.deploymentEnvironment,
  };
}
