/**
 * The Worker's `fetch` handler inside workerd: configuration validated once
 * per isolate (sanitized, nothing served when invalid), the Hyperdrive
 * binding as DATABASE_URL, the telemetry flush handed to `ctx.waitUntil`
 * after the response and never awaited, and concurrent requests keeping
 * their own trace context. Database-backed behaviour runs against
 * PostgreSQL in test/workers/*.workers.integration.test.ts.
 */

import type { ExecutionContext } from "hono";
import { describe, expect, test, vi } from "vitest";

import { composeWorkerApplication } from "#composition/worker";
import { MESSAGES } from "#http/messages";
import { UNREACHABLE_DATABASE_URL } from "#testing/workers-telemetry.test-support";
import { createWorkersTelemetry } from "#telemetry/workers/sdk";
import handler, {
  type WorkerEnv,
  type WorkerRuntime,
  createWorkerHandler,
  workerEnvironment,
  workersRuntime,
} from "#entrypoints/worker";

const HYPERDRIVE = { connectionString: UNREACHABLE_DATABASE_URL };

/** An ExecutionContext that records what is handed to `waitUntil`. */
function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil: (promise) => void pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  };
  return { ctx, pending, settle: () => Promise.allSettled(pending) };
}

function runtimeWith(
  overrides: { fetch?: typeof fetch; lines?: string[] } = {},
): WorkerRuntime & { readonly errors: string[]; readonly compose: ReturnType<typeof vi.fn> } {
  const errors: string[] = [];
  const lines = overrides.lines ?? [];
  return {
    errors,
    createTelemetry: (config) =>
      createWorkersTelemetry(config, {
        write: (line) => lines.push(line),
        ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
      }),
    compose: vi.fn(composeWorkerApplication),
    logError: (message) => void errors.push(message),
  };
}

const request = (path: string, init?: RequestInit) =>
  new Request(`http://worker.test${path}`, init);

describe("configuration", () => {
  test("invalid: nothing is served, sanitized errors are logged once per isolate", async () => {
    const runtime = runtimeWith();
    const worker = createWorkerHandler(runtime);
    const env: WorkerEnv = {
      HYPERDRIVE: { connectionString: "mysql://u:hyperdrive-secret@h/d" },
      LOG_LEVEL: "loud",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:endpoint-secret@collector.test",
      OTEL_EXPORTER_OTLP_HEADERS: "not a header list",
    };
    for (let index = 0; index < 2; index += 1) {
      const { ctx } = executionContext();
      const response = await worker.fetch(request("/health"), env, ctx);
      expect(response.status).toBe(500);
      expect(await response.json()).toStrictEqual({
        error: { code: "INTERNAL_ERROR", message: MESSAGES.internal },
      });
    }
    expect(runtime.compose).not.toHaveBeenCalled();
    expect(runtime.errors).toStrictEqual([
      "SCOS API not started: invalid configuration.",
      "  HYPERDRIVE (binding connectionString): must be a postgres:// or postgresql:// URL with a host",
      "  LOG_LEVEL: must be one of trace, debug, info, warn, error, fatal, silent",
      "  OTEL_EXPORTER_OTLP_HEADERS: must be comma-separated name=value pairs with URL-encoded values",
      "  OTEL_EXPORTER_OTLP_ENDPOINT: must be an http:// or https:// URL with a host and no credentials",
    ]);
    expect(runtime.errors.join("\n")).not.toMatch(/secret|loud|not a header/);
  });

  test("a missing Hyperdrive binding is reported by name", async () => {
    const runtime = runtimeWith();
    const { ctx } = executionContext();
    const response = await createWorkerHandler(runtime).fetch(request("/health"), {}, ctx);
    expect(response.status).toBe(500);
    expect(runtime.errors).toContain("  HYPERDRIVE (binding connectionString): is required");
  });

  test("an initialization failure is logged by class name only", async () => {
    const runtime: WorkerRuntime & { errors: string[] } = {
      ...runtimeWith(),
      errors: [],
      compose: () => {
        throw new RangeError("postgresql://u:init-secret@h/d");
      },
      logError(message) {
        this.errors.push(message);
      },
    };
    const { ctx } = executionContext();
    const response = await createWorkerHandler(runtime).fetch(
      request("/health"),
      { HYPERDRIVE },
      ctx,
    );
    expect(response.status).toBe(500);
    expect(runtime.errors).toStrictEqual([
      "SCOS API not started: initialization failed (RangeError).",
    ]);
  });

  test("the environment: string variables only, DATABASE_URL from the binding alone", () => {
    expect(
      workerEnvironment({
        HYPERDRIVE,
        DATABASE_URL: "postgresql://ignored@elsewhere/db",
        LOG_LEVEL: "debug",
        JSON_VAR: { nested: true },
      }),
    ).toStrictEqual({
      HYPERDRIVE: undefined,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      LOG_LEVEL: "debug",
      JSON_VAR: undefined,
    });
    expect(workerEnvironment({ DATABASE_URL: "postgresql://u@h/d" }).DATABASE_URL).toBeUndefined();
  });

  test("the module's default export is a handler over the Workers runtime", () => {
    expect(handler.fetch).toBeTypeOf("function");
    expect(workersRuntime.compose).toBe(composeWorkerApplication);
  });
});

