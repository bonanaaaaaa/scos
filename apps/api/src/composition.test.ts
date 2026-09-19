import { afterEach, describe, expect, test, vi } from "vitest";

import { SUBMIT_ORDER_MESSAGES } from "./endpoints/submit-order/messages";
import { MESSAGES } from "./http/messages";
import { startBlackHole } from "./testing/black-hole.test-support";
import {
  factorySpies,
  flush,
  unreachableDatabaseUrl as unreachable,
} from "./testing/persistence-spies.test-support";

// Spy on the adapter factories while keeping their real behaviour.
vi.mock("@scos/persistence", async (importOriginal) =>
  (await import("./testing/persistence-spies.test-support")).spyOnFactories(await importOriginal()),
);

const persistence = await import("@scos/persistence");
const { composeApplication } = await import("./composition");
const { DEFAULT_CONNECTION_TIMEOUT_MS, databasePoolTimeouts } = await import("./database");
const { calls, watchNextPool } = factorySpies(persistence);
const databaseUrl = unreachable;

afterEach(() => {
  vi.clearAllMocks();
});

describe("the combined composition", () => {
  test("combined: one pool shared by both adapters", async () => {
    const composed = composeApplication({ databaseUrl });
    try {
      expect(calls()).toStrictEqual({ pool: 1, prisma: 1, inventoryReader: 1, submissionStore: 1 });
      expect((await composed.app.request("/health")).status).toBe(200);
    } finally {
      await composed.close();
    }
  });

  test("a construction failure ends the pool it opened and rethrows", async () => {
    const endOf = watchNextPool();
    expect(() => composeApplication({ databaseUrl, maxSubmissionAttempts: 0 })).toThrow();
    await flush();
    expect(endOf()).toHaveBeenCalledOnce();
  });
});

describe("composeApplication", () => {
  test("builds without connecting; /health answers while the database is unreachable", async () => {
    const decorate = vi.fn((store) => store);
    const composed = composeApplication({
      databaseUrl: unreachable,
      decorateSubmissionStore: decorate,
      maxSubmissionAttempts: 2,
      submissionStore: { lockTimeoutMs: 100, timeoutMs: 200 },
    });
    try {
      expect(decorate).toHaveBeenCalledOnce();
      const response = await composed.app.request("/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({ status: "ok" });
    } finally {
      await composed.close();
      await composed.close();
    }
  });

  test("database failures surface as 500 through the injected logger", async () => {
    const logger = { error: vi.fn() };
    const composed = composeApplication({ databaseUrl: unreachable, logger });
    try {
      const response = await composed.app.request("/api/v1/orders/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: 1, latitude: 0, longitude: 0 }),
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret");
      expect(logger.error).toHaveBeenCalledOnce();
    } finally {
      await composed.close();
    }
  });

  test("rejects invalid submission settings at construction", () => {
    expect(() =>
      composeApplication({ databaseUrl: unreachable, submissionStore: { timeoutMs: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      composeApplication({ databaseUrl: unreachable, maxSubmissionAttempts: 0 }),
    ).toThrow(RangeError);
  });
});

describe("database timeouts", () => {
  test("the pool bounds connecting only, and rejects a limit pg would treat as unbounded", () => {
    expect(databasePoolTimeouts()).toStrictEqual({
      connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    });
    expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(databasePoolTimeouts(250)).toStrictEqual({ connectionTimeoutMillis: 250 });
    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => databasePoolTimeouts(invalid), String(invalid)).toThrow(RangeError);
      expect(() =>
        composeApplication({ databaseUrl: unreachable, connectionTimeoutMs: invalid }),
      ).toThrow(RangeError);
    }
  });

  test("a database that accepts TCP but never answers fails requests instead of hanging", async () => {
    const blackHole = await startBlackHole();
    const logger = { error: vi.fn() };
    const composed = composeApplication({
      databaseUrl: `postgresql://scos:secret@127.0.0.1:${blackHole.port}/scos`,
      connectionTimeoutMs: 300,
      logger,
    });
    const post = (path: string, body: unknown) =>
      Promise.resolve(
        composed.app.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    try {
      const started = Date.now();
      const [verify, submit] = await Promise.all([
        post("/api/v1/orders/verify", { quantity: 1, latitude: 0, longitude: 0 }),
        post("/api/v1/orders", { submissionId: "hole-1", quantity: 1, latitude: 0, longitude: 0 }),
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);

      expect(verify.status).toBe(500);
      expect(await verify.json()).toStrictEqual({
        error: { code: "INTERNAL_ERROR", message: MESSAGES.internal },
      });
      expect(submit.status).toBe(503);
      expect(submit.headers.get("retry-after")).toBe("1");
      expect(await submit.json()).toStrictEqual({
        error: { code: "SERVICE_UNAVAILABLE", message: SUBMIT_ORDER_MESSAGES.unavailable },
      });
      // Only the verification failure is unexpected; `unavailable` is an outcome.
      expect(logger.error).toHaveBeenCalledOnce();
    } finally {
      const closing = Date.now();
      await composed.close();
      expect(Date.now() - closing).toBeLessThan(5_000);
      await blackHole.close();
    }
  });
});
