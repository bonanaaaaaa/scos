/**
 * Cloudflare Workers entrypoint (`wrangler.jsonc` `main`).
 *
 * Once per isolate, on its first request: validate the environment (Wrangler
 * `vars`, secrets, and the Hyperdrive binding's connection string as
 * DATABASE_URL), then build telemetry and the composition. If the
 * configuration is invalid, no request is served: each gets the standard
 * `500 INTERNAL_ERROR` envelope, and the sanitized `NAME: reason` lines are
 * logged once (never a value).
 *
 * Per request: the composed app answers, and only then is the telemetry flush
 * handed to `ctx.waitUntil`. The flush is never awaited on the response path,
 * so an unreachable or slow collector cannot delay or change a response, and
 * it runs after the request's database work has finished, so it never holds a
 * transaction or a lock.
 *
 * @module
 */

import type { ExecutionContext } from "hono";

import type { ComposedApplication } from "#composition/composed-application";
import { type WorkerCompositionOptions, composeWorkerApplication } from "#composition/worker";
import { type Environment, type WorkerConfig, parseWorkerConfig } from "#config";
import { errorBody } from "#http/errors";
import { MESSAGES } from "#http/messages";
import type { WorkersTelemetryConfig } from "#telemetry/config";
import { type WorkersTelemetryRuntime, createWorkersTelemetry } from "#telemetry/workers/sdk";

/** The Hyperdrive binding: only its connection string is used. */
export interface HyperdriveBinding {
  readonly connectionString: string;
}

/** The bindings and variables the Worker reads (`wrangler.jsonc`, secrets). */
export interface WorkerEnv {
  readonly HYPERDRIVE?: HyperdriveBinding;
  readonly [name: string]: unknown;
}

/** The Workers `ExecutionContext`, as Hono types it. */
export type WorkerExecutionContext = ExecutionContext;

export interface WorkerRuntime {
  readonly createTelemetry: (config: WorkersTelemetryConfig) => WorkersTelemetryRuntime;
  readonly compose: (options: WorkerCompositionOptions) => ComposedApplication;
  /** Configuration errors only: written before any logger exists. */
  readonly logError: (message: string) => void;
}

export const workersRuntime: WorkerRuntime = {
  createTelemetry: (config) => createWorkersTelemetry(config),
  compose: composeWorkerApplication,
  // oxlint-disable-next-line no-console -- the console is the Worker's log sink.
  logError: (message) => console.error(message),
};

/**
 * The environment as the configuration parser sees it: string variables, and
 * DATABASE_URL from the Hyperdrive binding (never from a variable of that
 * name). Non-string values (bindings, JSON `vars`) are passed as `undefined`
 * for the variables the schema declares, so they fail validation.
 */
export function workerEnvironment(env: WorkerEnv): Environment {
  const variables: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    variables[name] = typeof value === "string" ? value : undefined;
  }
  const connectionString = env.HYPERDRIVE?.connectionString;
  variables.DATABASE_URL = typeof connectionString === "string" ? connectionString : undefined;
  return variables;
}

/** Validation messages name DATABASE_URL; say where it comes from on Workers. */
function describeProblem(problem: string): string {
  return problem.startsWith("DATABASE_URL:")
    ? `HYPERDRIVE (binding connectionString):${problem.slice("DATABASE_URL:".length)}`
    : problem;
}

interface Serving {
  readonly ok: true;
  readonly config: WorkerConfig;
  readonly observability: WorkersTelemetryRuntime;
  readonly composed: ComposedApplication;
}

type Isolate = Serving | { readonly ok: false };

function unavailable(): Response {
  return Response.json(errorBody("INTERNAL_ERROR", MESSAGES.internal), { status: 500 });
}

export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response>;
}

/** A `fetch` handler that initializes once per isolate (a test seam for the runtime). */
export function createWorkerHandler(runtime: WorkerRuntime = workersRuntime): WorkerHandler {
  let isolate: Isolate | undefined;

  const initialize = (env: WorkerEnv): Isolate => {
    try {
      return start(env);
    } catch (error) {
      // Only the class name: messages can carry connection details.
      runtime.logError(
        `SCOS API not started: initialization failed (${error instanceof Error ? error.name : "unknown error"}).`,
      );
      return { ok: false };
    }
  };

  const start = (env: WorkerEnv): Isolate => {
    const result = parseWorkerConfig(workerEnvironment(env));
    if (!result.success) {
      runtime.logError("SCOS API not started: invalid configuration.");
      for (const problem of result.errors) {
        runtime.logError(`  ${describeProblem(problem)}`);
      }
      return { ok: false };
    }
    const observability = runtime.createTelemetry(result.config.telemetry);
    const composed = runtime.compose({
      databaseUrl: result.config.databaseUrl,
      logger: observability.logger,
      telemetry: observability.telemetry,
    });
    return { ok: true, config: result.config, observability, composed };
  };

  return {
    async fetch(request, env, ctx) {
      isolate ??= initialize(env);
      if (!isolate.ok) {
        return unavailable();
      }
      const { composed, observability } = isolate;
      try {
        return await composed.app.fetch(request, env, ctx);
      } finally {
        // After the response exists; bounded, never rejects.
        ctx.waitUntil(observability.flush());
      }
    },
  };
}

export default createWorkerHandler();
