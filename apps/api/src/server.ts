/**
 * Local Node.js runtime entrypoint.
 *
 * Validates the environment first; on failure it prints only variable names
 * and safe reasons to stderr and exits nonzero without building a database
 * client, starting telemetry or opening the listener. Otherwise it starts
 * telemetry (before any logger exists, so Pino is instrumented), composes the
 * app, listens, and shuts down gracefully on SIGINT/SIGTERM: close the
 * listener, disconnect Prisma and end the pool, then flush and stop the
 * telemetry providers within a bounded time.
 *
 * @module
 */

import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";

import {
  type ComposedApplication,
  type CompositionOptions,
  composeApplication,
} from "./composition";
import { type ServerConfig, parseConfig } from "./config";
import type { StructuredLogger } from "./http/logger";
import type { TelemetryConfig } from "./telemetry/config";
import { type TelemetryRuntime, startTelemetry } from "./telemetry/node/sdk";

/** Upper bound for flushing telemetry during shutdown. */
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5_000;

interface ServerInfo {
  readonly port: number;
}

interface ClosableServer {
  close(callback?: (error?: Error) => void): unknown;
}

type ServeApplication = (
  options: { fetch: ComposedApplication["app"]["fetch"]; port: number },
  onListening: (serverInfo: ServerInfo) => void,
) => ClosableServer;

export interface ServerRuntime {
  readonly serve: ServeApplication;
  readonly compose: (options: CompositionOptions) => ComposedApplication;
  readonly startTelemetry: (config: TelemetryConfig) => TelemetryRuntime;
  /** Configuration errors only: printed before any logger exists. */
  readonly logError: (message: string) => void;
  readonly exit: (code: number) => void;
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
}

export const nodeRuntime: ServerRuntime = {
  serve: (options, onListening) => serve(options, onListening),
  compose: composeApplication,
  startTelemetry: (config) => startTelemetry(config),
  logError: (message) => console.error(message),
  exit: (code) => process.exit(code),
  onSignal: (signal, handler) => {
    process.once(signal, handler);
  },
};

export interface RunningServer {
  readonly config: ServerConfig;
  readonly logger: StructuredLogger;
  shutdown(): Promise<void>;
}

/**
 * Starts telemetry, composes the app over the configured database and starts
 * listening.
 */
export function startServer(
  config: ServerConfig,
  runtime: Pick<ServerRuntime, "serve" | "compose" | "startTelemetry">,
): RunningServer {
  const observability = runtime.startTelemetry(config.telemetry);
  const { logger, telemetry } = observability;
  const composed = runtime.compose({ databaseUrl: config.databaseUrl, logger, telemetry });
  const server = runtime.serve({ fetch: composed.app.fetch, port: config.port }, (serverInfo) => {
    logger.info(`SCOS API listening on http://localhost:${serverInfo.port}`, {
      "server.port": serverInfo.port,
    });
  });

  let shuttingDown: Promise<void> | undefined;
  return {
    config,
    logger,
    shutdown() {
      shuttingDown ??= (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          });
        } finally {
          try {
            await composed.close();
          } finally {
            // Last, so spans of requests that finished during close are exported.
            await observability.shutdown(TELEMETRY_SHUTDOWN_TIMEOUT_MS);
          }
        }
      })();
      return shuttingDown;
    },
  };
}

/**
 * Validates configuration, then starts the server and registers graceful
 * shutdown. Returns `undefined` (after requesting exit code 1) when the
 * configuration is invalid.
 */
export function main(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  runtime: ServerRuntime = nodeRuntime,
): RunningServer | undefined {
  const result = parseConfig(environment);
  if (!result.success) {
    runtime.logError("SCOS API not started: invalid configuration.");
    for (const problem of result.errors) {
      runtime.logError(`  ${problem}`);
    }
    runtime.exit(1);
    return undefined;
  }

  const running = startServer(result.config, runtime);
  const stop = () => {
    running.shutdown().then(
      () => runtime.exit(0),
      (error: unknown) => {
        running.logger.error("SCOS API shutdown failed.", { error });
        runtime.exit(1);
      },
    );
  };
  runtime.onSignal("SIGINT", stop);
  runtime.onSignal("SIGTERM", stop);
  return running;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
