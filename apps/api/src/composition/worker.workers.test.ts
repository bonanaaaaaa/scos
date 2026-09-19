/**
 * The Worker composition inside workerd, without a database: every route of
 * `createApp` (the three endpoints and the documentation), a per-request
 * database that is only opened when a use case runs and is closed under
 * `ctx.waitUntil`, and the same failure mapping as Node. Real queries through
 * Hyperdrive run in test/workers/*.workers.integration.test.ts.
 */

import type { ExecutionContext } from "hono";
import { describe, expect, test, vi } from "vitest";

import { MESSAGES } from "../http/messages";
import { post } from "../testing/fixtures.test-support";
import { UNREACHABLE_DATABASE_URL } from "../testing/workers-telemetry.test-support";
import { WORKER_REQUEST_MAX_CONNECTIONS, composeWorkerApplication } from "./worker";

function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil: (promise) => void pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  };
  return { ctx, pending };
}

const verify = (
  app: {
    fetch: (request: Request, env: unknown, ctx: ExecutionContext) => Response | Promise<Response>;
  },
  ctx: ExecutionContext,
) =>
  app.fetch(
    new Request("http://worker.test/api/v1/orders/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 1, latitude: 0, longitude: 0 }),
    }),
    {},
    ctx,
  );

describe("composeWorkerApplication", () => {
  test("serves health, the OpenAPI document and the docs without opening a database", async () => {
    const { app, close } = composeWorkerApplication({ databaseUrl: UNREACHABLE_DATABASE_URL });
    const { ctx, pending } = executionContext();
    const health = await app.fetch(new Request("http://worker.test/health"), {}, ctx);
    expect(health.status).toBe(200);
    expect(await health.json()).toStrictEqual({ status: "ok" });
    const document = await app.request("/openapi.json");
    expect(document.status).toBe(200);
    expect(Object.keys(((await document.json()) as { paths: object }).paths)).toStrictEqual([
      "/health",
      "/api/v1/orders/verify",
      "/api/v1/orders",
    ]);
    expect((await app.request("/docs")).status).toBe(200);
    expect((await app.request("/nope")).status).toBe(404);
    // The request's database scope closes, having opened nothing.
    await Promise.all(pending);
    await close();
    await close();
  });

  test("a database failure is a 500 through the logger, and the request's pool is closed via waitUntil", async () => {
    const logger = { error: vi.fn() };
    const { app } = composeWorkerApplication({
      databaseUrl: UNREACHABLE_DATABASE_URL,
      logger,
      connectionTimeoutMs: 1_000,
    });
    const { ctx, pending } = executionContext();
    const response = await verify(app, ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: MESSAGES.internal },
    });
    expect(logger.error).toHaveBeenCalledOnce();
    const logged = logger.error.mock.calls[0]?.[1] as { error: Error };
    // A real connection attempt over cloudflare:sockets, not a missing driver.
    expect(logged.error).toBeInstanceOf(Error);
    expect(logged.error).not.toBeInstanceOf(TypeError);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret-password");
    expect(pending).toHaveLength(1);
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  test("a submission that cannot reach the database is not accepted", async () => {
    const { app } = composeWorkerApplication({
      databaseUrl: UNREACHABLE_DATABASE_URL,
      logger: { error: vi.fn() },
      connectionTimeoutMs: 1_000,
    });
    const response = await post(app, "/api/v1/orders", {
      submissionId: "worker-1",
      quantity: 1,
      latitude: 0,
      longitude: 0,
    });
    expect([500, 503]).toContain(response.status);
  });

  test("invalid input never reaches the database", async () => {
    const { app } = composeWorkerApplication({ databaseUrl: UNREACHABLE_DATABASE_URL });
    const response = await post(app, "/api/v1/orders", { quantity: "1" });
    expect(response.status).toBe(400);
  });

  test("rejects a connection timeout pg would treat as unbounded", () => {
    expect(() =>
      composeWorkerApplication({ databaseUrl: UNREACHABLE_DATABASE_URL, connectionTimeoutMs: 0 }),
    ).toThrow(RangeError);
    expect(WORKER_REQUEST_MAX_CONNECTIONS).toBeLessThan(6);
  });
});
