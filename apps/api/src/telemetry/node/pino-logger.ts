/**
 * The Node.js/Lambda logger adapter: Pino JSON on stdout, one record per
 * call, following the runtime-neutral log record contract
 * (`telemetry/log-record.ts`) for platform or OpenTelemetry Collector
 * ingestion (docs/observability.md).
 *
 * Pino is deliberately loaded with Node's own `require` (never a static
 * import) the first time a logger is created. That keeps it out of the
 * esbuild bundle and loads it after `PinoInstrumentation` has been
 * registered (`telemetry/node/sdk.ts`), so the instrumentation patches it and
 * adds `trace_id`, `span_id` and `trace_flags` to records written inside a
 * valid active span.
 *
 * @module
 */

import { createRequire } from "node:module";

import type * as Pino from "pino";

import type { LogDetails, StructuredLogger } from "../../http/logger";
import {
  type LogLevelName,
  OTEL_SEVERITY_NUMBERS,
  REDACTION_CENSOR,
  REDACT_PATHS,
  sanitizeDetails,
} from "../log-record";

type PinoModule = typeof import("pino");

let pinoModule: PinoModule | undefined;

/**
 * Loads Pino through Node's CommonJS loader, which OpenTelemetry's
 * require-in-the-middle hook patches. Cached after the first call.
 */
export function loadPino(): PinoModule {
  pinoModule ??= createRequire(import.meta.url)("pino") as PinoModule;
  return pinoModule;
}

export interface PinoLoggerOptions {
  readonly level?: Pino.LevelWithSilent;
  /**
   * Fields on every record. Runtimes pass the resource attributes
   * (`service.name`, `service.version`, `deployment.environment.name`).
   */
  readonly base?: LogDetails;
  /** Where records go; synchronous stdout by default. Tests pass a capture stream. */
  readonly destination?: Pino.DestinationStream;
}

function wrap(pino: Pino.Logger): StructuredLogger {
  return {
    trace: (message, details) => pino.trace(sanitizeDetails(details), message),
    debug: (message, details) => pino.debug(sanitizeDetails(details), message),
    info: (message, details) => pino.info(sanitizeDetails(details), message),
    warn: (message, details) => pino.warn(sanitizeDetails(details), message),
    error: (message, details) => pino.error(sanitizeDetails(details), message),
    fatal: (message, details) => pino.fatal(sanitizeDetails(details), message),
    child: (bindings) => wrap(pino.child(sanitizeDetails(bindings))),
  };
}

/**
 * A Pino-backed logger writing one JSON line per call:
 * `{"level":"info","severity_number":9,"time":"<ISO 8601>", ...base,
 * [trace_id, span_id, trace_flags], ...details, "msg":"..."}`. The trace
 * fields come from PinoInstrumentation when it is registered.
 */
export function createPinoLogger(options: PinoLoggerOptions = {}): StructuredLogger {
  const pino = loadPino();
  const settings: Pino.LoggerOptions = {
    level: options.level ?? "info",
    base: { ...options.base },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({
        level: label,
        severity_number: OTEL_SEVERITY_NUMBERS[label as LogLevelName] ?? 0,
      }),
    },
    redact: { paths: [...REDACT_PATHS], censor: REDACTION_CENSOR },
  };
  const destination = options.destination ?? pino.destination({ fd: 1, sync: true });
  return wrap(pino(settings, destination));
}
