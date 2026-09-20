import { MAX_SUBMISSION_ATTEMPTS } from "@scos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { SUBMIT_ORDER_MESSAGES } from "#endpoints/submit-order/messages";
import { errorResponseSchema, orderResponseSchema } from "#index";
import {
  AT_PARIS,
  Applications,
  type FailureStage,
  type FailureSwitches,
  PARIS,
  failureInjector,
  postJson,
  snapshot,
} from "#test/support/app";
import {
  type TestDatabase,
  createTestDatabase,
  holdWarehouseLocks,
  readState,
  stockById,
} from "#test/support/database";

let db: TestDatabase;
const applications = new Applications();

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.reset();
});

afterEach(async () => {
  await applications.closeAll();
});

function composeWith(switches: FailureSwitches, options = {}) {
  return applications.compose(db.url, {
    decorateSubmissionStore: failureInjector(switches),
    ...options,
  });
}

describe("failure injected before commit", () => {
  test.each<FailureStage>([
    "afterLockInventory",
    "afterFindOrderBySubmissionKey",
    "afterSaveAcceptedOrder",
  ])("%s rolls back the Order, allocations and stock; the ID stays reusable", async (stage) => {
    const switches: FailureSwitches = { failAt: stage, attempts: 0 };
    const composed = composeWith(switches);
    const body = { submissionId: `fail-${stage}`, quantity: 25, ...AT_PARIS };
    const before = await readState(db.pool);

    const failed = await snapshot(postJson(composed, "/api/v1/orders", body));

    expect(failed.status).toBe(500);
    expect(errorResponseSchema.strict().parse(failed.json())).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: SUBMIT_ORDER_MESSAGES.internal },
    });
    expect(failed.text).not.toContain("Injected");
    // A thrown (non-transient) failure is not retried by the use case.
    expect(switches.attempts).toBe(1);
    // Rolled back: no Order or allocation, no stock change, no row rewritten.
    expect(await readState(db.pool)).toStrictEqual(before);

    const retried = await snapshot(postJson(composed, "/api/v1/orders", body));
    expect(retried.status, retried.text).toBe(201);
    const stock = await stockById(db.pool);
    expect(stock[PARIS]).toBe((before.warehouses.find((row) => row.id === PARIS)?.stock ?? 0) - 25);
    expect((await readState(db.pool)).orders).toHaveLength(1);
  });
});

describe("submission_key unique violation", () => {
  async function acceptOriginal() {
    const switches: FailureSwitches = { attempts: 0 };
    const composed = composeWith(switches);
    const body = { submissionId: "unique-1", quantity: 30, ...AT_PARIS };
    const first = await snapshot(postJson(composed, "/api/v1/orders", body));
    expect(first.status, first.text).toBe(201);
    // From now on both lookups miss the stored Order, so the next attempt
    // reaches INSERT and hits orders_submission_key_key; only the lookup made
    // to resolve that violation sees the Order.
    switches.hideFromUnlockedLookups = 1;
    switches.hideFromLockedLookups = true;
    return { composed, switches, body, first, before: await readState(db.pool) };
  }

  test("with the same input resolves as a 201 repeat of the original Order", async () => {
    const { composed, switches, body, first, before } = await acceptOriginal();

    const repeat = await snapshot(postJson(composed, "/api/v1/orders", body));

    expect(repeat.status, repeat.text).toBe(201);
    expect(repeat.text).toBe(first.text);
    expect(switches.hideFromUnlockedLookups).toBe(0);
    expect(switches.attempts).toBe(2);
    expect(await readState(db.pool)).toStrictEqual(before);
  });

  test("with changed input resolves as a 409 conflict", async () => {
    const { composed, body, before } = await acceptOriginal();

    const conflict = await snapshot(
      postJson(composed, "/api/v1/orders", { ...body, quantity: 31 }),
    );

    expect(conflict.status, conflict.text).toBe(409);
    expect(errorResponseSchema.parse(conflict.json()).error.code).toBe("SUBMISSION_ID_CONFLICT");
    expect(await readState(db.pool)).toStrictEqual(before);
  });
});

describe("transient failures", () => {
  test("a real lock_timeout on every attempt stops at the retry bound with 503; the ID stays reusable", async () => {
    const switches: FailureSwitches = { attempts: 0 };
    const composed = composeWith(switches, {
      submissionStore: { lockTimeoutMs: 150, timeoutMs: 5_000, maxWaitMs: 5_000 },
    });
    const body = { submissionId: "transient-1", quantity: 10, ...AT_PARIS };
    const before = await readState(db.pool);

    const locks = await holdWarehouseLocks(db.url);
    let unavailable;
    try {
      unavailable = await snapshot(postJson(composed, "/api/v1/orders", body));
    } finally {
      await locks.release();
    }

    expect(unavailable.status, unavailable.text).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("1");
    expect(errorResponseSchema.strict().parse(unavailable.json())).toStrictEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: SUBMIT_ORDER_MESSAGES.unavailable },
    });
    expect(switches.attempts).toBe(MAX_SUBMISSION_ATTEMPTS);
    expect(await readState(db.pool)).toStrictEqual(before);

    const retried = await snapshot(postJson(composed, "/api/v1/orders", body));
    expect(retried.status, retried.text).toBe(201);
    expect(switches.attempts).toBe(MAX_SUBMISSION_ATTEMPTS + 1);
  });
});

describe("lost response after commit", () => {
  test("retrying with the same submissionId returns the committed Order with one deduction", async () => {
    const switches: FailureSwitches = { failAt: "afterCommit", attempts: 0 };
    const composed = composeWith(switches);
    const body = { submissionId: "lost-1", quantity: 40, ...AT_PARIS };
    const stockBefore = await stockById(db.pool);

    const lost = await snapshot(postJson(composed, "/api/v1/orders", body));

    // The client never learns the outcome, and the response does not claim one.
    expect(lost.status).toBe(500);
    expect(lost.text).not.toContain("SO-");
    const committed = await readState(db.pool);
    expect(committed.orders).toHaveLength(1);

    const retried = await snapshot(postJson(composed, "/api/v1/orders", body));

    expect(retried.status, retried.text).toBe(201);
    const order = orderResponseSchema.parse(retried.json());
    expect(order.orderNumber).toBe(committed.orders[0]?.order_number);
    expect(await readState(db.pool)).toStrictEqual(committed);
    expect(await stockById(db.pool)).toStrictEqual({
      ...stockBefore,
      [PARIS]: (stockBefore[PARIS] ?? 0) - 40,
    });
  });
});
