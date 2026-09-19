import { describe, expect, test, vi } from "vitest";

import { MESSAGES } from "./app";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  composeApplication,
  databasePoolTimeouts,
} from "./composition";
import { startBlackHole } from "./testing/black-hole.test-support";

// Nothing listens on port 1, and building the composition must not connect.
const unreachable = "postgresql://scos:secret@127.0.0.1:1/scos";

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
      const response = await composed.app.request("/orders/verify", {
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
        post("/orders/verify", { quantity: 1, latitude: 0, longitude: 0 }),
        post("/orders", { submissionId: "hole-1", quantity: 1, latitude: 0, longitude: 0 }),
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);

      expect(verify.status).toBe(500);
      expect(await verify.json()).toStrictEqual({
        error: { code: "INTERNAL_ERROR", message: MESSAGES.internal },
      });
      expect(submit.status).toBe(503);
      expect(submit.headers.get("retry-after")).toBe("1");
      expect(await submit.json()).toStrictEqual({
        error: { code: "SERVICE_UNAVAILABLE", message: MESSAGES.unavailable },
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
