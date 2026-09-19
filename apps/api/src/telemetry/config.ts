/**
 * Telemetry and logging configuration: the environment variables every
 * runtime (local server, health, verify and submit) accepts, validated with
 * the same Zod helper as the rest of the configuration.
 *
 * Standard `OTEL_*` names are used where the meaning matches the OpenTelemetry
 * specification, but they are parsed here and passed to the SDK explicitly;
 * the SDK is built from components that do not read them again (see
 * docs/observability.md for the few exporter settings that still come from
 * the environment). Conditional rules apply only to enabled exporters, so an
 * OTLP endpoint is validated only when an OTLP exporter is selected. Messages
 * name the variable and a safe reason, never the value.
 *
 * @module
 */

import { z } from "zod";

export const TELEMETRY_EXPORTERS = ["otlp", "console", "none"] as const;
export type TelemetryExporter = (typeof TELEMETRY_EXPORTERS)[number];

/**
 * Only OTLP over HTTP with protobuf payloads (the specification's default) is
 * bundled; `grpc` and `http/json` are rejected rather than silently ignored.
 */
export const OTLP_PROTOCOLS = ["http/protobuf"] as const;
export type OtlpProtocol = (typeof OTLP_PROTOCOLS)[number];

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_SERVICE_NAME = "scos-api";
/**
 * `service.version` when SERVICE_VERSION is unset: the `@scos/api` package
 * version (a unit test keeps them equal). Deployments should set
 * SERVICE_VERSION to the release or commit they ship.
 */
export const PACKAGE_VERSION = "0.0.0";
export const DEFAULT_DEPLOYMENT_ENVIRONMENT = "local";
export const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";
export const DEFAULT_OTLP_TIMEOUT_MS = 10_000;
export const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
export const DEFAULT_METRIC_EXPORT_TIMEOUT_MS = 30_000;
/** Upper bound for every telemetry timeout and interval: one hour. */
const MAX_MILLISECONDS = 3_600_000;

/** Resource attributes shared by traces, metrics and logs. */
export interface TelemetryResource {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly deploymentEnvironment: string;
}

export interface TelemetryConfig {
  /** `false` when OTEL_SDK_DISABLED=true: no SDK, no spans, no metrics. Logs still work. */
  readonly enabled: boolean;
  readonly resource: TelemetryResource;
  readonly logLevel: LogLevel;
  readonly otlp: { readonly protocol: OtlpProtocol; readonly timeoutMs: number };
  readonly traces: {
    readonly exporter: TelemetryExporter;
    /** Full OTLP traces URL; present only when `exporter` is `otlp`. */
    readonly endpoint?: string;
    /** Root sampling ratio of the parent-based trace-ID-ratio sampler, 0 to 1. */
    readonly samplerRatio: number;
  };
  readonly metrics: {
    readonly exporter: TelemetryExporter;
    /** Full OTLP metrics URL; present only when `exporter` is `otlp`. */
    readonly endpoint?: string;
    readonly exportIntervalMs: number;
    readonly exportTimeoutMs: number;
  };
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const identifierError = "must be 1-128 letters, digits, '.', '_' or '-', starting alphanumeric";

function identifier(fallback: string) {
  return z.string().regex(IDENTIFIER, { error: identifierError }).optional().default(fallback);
}

function choice<const Values extends readonly [string, ...string[]]>(
  values: Values,
  fallback: Values[number],
) {
  return z
    .enum(values, { error: `must be one of ${values.join(", ")}` })
    .optional()
    .default(fallback);
}

function milliseconds(fallback: number) {
  const error = `must be an integer number of milliseconds between 1 and ${MAX_MILLISECONDS}`;
  return z
    .string()
    .regex(/^\d{1,7}$/, { error })
    .transform(Number)
    .refine((value) => value >= 1 && value <= MAX_MILLISECONDS, { error })
    .optional()
    .transform((value) => value ?? fallback);
}

const ratioError = "must be a decimal number between 0 and 1";
const ratioSchema = z
  .string()
  .regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/, { error: ratioError })
  .transform(Number)
  .optional()
  .transform((value) => value ?? 1);

/**
 * An OTLP/HTTP endpoint: http or https with a host, and no credentials in the
 * URL (use OTEL_EXPORTER_OTLP_HEADERS for those). Checked only when used.
 */
export function isOtlpEndpoint(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname.length > 0 &&
    url.username === "" &&
    url.password === ""
  );
}

const ENDPOINT_ERROR = "must be an http:// or https:// URL with a host and no credentials";

