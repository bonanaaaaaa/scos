import { afterEach, describe, expect, test, vi } from "vitest";

import {
  factorySpies,
  flush,
  unreachableDatabaseUrl as databaseUrl,
} from "../../testing/persistence-spies.test-support";

// Spy on the adapter factories while keeping their real behaviour.
vi.mock("@scos/persistence", async (importOriginal) =>
  (await import("../../testing/persistence-spies.test-support")).spyOnFactories(
    await importOriginal(),
  ),
);

const persistence = await import("@scos/persistence");
const { composeVerifyOrderApplication } = await import("./composition");
const { spies, calls, watchNextPool } = factorySpies(persistence);

afterEach(() => {
  vi.clearAllMocks();
});

describe("composeVerifyOrderApplication builds only what verification needs", () => {
  test("verify: pool, Prisma and inventory reader; never a submission store", async () => {
    const composed = composeVerifyOrderApplication({ databaseUrl, connectionTimeoutMs: 250 });
    try {
      expect(calls()).toStrictEqual({ pool: 1, prisma: 1, inventoryReader: 1, submissionStore: 0 });
      expect(spies.pool).toHaveBeenCalledWith(databaseUrl, { connectionTimeoutMillis: 250 });
      expect((await composed.app.request("/health")).status).toBe(404);
      expect((await composed.app.request("/api/v1/orders", { method: "POST" })).status).toBe(404);
    } finally {
      await composed.close();
      await composed.close();
    }
  });

  test("a construction failure ends the pool it opened and rethrows", async () => {
    const endOf = watchNextPool();
    spies.inventoryReader.mockImplementationOnce(() => {
      throw new Error("reader failed");
    });
    expect(() => composeVerifyOrderApplication({ databaseUrl })).toThrow();
    await flush();
    expect(endOf()).toHaveBeenCalledOnce();
  });
});
