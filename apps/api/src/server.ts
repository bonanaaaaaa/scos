/**
 * Local Node.js runtime entrypoint.
 *
 * Validates the environment first; on failure it prints only variable names
 * and safe reasons to stderr and exits nonzero without building a database
 * client or opening the listener. Otherwise it composes the app, listens, and
 * shuts down gracefully on SIGINT/SIGTERM (close the listener, disconnect
 * Prisma, end the pool).
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
  readonly log: (message: string) => void;
  readonly logError: (message: string, error?: unknown) => void;
  readonly exit: (code: number) => void;
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
}

export const nodeRuntime: ServerRuntime = {
  serve: (options, onListening) => serve(options, onListening),
  compose: composeApplication,
  log: (message) => console.log(message),
  logError: (message, error) => {
    if (error === undefined) {
      console.error(message);
    } else {
      console.error(message, error);
    }
  },
  exit: (code) => process.exit(code),
  onSignal: (signal, handler) => {
    process.once(signal, handler);
  },
};

export interface RunningServer {
  readonly config: ServerConfig;
  shutdown(): Promise<void>;
}

/** Composes the app over the configured database and starts listening. */
export function startServer(
  config: ServerConfig,
  runtime: Pick<ServerRuntime, "serve" | "compose" | "log">,
): RunningServer {
  const composed = runtime.compose({ databaseUrl: config.databaseUrl });
  const server = runtime.serve({ fetch: composed.app.fetch, port: config.port }, (serverInfo) => {
    runtime.log(`SCOS API listening on http://localhost:${serverInfo.port}`);
  });

  let shuttingDown: Promise<void> | undefined;
  return {
    config,
    shutdown() {
      shuttingDown ??= (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          });
        } finally {
          await composed.close();
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
        runtime.logError("SCOS API shutdown failed.", error);
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