/** Every telemetry variable; spread into each runtime's environment schema. */
export const telemetryEnvironmentShape = {
  OTEL_SDK_DISABLED: choice(["true", "false"] as const, "false"),
  OTEL_SERVICE_NAME: identifier(DEFAULT_SERVICE_NAME),
  SERVICE_VERSION: z.string().regex(IDENTIFIER, { error: identifierError }).optional(),
  DEPLOYMENT_ENVIRONMENT: identifier(DEFAULT_DEPLOYMENT_ENVIRONMENT),
  LOG_LEVEL: choice(LOG_LEVELS, "info"),
  OTEL_TRACES_EXPORTER: choice(TELEMETRY_EXPORTERS, "none"),
  OTEL_METRICS_EXPORTER: choice(TELEMETRY_EXPORTERS, "none"),
  OTEL_TRACES_SAMPLER: choice(["parentbased_traceidratio"] as const, "parentbased_traceidratio"),
  OTEL_TRACES_SAMPLER_ARG: ratioSchema,
  OTEL_EXPORTER_OTLP_PROTOCOL: choice(OTLP_PROTOCOLS, "http/protobuf"),
  // Endpoints are plain optional strings here; `refineTelemetry` validates
  // them only when an OTLP exporter uses them.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().optional(),
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: z.string().optional(),
  OTEL_EXPORTER_OTLP_TIMEOUT: milliseconds(DEFAULT_OTLP_TIMEOUT_MS),
  OTEL_METRIC_EXPORT_INTERVAL: milliseconds(DEFAULT_METRIC_EXPORT_INTERVAL_MS),
  OTEL_METRIC_EXPORT_TIMEOUT: milliseconds(DEFAULT_METRIC_EXPORT_TIMEOUT_MS),
};

type TelemetryShape = typeof telemetryEnvironmentShape;
type RawTelemetry = Partial<Record<keyof TelemetryShape, unknown>>;

/**
 * Cross-field rules, applied to the whole runtime schema. Reads the raw
 * values defensively: it runs even when another variable is invalid, so every
 * problem is reported at once.
 */
