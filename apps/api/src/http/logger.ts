/**
 * The logging port shared by every app, composition and telemetry adapter.
 * Runtime-neutral: nothing here imports Pino, Node.js modules or an
 * OpenTelemetry SDK.
 *
 * Apps depend only on {@link Logger}, so their construction stays pure and
 * tests inject fakes. The Node/Lambda runtime injects the Pino adapter
 * (`telemetry/node/pino-logger.ts`). When nothing is injected, apps fall back
 * to {@link defaultLogger}, a console JSON logger that writes the same record
 * shape (`telemetry/log-record.ts`).
 *
 * @module
 */

import {
  LEVEL_VALUES,
  type LogLevelName,
  OTEL_SEVERITY_NUMBERS,
  correlationFields,
  redact,
  sanitizeDetails,
} from "../telemetry/log-record";

export type LogDetails = Readonly<Record<string, unknown>>;

/** What the apps need: the sink for unexpected errors. Never sent to clients. */
export interface Logger {
  error(message: string, details: LogDetails): void;
}

/** The full structured logger runtimes and telemetry use. */
export interface StructuredLogger extends Logger {
  trace(message: string, details?: LogDetails): void;
  debug(message: string, details?: LogDetails): void;
  info(message: string, details?: LogDetails): void;
  warn(message: string, details?: LogDetails): void;
  error(message: string, details?: LogDetails): void;
  fatal(message: string, details?: LogDetails): void;
  /** A logger whose records all carry `bindings`; still trace-correlated. */
  child(bindings: LogDetails): StructuredLogger;
}

export interface ConsoleJsonLoggerOptions {
  readonly level?: LogLevelName | "silent";
  /** Fields on every record, such as the resource attributes. */
  readonly base?: LogDetails;
  /** Receives one JSON line (without newline) per record; `console.log` by default. */
  readonly write?: (line: string) => void;
}

const LEVELS: readonly LogLevelName[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/**
 * A logger with no runtime dependency: one `JSON.stringify` line per call,
 * with the fields, severity mapping, redaction and trace correlation of the
 * log record contract (`telemetry/log-record.ts`).
 */
export function createConsoleJsonLogger(options: ConsoleJsonLoggerOptions = {}): StructuredLogger {
  const threshold = LEVEL_VALUES[options.level ?? "info"];
  // oxlint-disable-next-line no-console -- the console is this adapter's sink.
  const write = options.write ?? ((line: string) => console.log(line));

  const build = (bindings: Record<string, unknown>): StructuredLogger => {
    const at =
      (level: LogLevelName) =>
      (message: string, details?: LogDetails): void => {
        if (LEVEL_VALUES[level] < threshold) {
          return;
        }
        const record = {
          level,
          severity_number: OTEL_SEVERITY_NUMBERS[level],
          time: new Date().toISOString(),
          ...bindings,
          ...correlationFields(),
          ...redact(sanitizeDetails(details)),
          msg: message,
        };
        write(JSON.stringify(record));
      };
    const logger = Object.fromEntries(LEVELS.map((level) => [level, at(level)])) as Omit<
      StructuredLogger,
      "child"
    >;
    return {
      ...logger,
      child: (childBindings) => build({ ...bindings, ...redact(sanitizeDetails(childBindings)) }),
    };
  };

  return build(redact({ ...options.base }));
}

/**
 * The logger apps use when none is injected: the console JSON logger at
 * `info`, without resource fields. Runtimes inject their own.
 */
export const defaultLogger: StructuredLogger = createConsoleJsonLogger();
