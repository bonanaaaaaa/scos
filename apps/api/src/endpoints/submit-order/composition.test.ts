import { afterEach, describe, expect, test, vi } from "vitest";

import {
  factorySpies,
  flush,
  unreachableDatabaseUrl as databaseUrl,
} from "#testing/persistence-spies.test-support";

// Spy on the adapter factories while keeping their real behaviour.
vi.mock("@scos/persistence", async (importOriginal) =>
  (await import("#testing/persistence-spies.test-support")).spyOnFactories(await importOriginal()),
);

const persistence = await import("@scos/persistence");
const { composeSubmitOrderApplication } = await import("#endpoints/submit-order/composition");
const { spies, calls, watchNextPool } = factorySpies(persistence);

afterEach(() => {
  vi.clearAllMocks();
});

describe("composeSubmitOrderApplication builds only what submission needs", () => {
  test("submit: pool, Prisma and submission store with its options; never an inventory reader", async () => {
    const decorate = vi.fn((store) => store);
    const options = { lockTimeoutMs: 100, timeoutMs: 200 };
    const composed = composeSubmitOrderApplication({
      databaseUrl,
      submissionStore: options,
      decorateSubmissionStore: decorate,
      maxSubmissionAttempts: 2,
    });
    try {
      expect(calls()).toStrictEqual({ pool: 1, prisma: 1, inventoryReader: 0, submissionStore: 1 });
      expect(spies.submissionStore.mock.calls[0]?.[1]).toBe(options);
      expect(decorate).toHaveBeenCalledOnce();
      expect((await composed.app.request("/health")).status).toBe(404);
      expect((await composed.app.request("/api/v1/orders/verify", { method: "POST" })).status).toBe(
        404,
      );
    } finally {
      await composed.close();
    }
  });

  test("a construction failure ends the pool it opened and rethrows", async () => {
    const endOf = watchNextPool();
    expect(() =>
      composeSubmitOrderApplication({ databaseUrl, maxSubmissionAttempts: 0 }),
    ).toThrow();
    await flush();
    expect(endOf()).toHaveBeenCalledOnce();
  });
});