export function refineTelemetry(value: RawTelemetry, context: z.RefinementCtx): void {
  if (value.OTEL_SDK_DISABLED === "true") {
    return;
  }
  const tracesOtlp = value.OTEL_TRACES_EXPORTER === "otlp";
  const metricsOtlp = value.OTEL_METRICS_EXPORTER === "otlp";
  const check = (name: keyof TelemetryShape) => {
    const endpoint = value[name];
    if (typeof endpoint === "string" && !isOtlpEndpoint(endpoint)) {
      context.addIssue({ code: "custom", path: [name], message: ENDPOINT_ERROR });
    }
  };
  const signalSpecific = (name: keyof TelemetryShape) => typeof value[name] === "string";
  if (
    (tracesOtlp && !signalSpecific("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) ||
    (metricsOtlp && !signalSpecific("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"))
  ) {
    check("OTEL_EXPORTER_OTLP_ENDPOINT");
  }
  if (tracesOtlp) {
    check("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  }
  if (metricsOtlp) {
    check("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT");
  }
  const interval = value.OTEL_METRIC_EXPORT_INTERVAL;
  const timeout = value.OTEL_METRIC_EXPORT_TIMEOUT;
  if (
    value.OTEL_METRICS_EXPORTER !== "none" &&
    typeof interval === "number" &&
    typeof timeout === "number" &&
    timeout > interval
  ) {
    context.addIssue({
      code: "custom",
      path: ["OTEL_METRIC_EXPORT_TIMEOUT"],
      message: "must not exceed OTEL_METRIC_EXPORT_INTERVAL",
    });
  }
}

/** Refinement options: run even when a field failed, to report everything. */
export const REFINE_ALWAYS = { when: () => true } as const;

/** Joins a base URL and the signal path the way the OTLP specification does. */
function signalUrl(base: string, path: "v1/traces" | "v1/metrics"): string {
  return `${base.endsWith("/") ? base : `${base}/`}${path}`;
}

/** The typed configuration from parsed telemetry variables. */
export function toTelemetryConfig(data: z.output<z.ZodObject<TelemetryShape>>): TelemetryConfig {
  const base = data.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT;
  const tracesEndpoint = data.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? signalUrl(base, "v1/traces");
  const metricsEndpoint = data.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? signalUrl(base, "v1/metrics");
  const tracesExporter = data.OTEL_TRACES_EXPORTER;
  const metricsExporter = data.OTEL_METRICS_EXPORTER;
  return {
    enabled: data.OTEL_SDK_DISABLED !== "true",
    resource: {
      serviceName: data.OTEL_SERVICE_NAME,
      serviceVersion: data.SERVICE_VERSION ?? PACKAGE_VERSION,
      deploymentEnvironment: data.DEPLOYMENT_ENVIRONMENT,
    },
    logLevel: data.LOG_LEVEL,
    otlp: {
      protocol: data.OTEL_EXPORTER_OTLP_PROTOCOL,
      timeoutMs: data.OTEL_EXPORTER_OTLP_TIMEOUT,
    },
    traces: {
      exporter: tracesExporter,
      ...(tracesExporter === "otlp" ? { endpoint: tracesEndpoint } : {}),
      samplerRatio: data.OTEL_TRACES_SAMPLER_ARG,
    },
    metrics: {
      exporter: metricsExporter,
      ...(metricsExporter === "otlp" ? { endpoint: metricsEndpoint } : {}),
      exportIntervalMs: data.OTEL_METRIC_EXPORT_INTERVAL,
      exportTimeoutMs: data.OTEL_METRIC_EXPORT_TIMEOUT,
    },
  };
}

// ---------------------------------------------------------------------------
// Cloudflare Workers
//
// The Worker reads the same variables from its `env` (Wrangler `vars` and
// secrets), validated once per isolate (`entrypoints/worker.ts`). There is no
// periodic metric reader on Workers, so the interval variables do not apply;
// telemetry is exported once per request under `ctx.waitUntil`, so the OTLP
// timeout is bounded by the 30 s `waitUntil` allowance. Collector credentials
// cannot come from the process environment there: they are a Worker secret,
// OTEL_EXPORTER_OTLP_HEADERS, parsed here and passed to the exporter.
// ---------------------------------------------------------------------------

/** Default and upper bound of one OTLP request from a Worker, in milliseconds. */
export const DEFAULT_WORKERS_OTLP_TIMEOUT_MS = 3_000;
export const MAX_WORKERS_OTLP_TIMEOUT_MS = 30_000;

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADERS_ERROR = "must be comma-separated name=value pairs with URL-encoded values";

/**
 * Parses OTEL_EXPORTER_OTLP_HEADERS (`name=value,name2=value2`, values
 * URL-encoded, as the OpenTelemetry specification defines it). Returns
 * `undefined` when malformed; the caller reports it without the value.
 */
export function parseOtlpHeaders(value: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    if (pair.trim().length === 0) {
      continue;
    }
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      return undefined;
    }
    const name = pair.slice(0, separator).trim();
    let decoded: string;
    try {
      decoded = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
    if (!HEADER_NAME.test(name) || decoded.length === 0 || /[\r\n\0]/.test(decoded)) {
      return undefined;
    }
    headers[name.toLowerCase()] = decoded;
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

const headersSchema = z
  .string()
  .refine((value) => parseOtlpHeaders(value) !== undefined, { error: HEADERS_ERROR })
  .optional();

function workersMilliseconds(fallback: number) {
  const error = `must be an integer number of milliseconds between 1 and ${MAX_WORKERS_OTLP_TIMEOUT_MS}`;
  return z
    .string()
    .regex(/^\d{1,5}$/, { error })
    .transform(Number)
    .refine((value) => value >= 1 && value <= MAX_WORKERS_OTLP_TIMEOUT_MS, { error })
    .optional()
    .transform((value) => value ?? fallback);
}

const {
  OTEL_METRIC_EXPORT_INTERVAL: _interval,
  OTEL_METRIC_EXPORT_TIMEOUT: _timeout,
  ...sharedTelemetryShape
} = telemetryEnvironmentShape;

/** The Worker's telemetry variables: the shared ones, adapted to per-request export. */
export const workersTelemetryEnvironmentShape = {
  ...sharedTelemetryShape,
  OTEL_EXPORTER_OTLP_TIMEOUT: workersMilliseconds(DEFAULT_WORKERS_OTLP_TIMEOUT_MS),
  /** A Worker secret; never a Wrangler `var`. */
  OTEL_EXPORTER_OTLP_HEADERS: headersSchema,
};

type WorkersTelemetryShape = typeof workersTelemetryEnvironmentShape;

export interface WorkersTelemetryConfig {
  readonly enabled: boolean;
  readonly resource: TelemetryResource;
  readonly logLevel: LogLevel;
  readonly otlp: {
    readonly protocol: OtlpProtocol;
    /** Bound of each OTLP request (one per signal per flush). */
    readonly timeoutMs: number;
    /** From the OTEL_EXPORTER_OTLP_HEADERS secret; empty when unset. */
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly traces: {
    readonly exporter: TelemetryExporter;
    readonly endpoint?: string;
    readonly samplerRatio: number;
  };
  readonly metrics: {
    readonly exporter: TelemetryExporter;
    readonly endpoint?: string;
  };
}

/** The typed Worker configuration from parsed variables. */
export function toWorkersTelemetryConfig(
  data: z.output<z.ZodObject<WorkersTelemetryShape>>,
): WorkersTelemetryConfig {
  const shared = toTelemetryConfig({
    ...data,
    OTEL_METRIC_EXPORT_INTERVAL: DEFAULT_METRIC_EXPORT_INTERVAL_MS,
    OTEL_METRIC_EXPORT_TIMEOUT: DEFAULT_METRIC_EXPORT_TIMEOUT_MS,
  });
  const headers =
    data.OTEL_EXPORTER_OTLP_HEADERS === undefined
      ? {}
      : (parseOtlpHeaders(data.OTEL_EXPORTER_OTLP_HEADERS) ?? {});
  return {
    enabled: shared.enabled,
    resource: shared.resource,
    logLevel: shared.logLevel,
    otlp: { ...shared.otlp, headers },
    traces: shared.traces,
    metrics: {
      exporter: shared.metrics.exporter,
      ...(shared.metrics.endpoint === undefined ? {} : { endpoint: shared.metrics.endpoint }),
    },
  };
}