describe("serving", () => {
  test("validated once: the composition is built on the first request and reused", async () => {
    const runtime = runtimeWith();
    const worker = createWorkerHandler(runtime);
    for (let index = 0; index < 3; index += 1) {
      const { ctx, settle } = executionContext();
      expect((await worker.fetch(request("/health"), { HYPERDRIVE }, ctx)).status).toBe(200);
      await settle();
    }
    expect(runtime.compose).toHaveBeenCalledOnce();
    expect(runtime.compose.mock.calls[0]?.[0]).toMatchObject({
      databaseUrl: UNREACHABLE_DATABASE_URL,
    });
  });

  test("the flush goes to ctx.waitUntil and is not awaited: a hanging collector does not delay the response", async () => {
    let calls = 0;
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    }) as typeof fetch;
    const lines: string[] = [];
    const worker = createWorkerHandler(runtimeWith({ fetch: hanging, lines }));
    const env: WorkerEnv = {
      HYPERDRIVE,
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test:4318",
      OTEL_EXPORTER_OTLP_TIMEOUT: "300",
    };
    const baseline = await composeWorkerApplication({
      databaseUrl: UNREACHABLE_DATABASE_URL,
    }).app.request("/health");
    const { ctx, pending, settle } = executionContext();
    let flushed = false;

    const response = await worker.fetch(request("/health"), env, ctx);
    expect(response.status).toBe(baseline.status);
    expect(await response.text()).toBe(await baseline.text());
    expect(pending.length, "the flush was handed to waitUntil").toBeGreaterThanOrEqual(1);
    void Promise.allSettled(pending).then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed, "the response was returned before the flush settled").toBe(false);

    await settle();
    expect(calls).toBe(2);
    expect(lines.filter((line) => line.includes("OpenTelemetry export failed"))).toHaveLength(2);
  });

  test("a request that fails inside the app still returns its response and schedules the flush", async () => {
    const worker = createWorkerHandler(runtimeWith());
    const { ctx, pending, settle } = executionContext();
    const response = await worker.fetch(
      request("/api/v1/orders/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantity: 1, latitude: 0, longitude: 0 }),
      }),
      { HYPERDRIVE, LOG_LEVEL: "silent" },
      ctx,
    );
    expect(response.status).toBe(500);
    // The flush, and the request's database close.
    expect(pending).toHaveLength(2);
    await settle();
  });

  test("concurrent requests in one isolate keep their own trace context", async () => {
    const lines: string[] = [];
    const worker = createWorkerHandler(runtimeWith({ lines }));
    const traceIds = Array.from(
      { length: 12 },
      (_, index) => `${index.toString(16).padStart(2, "0")}${"ab".repeat(15)}`,
    );
    const responses = await Promise.all(
      traceIds.map((traceId, index) => {
        const { ctx } = executionContext();
        return worker.fetch(
          request(index % 2 === 0 ? "/health" : "/nope", {
            headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
          }),
          { HYPERDRIVE },
          ctx,
        );
      }),
    );
    expect(responses.map((response) => response.status)).toStrictEqual(
      traceIds.map((_, index) => (index % 2 === 0 ? 200 : 404)),
    );
    const logged = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.msg === "request completed")
      .map((record) => [record.trace_id, record["url.path"]]);
    expect(logged).toHaveLength(traceIds.length);
    expect(new Set(logged.map(([traceId]) => traceId))).toStrictEqual(new Set(traceIds));
    for (const [traceId, path] of logged) {
      const index = traceIds.indexOf(String(traceId));
      expect(path).toBe(index % 2 === 0 ? "/health" : "/nope");
    }
  });
});
