import {
  MAX_SUBMISSION_ATTEMPTS,
  type NewOrder,
  ORDER_NUMBER_PATTERN,
  type Order,
  SubmissionKeyTakenError,
  type SubmissionKey,
  type SubmissionStore,
  type SubmitOrderOutcome,
  TransientSubmissionError,
  createOrder,
  estimateOrder,
  orderRequestSchema,
  submissionKeySchema,
} from "@scos/core";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createPrismaClient } from "../src/prisma";
import { seedWarehouses, warehouseSeeds } from "../src/seed";
import { databaseErrorDetails } from "../src/submission-errors";
import { createPrismaSubmissionStore } from "../src/submission-store";
import { createMigratedDatabase, type MigratedDatabase } from "./support/database";
import {
  type Actor,
  countingStore,
  holdWarehouseLocks,
  installFailingTrigger,
  losAngeles,
  openActor,
  readOrderingState,
  resetOrdering,
  setStock,
  waitForLockWaiters,
  warehouseIds,
  withActors,
} from "./support/submission";

let db: MigratedDatabase;
/** The default application instance; tests open more for concurrency/restarts. */
let app: Actor;
const cleanups: (() => Promise<void>)[] = [];

const seededStock = Object.fromEntries(warehouseSeeds.map((seed) => [seed.id, seed.stock]));

function expectAccepted(outcome: SubmitOrderOutcome) {
  if (outcome.kind !== "accepted") {
    throw new Error(`expected an accepted outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

/** The stock after deducting an Order's allocations from `before`. */
function deducted(before: Readonly<Record<string, number>>, order: Order) {
  const after = { ...before };
  for (const { warehouseId, quantity } of order.allocations) {
    after[warehouseId] = (after[warehouseId] ?? 0) - quantity;
  }
  return after;
}

/** An Order as plain JSON, as an API response would carry it. */
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

async function expectNothingWritten(stockBefore: Readonly<Record<string, number>>) {
  const state = await readOrderingState(db.pool);
  expect(state.orders).toStrictEqual([]);
  expect(state.allocations).toStrictEqual([]);
  expect(state.stock).toStrictEqual(stockBefore);
}

describe("SubmitOrder with the Prisma submission store", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = await createMigratedDatabase();
    await seedWarehouses(db.pool);
    app = openActor(db.url);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await resetOrdering(db.pool);
  });

  afterEach(async () => {
    // Drop test triggers and release blockers even when a test failed.
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  describe("acceptance", () => {
    test("stores one numbered Order with its facts and allocations and deducts exactly the allocations", async () => {
      const input = { submissionId: "accept-1", quantity: 400, ...losAngeles };
      const { order, replayed } = expectAccepted(await app.submit(input));

      expect(replayed).toBe(false);
      expect(order.orderNumber).toMatch(ORDER_NUMBER_PATTERN);
      expect(order.submissionKey).toBe("accept-1");
      expect(order.quantity).toBe(400);
      expect(order.destination).toStrictEqual(losAngeles);
      // Nearest first: Los Angeles is exhausted, New York supplies the rest.
      expect(order.allocations).toStrictEqual([
        { warehouseId: warehouseIds.losAngeles, quantity: 355 },
        { warehouseId: warehouseIds.newYork, quantity: 45 },
      ]);

      // The amounts are the ones the domain computes against the seeded stock.
      const expected = estimateOrder(
        orderRequestSchema.parse({ quantity: 400, ...losAngeles }),
        warehouseSeeds.map(({ id, latitude, longitude, stock }) => ({
          warehouseId: id,
          latitude,
          longitude,
          available: stock,
        })),
      );
      if (!expected.valid) {
        throw new Error("the seeded inventory must accept this order");
      }
      expect(json(order)).toMatchObject({
        unitPrice: "150.00",
        merchandiseSubtotal: "60000.00",
        discountRate: "0.20",
        discountAmount: "12000.00",
        discountedMerchandiseTotal: "48000.00",
        shippingCost: expected.shippingCost.toString(),
        orderTotal: expected.orderTotal.toString(),
      });

      const state = await readOrderingState(db.pool);
      expect(state.orders).toHaveLength(1);
      expect(state.orders[0]).toMatchObject({
        id: order.id,
        orderNumber: order.orderNumber,
        submissionKey: "accept-1",
        quantity: 400,
        latitude: losAngeles.latitude,
        longitude: losAngeles.longitude,
        unitPrice: "150.00",
        discountRate: "0.20",
        discountAmount: "12000.00",
        shippingCost: order.shippingCost.toString(),
      });
      expect(
        state.allocations.map(({ orderId, warehouseId, quantity }) => ({
          orderId,
          warehouseId,
          quantity,
        })),
      ).toStrictEqual(
        order.allocations.map((allocation) => ({ orderId: order.id, ...allocation })),
      );
      expect(state.allocations.reduce((sum, row) => sum + row.quantity, 0)).toBe(400);
      expect(state.stock).toStrictEqual(deducted(seededStock, order));

      // The first response equals what a later repeat returns.
      const repeat = expectAccepted(await app.submit(input));
      expect(repeat.replayed).toBe(true);
      expect(repeat.order).toStrictEqual(order);
      expect(json(repeat.order)).toStrictEqual(json(order));
    });
  });

  describe("business rejection", () => {
    test("INSUFFICIENT_STOCK writes nothing and the same submissionId is accepted once stock arrives", async () => {
      await setStock(db.pool, { losAngeles: 5 });
      const before = await readOrderingState(db.pool);
      const input = { submissionId: "rejected-stock", quantity: 10, ...losAngeles };

      const rejected = await app.submit(input);
      expect(rejected).toMatchObject({ kind: "rejected", reason: "INSUFFICIENT_STOCK" });
      await expectNothingWritten(before.stock);
      expect((await readOrderingState(db.pool)).warehouseUpdatedAt).toStrictEqual(
        before.warehouseUpdatedAt,
      );
      // A rejection is not remembered: retrying it is evaluated again.
      expect(await app.submit(input)).toMatchObject({ kind: "rejected" });

      await setStock(db.pool, { losAngeles: 50 });
      const accepted = expectAccepted(await app.submit(input));
      expect(accepted.replayed).toBe(false);
      expect(accepted.order.submissionKey).toBe("rejected-stock");
      const state = await readOrderingState(db.pool);
      expect(state.orders).toHaveLength(1);
      expect(state.stock[warehouseIds.losAngeles]).toBe(40);
    });

    test("SHIPPING_EXCEEDS_LIMIT writes nothing and the same submissionId is accepted once nearer stock exists", async () => {
      // Only Hong Kong has stock; shipping it to Los Angeles exceeds 15%.
      await setStock(db.pool, { hongKong: 100 });
      const before = await readOrderingState(db.pool);
      const input = { submissionId: "rejected-shipping", quantity: 1, ...losAngeles };

      expect(await app.submit(input)).toMatchObject({
        kind: "rejected",
        reason: "SHIPPING_EXCEEDS_LIMIT",
      });
      await expectNothingWritten(before.stock);

      await setStock(db.pool, { hongKong: 100, losAngeles: 1 });
      const accepted = expectAccepted(await app.submit(input));
      expect(accepted.order.allocations).toStrictEqual([
        { warehouseId: warehouseIds.losAngeles, quantity: 1 },
      ]);
      const state = await readOrderingState(db.pool);
      expect(state.orders).toHaveLength(1);
      expect(state.stock[warehouseIds.losAngeles]).toBe(0);
      expect(state.stock[warehouseIds.hongKong]).toBe(100);
    });
  });

  describe("repeat of an accepted submission", () => {
    test("returns the original Order after stock changes and a restart, without deduction or timestamp changes", async () => {
      const input = { submissionId: "repeat-1", quantity: 100, ...losAngeles };
      const first = expectAccepted(await app.submit(input));

      // Another Order consumes stock, then Los Angeles is emptied entirely:
      // recalculating would now allocate differently or reject.
      expectAccepted(await app.submit({ submissionId: "other", quantity: 200, ...losAngeles }));
      await db.pool.query("UPDATE warehouses SET stock = 0 WHERE id = $1", [
        warehouseIds.losAngeles,
      ]);
      const before = await readOrderingState(db.pool);

      const repeat = expectAccepted(await app.submit(input));
      expect(repeat).toStrictEqual({ kind: "accepted", order: first.order, replayed: true });

      // Restart: a new pool, Prisma client, store and use case instance.
      await app.close();
      app = openActor(db.url);
      const afterRestart = expectAccepted(await app.submit(input));
      expect(afterRestart.replayed).toBe(true);
      expect(afterRestart.order).toStrictEqual(first.order);

      // Property order, number spelling and -0 do not make it a different request.
      const reordered = JSON.parse(
        `{"longitude": ${losAngeles.longitude}, "latitude": ${losAngeles.latitude}0, "quantity": 1.0e2, "submissionId": "repeat-1"}`,
      ) as unknown;
      expect(expectAccepted(await app.submit(reordered)).order).toStrictEqual(first.order);

      // Nothing was written by any repeat: rows, stock and timestamps are unchanged.
      expect(await readOrderingState(db.pool)).toStrictEqual(before);
    });

    test("treats -0 and 0 coordinates as the same request", async () => {
      const first = expectAccepted(
        await app.submit({ submissionId: "zero", quantity: 1, latitude: 0, longitude: -118.4 }),
      );
      const repeat = await app.submit(
        JSON.parse('{"latitude": -0, "longitude": -118.4, "submissionId": "zero", "quantity": 1}'),
      );
      expect(repeat).toStrictEqual({ kind: "accepted", order: first.order, replayed: true });
      expect((await readOrderingState(db.pool)).orders).toHaveLength(1);
    });

    test("a lost response after commit is recovered by retrying with the same submissionId", async () => {
      const input = { submissionId: "lost-response", quantity: 7, ...losAngeles };
      const lost = new Error("connection reset after commit (simulated lost response)");
      // The real transaction commits; then the response is lost on its way
      // back, so the caller only sees a non-transient failure.
      const actor = openActor(db.url, {
        wrapStore: (store) => ({
          findOrderBySubmissionKey: (key) => store.findOrderBySubmissionKey(key),
          async runInTransaction(work) {
            await store.runInTransaction(work);
            throw lost;
          },
        }),
      });
      cleanups.push(() => actor.close());

      await expect(actor.submit(input)).rejects.toBe(lost);
      const committed = await readOrderingState(db.pool);
      expect(committed.orders).toHaveLength(1);
      expect(committed.orders[0]).toMatchObject({ submissionKey: "lost-response", quantity: 7 });
      expect(committed.allocations).toHaveLength(1);
      expect(committed.allocations[0]).toMatchObject({
        orderId: committed.orders[0]?.id,
        warehouseId: warehouseIds.losAngeles,
        quantity: 7,
      });
      expect(committed.stock[warehouseIds.losAngeles]).toBe(
        seededStock[warehouseIds.losAngeles]! - 7,
      );

      // The client retries with the same submissionId on a healthy instance.
      const retry = expectAccepted(await app.submit(input));
      expect(retry.replayed).toBe(true);
      expect(retry.order.id).toBe(committed.orders[0]?.id);
      expect(retry.order.orderNumber).toBe(committed.orders[0]?.orderNumber);
      expect(retry.order.allocations).toStrictEqual([
        { warehouseId: warehouseIds.losAngeles, quantity: 7 },
      ]);
      expect(await app.store.findOrderBySubmissionKey(retry.order.submissionKey)).toStrictEqual(
        retry.order,
      );
      expect(await readOrderingState(db.pool)).toStrictEqual(committed);
    });
  });

  describe("changed input for an accepted submissionId", () => {
    test("different quantity or destination conflicts and leaves the Order and stock unchanged", async () => {
      const first = expectAccepted(
        await app.submit({ submissionId: "conflict-1", quantity: 10, ...losAngeles }),
      );
      const before = await readOrderingState(db.pool);

      expect(
        await app.submit({ submissionId: "conflict-1", quantity: 11, ...losAngeles }),
      ).toStrictEqual({ kind: "conflict", submissionKey: "conflict-1" });
      expect(
        await app.submit({
          submissionId: "conflict-1",
          quantity: 10,
          latitude: losAngeles.latitude,
          longitude: losAngeles.longitude + 0.000001,
        }),
      ).toStrictEqual({ kind: "conflict", submissionKey: "conflict-1" });

      expect(await readOrderingState(db.pool)).toStrictEqual(before);
      expect(
        expectAccepted(
          await app.submit({ submissionId: "conflict-1", quantity: 10, ...losAngeles }),
        ).order,
      ).toStrictEqual(first.order);
    });
  });

  describe("concurrency across separate connections", () => {
    const actorCount = 6;

    test("concurrent identical submissions create one Order and one deduction and all return it", async () => {
      const counters: ReturnType<typeof countingStore>[] = [];
      const counted = () => ({
        wrapStore: (store: SubmissionStore) => {
          const counter = countingStore(store);
          counters.push(counter);
          return counter.store;
        },
      });
      await withActors(
        db.url,
        actorCount,
        async (actors) => {
          const blocker = await holdWarehouseLocks(db.url);
          cleanups.push(() => blocker.release());
          const input = { submissionId: "same-everywhere", quantity: 30, ...losAngeles };

          const outcomes = Promise.all(actors.map((actor) => actor.submit(input)));
          // Every actor passed its unlocked lookup and now queues on the locks.
          await waitForLockWaiters(db.pool, actorCount);
          await blocker.release();
          const results = (await outcomes).map(expectAccepted);

          expect(results.filter((result) => !result.replayed)).toHaveLength(1);
          expect(results.filter((result) => result.replayed)).toHaveLength(actorCount - 1);
          const [order] = results.map((result) => result.order);
          for (const result of results) {
            expect(result.order).toStrictEqual(order);
          }
          const state = await readOrderingState(db.pool);
          expect(state.orders).toHaveLength(1);
          expect(state.allocations).toHaveLength(1);
          expect(state.stock).toStrictEqual(deducted(seededStock, order!));

          // Every waiting actor resolved through the authoritative locked
          // lookup in one transaction; none needed the unique-index backstop.
          const attempts = counters.flatMap((counter) => counter.attempts);
          expect(attempts).toHaveLength(actorCount);
          expect(
            attempts.filter((attempt) => attempt instanceof SubmissionKeyTakenError),
          ).toStrictEqual([]);
          expect(attempts.every((attempt) => attempt === "resolved")).toBe(true);
        },
        counted,
      );
    });

    test("concurrent different submissions for scarce stock never oversell", async () => {
      await setStock(db.pool, { losAngeles: 25 });
      await withActors(db.url, actorCount, async (actors) => {
        const blocker = await holdWarehouseLocks(db.url);
        cleanups.push(() => blocker.release());

        const outcomes = Promise.all(
          actors.map((actor, index) =>
            actor.submit({ submissionId: `scarce-${index}`, quantity: 10, ...losAngeles }),
          ),
        );
        await waitForLockWaiters(db.pool, actorCount);
        await blocker.release();
        const results = await outcomes;

        const accepted = results.filter((result) => result.kind === "accepted");
        const rejected = results.filter((result) => result.kind === "rejected");
        expect(accepted).toHaveLength(2);
        expect(rejected).toHaveLength(actorCount - 2);
        for (const result of rejected) {
          expect(result).toMatchObject({ reason: "INSUFFICIENT_STOCK" });
        }

        const state = await readOrderingState(db.pool);
        expect(state.orders).toHaveLength(2);
        const allocated = state.allocations.reduce((sum, row) => sum + row.quantity, 0);
        expect(allocated).toBe(20);
        expect(allocated).toBeLessThanOrEqual(25);
        expect(state.stock[warehouseIds.losAngeles]).toBe(5);
        expect(Object.values(state.stock).every((stock) => stock >= 0)).toBe(true);
      });
    });

    test("concurrent reuse of one submissionId with changed inputs accepts one and conflicts the rest", async () => {
      await withActors(db.url, actorCount, async (actors) => {
        const blocker = await holdWarehouseLocks(db.url);
        cleanups.push(() => blocker.release());

        const outcomes = Promise.all(
          actors.map((actor, index) =>
            actor.submit({ submissionId: "contested", quantity: index + 1, ...losAngeles }),
          ),
        );
        await waitForLockWaiters(db.pool, actorCount);
        await blocker.release();
        const results = await outcomes;

        const accepted = results.filter((result) => result.kind === "accepted");
        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatchObject({ replayed: false });
        expect(results.filter((result) => result.kind === "conflict")).toHaveLength(actorCount - 1);

        const state = await readOrderingState(db.pool);
        expect(state.orders).toHaveLength(1);
        const order = expectAccepted(accepted[0]!).order;
        expect(state.stock).toStrictEqual(deducted(seededStock, order));
      });
    });
  });

  describe("unique submission_key backstop", () => {
    /**
     * Skips both lookups once, as if a concurrent submission committed the
     * Order between the locked lookup and the insert.
     */
    function blindStore(actor: Actor) {
      const counted = countingStore({
        findOrderBySubmissionKey: (key) => actor.store.findOrderBySubmissionKey(key),
        runInTransaction: (work) =>
          actor.store.runInTransaction((tx) =>
            work({
              lockInventory: () => tx.lockInventory(),
              findOrderBySubmissionKey: async () => null,
              saveAcceptedOrder: (order) => tx.saveAcceptedOrder(order),
            }),
          ),
      });
      let skipUnlockedLookup = true;
      return {
        attempts: counted.attempts,
        store: {
          ...counted.store,
          findOrderBySubmissionKey: async (key: SubmissionKey) => {
            if (skipUnlockedLookup) {
              skipUnlockedLookup = false;
              return null;
            }
            return counted.store.findOrderBySubmissionKey(key);
          },
        },
      };
    }

    test("a unique violation on submission_key resolves as a repeat or a conflict, never a server error", async () => {
      const input = { submissionId: "backstop", quantity: 3, ...losAngeles };
      const winner = expectAccepted(await app.submit(input));
      const before = await readOrderingState(db.pool);

      for (const [request, expected] of [
        [input, { kind: "accepted", order: winner.order, replayed: true }],
        [
          { ...input, quantity: 4 },
          { kind: "conflict", submissionKey: "backstop" },
        ],
      ] as const) {
        const blind = blindStore(app);
        const actor = openActor(db.url, { wrapStore: () => blind.store });
        try {
          expect(await actor.submit(request)).toStrictEqual(expected);
        } finally {
          await actor.close();
        }
        expect(blind.attempts).toHaveLength(1);
        expect(blind.attempts[0]).toBeInstanceOf(SubmissionKeyTakenError);
        expect(databaseErrorDetails((blind.attempts[0] as Error).cause)).toStrictEqual({
          sqlState: "23505",
          constraint: "orders_submission_key_key",
        });
      }

      expect(await readOrderingState(db.pool)).toStrictEqual(before);
    });

    test("an order_number collision is retried with a new number", async () => {
      const existing = expectAccepted(
        await app.submit({ submissionId: "numbered", quantity: 1, ...losAngeles }),
      );
      const numbers = [existing.order.orderNumber, "SO-0000000000ZZ"];
      let counted: ReturnType<typeof countingStore> | undefined;
      const actor = openActor(db.url, {
        wrapStore: (store) => (counted = countingStore(store)).store,
        useCase: { generateOrderNumber: () => numbers.shift()! },
      });
      try {
        const outcome = expectAccepted(
          await actor.submit({ submissionId: "collides", quantity: 2, ...losAngeles }),
        );
        expect(outcome.order.orderNumber).toBe("SO-0000000000ZZ");
      } finally {
        await actor.close();
      }
      expect(counted!.attempts).toHaveLength(2);
      expect(counted!.attempts[0]).toBeInstanceOf(TransientSubmissionError);
      expect(counted!.attempts[1]).toBe("resolved");
      const state = await readOrderingState(db.pool);
      expect(state.orders).toHaveLength(2);
      expect(state.stock[warehouseIds.losAngeles]).toBe(seededStock[warehouseIds.losAngeles]! - 3);
    });
  });

  describe("rollback of failures before commit", () => {
    const stages = [
      { label: "before inserting the Order", timing: "BEFORE", event: "INSERT", table: "orders" },
      {
        label: "after inserting the allocations",
        timing: "AFTER",
        event: "INSERT",
        table: "order_allocations",
      },
      {
        label: "before deducting stock",
        timing: "BEFORE",
        event: "UPDATE",
        table: "warehouses",
      },
      {
        label: "at commit (deferred constraint trigger)",
        timing: "AFTER",
        event: "INSERT",
        table: "orders",
        deferred: true,
      },
    ] as const;

    for (const [index, stage] of stages.entries()) {
      test(`a failure ${stage.label} rolls back the Order, allocations and stock`, async () => {
        const drop = await installFailingTrigger(db.pool, {
          name: `scos_test_fail_${index}`,
          timing: stage.timing,
          event: stage.event,
          table: stage.table,
          deferred: "deferred" in stage,
        });
        cleanups.push(drop);
        let counted: ReturnType<typeof countingStore> | undefined;
        const actor = openActor(db.url, {
          wrapStore: (store) => (counted = countingStore(store)).store,
        });
        cleanups.push(() => actor.close());
        const input = { submissionId: `rollback-${index}`, quantity: 400, ...losAngeles };

        const error: unknown = await actor.submit(input).then(
          (outcome) => expect.fail(`expected the injected failure, got ${JSON.stringify(outcome)}`),
          (reason: unknown) => reason,
        );
        // Not transient: propagated unchanged after exactly one attempt.
        expect(error).not.toBeInstanceOf(TransientSubmissionError);
        expect(String(error)).toMatch(new RegExp(`injected failure scos_test_fail_${index}`));
        expect(counted!.attempts).toStrictEqual([error]);
        await expectNothingWritten(seededStock);

        await drop();
        const accepted = expectAccepted(await actor.submit(input));
        expect(accepted.replayed).toBe(false);
        const state = await readOrderingState(db.pool);
        expect(state.orders).toHaveLength(1);
        expect(state.stock).toStrictEqual(deducted(seededStock, accepted.order));
      });
    }
  });

  describe("bounded retry of transient failures", () => {
    test("lock timeouts on every attempt end as unavailable after 3 attempts, leaving the submissionId reusable", async () => {
      const blocker = await holdWarehouseLocks(db.url);
      cleanups.push(() => blocker.release());
      let counted: ReturnType<typeof countingStore> | undefined;
      const actor = openActor(db.url, {
        store: { lockTimeoutMs: 200, timeoutMs: 5_000 },
        wrapStore: (store) => (counted = countingStore(store)).store,
      });
      cleanups.push(() => actor.close());
      const input = { submissionId: "unavailable-lock", quantity: 5, ...losAngeles };

      expect(await actor.submit(input)).toStrictEqual({
        kind: "unavailable",
        attempts: MAX_SUBMISSION_ATTEMPTS,
      });
      expect(MAX_SUBMISSION_ATTEMPTS).toBe(3);
      expect(counted!.attempts).toHaveLength(3);
      for (const attempt of counted!.attempts) {
        expect(attempt).toBeInstanceOf(TransientSubmissionError);
        expect(databaseErrorDetails((attempt as Error).cause)?.sqlState).toBe("55P03");
      }
      await blocker.release();
      await expectNothingWritten(seededStock);

      const accepted = expectAccepted(await actor.submit(input));
      expect(accepted.replayed).toBe(false);
      expect((await readOrderingState(db.pool)).orders).toHaveLength(1);
    });

    test("serialization failures (40001) on every attempt end as unavailable after 3 attempts", async () => {
      const drop = await installFailingTrigger(db.pool, {
        name: "scos_test_serialization",
        timing: "BEFORE",
        event: "INSERT",
        table: "orders",
        sqlState: "40001",
      });
      cleanups.push(drop);
      let counted: ReturnType<typeof countingStore> | undefined;
      const actor = openActor(db.url, {
        wrapStore: (store) => (counted = countingStore(store)).store,
      });
      cleanups.push(() => actor.close());
      const input = { submissionId: "unavailable-40001", quantity: 5, ...losAngeles };

      expect(await actor.submit(input)).toStrictEqual({ kind: "unavailable", attempts: 3 });
      expect(counted!.attempts).toHaveLength(3);
      expect(counted!.attempts.every((error) => error instanceof TransientSubmissionError)).toBe(
        true,
      );
      await expectNothingWritten(seededStock);

      await drop();
      expect(expectAccepted(await actor.submit(input)).replayed).toBe(false);
    });

    test("a transient failure on the first attempt only succeeds on the second", async () => {
      await db.pool.query("CREATE SEQUENCE scos_test_attempts");
      cleanups.push(async () => {
        await db.pool.query("DROP SEQUENCE IF EXISTS scos_test_attempts");
      });
      // nextval is not rolled back, so only the first insert fails.
      const drop = await installFailingTrigger(db.pool, {
        name: "scos_test_first_attempt",
        timing: "BEFORE",
        event: "INSERT",
        table: "orders",
        sqlState: "40P01",
        when: "nextval('scos_test_attempts') = 1",
      });
      cleanups.push(drop);
      let counted: ReturnType<typeof countingStore> | undefined;
      const actor = openActor(db.url, {
        wrapStore: (store) => (counted = countingStore(store)).store,
      });
      cleanups.push(() => actor.close());

      const accepted = expectAccepted(
        await actor.submit({ submissionId: "second-time", quantity: 5, ...losAngeles }),
      );
      expect(accepted.replayed).toBe(false);
      expect(counted!.attempts).toHaveLength(2);
      expect(counted!.attempts[0]).toBeInstanceOf(TransientSubmissionError);
      expect(counted!.attempts[1]).toBe("resolved");
      const state = await readOrderingState(db.pool);
      expect(state.orders).toHaveLength(1);
      expect(state.stock).toStrictEqual(deducted(seededStock, accepted.order));
    });
  });

  describe("cross-row invariants the schema does not enforce", () => {
    function newOrderFor(quantity: number): NewOrder {
      const estimate = estimateOrder(orderRequestSchema.parse({ quantity, ...losAngeles }), [
        {
          warehouseId: warehouseIds.losAngeles,
          ...losAngeles,
          available: 1_000,
        },
      ]);
      return createOrder({
        orderNumber: "SO-0000000000AA",
        submissionKey: submissionKeySchema.parse(`direct-${quantity}`),
        estimate,
      });
    }

    async function saveDirectly(order: NewOrder) {
      return app.store.runInTransaction(async (tx) => {
        await tx.lockInventory();
        return tx.saveAcceptedOrder(order);
      });
    }

    test("allocations that do not sum to the quantity are refused and roll back", async () => {
      const valid = newOrderFor(10);
      const short = {
        ...valid,
        allocations: [{ warehouseId: warehouseIds.losAngeles, quantity: 9 }],
      } as NewOrder;

      await expect(saveDirectly(short)).rejects.toThrow(/Allocations sum to 9/);
      await expectNothingWritten(seededStock);
    });

    test("an allocation above the warehouse's stock is refused and rolls back the Order", async () => {
      await setStock(db.pool, { losAngeles: 5 });
      const before = await readOrderingState(db.pool);

      const error: unknown = await saveDirectly(newOrderFor(10)).then(
        () => expect.fail("expected the stock guard to refuse the allocation"),
        (reason: unknown) => reason,
      );
      expect(String(error)).toMatch(/exceeds its stock/);
      expect(error).not.toBeInstanceOf(TransientSubmissionError);
      await expectNothingWritten(before.stock);
    });

    test("the transaction refuses to save before the warehouse rows are locked", async () => {
      await expect(
        app.store.runInTransaction((tx) => tx.saveAcceptedOrder(newOrderFor(1))),
      ).rejects.toThrow(/lockInventory\(\) first/);
      await expectNothingWritten(seededStock);
    });
  });

  describe("input validation", () => {
    test("a submissionId containing NUL is invalid before any database call and writes nothing", async () => {
      let counted: ReturnType<typeof countingStore> | undefined;
      const actor = openActor(db.url, {
        wrapStore: (store) => (counted = countingStore(store)).store,
      });
      cleanups.push(() => actor.close());

      const outcome = await actor.submit({ submissionId: "key\u0000", quantity: 1, ...losAngeles });
      expect(outcome).toMatchObject({ kind: "invalid", issues: [{ path: ["submissionId"] }] });
      expect(counted!.attempts).toStrictEqual([]);
      await expectNothingWritten(seededStock);
    });
  });

  describe("Prisma transaction start timeout", () => {
    test("no connection within maxWait is classified as transient and runs no work", async () => {
      // One connection, held elsewhere: Prisma cannot start the transaction.
      const pool = new Pool({ connectionString: db.url, max: 1 });
      const prisma = createPrismaClient(pool);
      const held = await pool.connect();
      let released = false;
      try {
        const store = createPrismaSubmissionStore(prisma, { maxWaitMs: 100 });
        let ran = false;
        const error: unknown = await store
          .runInTransaction(async () => {
            ran = true;
          })
          .then(
            () => expect.fail("expected the transaction start to time out"),
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(TransientSubmissionError);
        expect((error as Error).cause).toMatchObject({
          code: "P2028",
          message: expect.stringMatching(/Unable to start a transaction in the given time\.$/),
        });
        held.release();
        released = true;
        // Once the connection is free again, the same store works and the
        // timed-out attempt never ran its work.
        await expect(store.runInTransaction(async () => "started")).resolves.toBe("started");
        expect(ran).toBe(false);
      } finally {
        if (!released) {
          held.release();
        }
        await prisma.$disconnect();
        await pool.end();
      }
    });
  });

  describe("accepted facts", () => {
    test("a repeat returns the stored amounts, not a recalculation under current rules", async () => {
      const input = { submissionId: "historical", quantity: 400, ...losAngeles };
      const first = expectAccepted(await app.submit(input));

      // A later commercial change: the stored price and shipping now differ
      // from what the current rules would compute for this request.
      await db.pool.query(
        `UPDATE orders SET unit_price = 149.99, shipping_cost = shipping_cost + 1.23
         WHERE submission_key = 'historical'`,
      );
      const stored = (await readOrderingState(db.pool)).orders[0]!;

      const repeat = expectAccepted(await app.submit(input));
      expect(repeat.replayed).toBe(true);
      expect(repeat.order.id).toBe(first.order.id);
      expect(json(repeat.order)).toMatchObject({
        unitPrice: "149.99",
        merchandiseSubtotal: "59996.00",
        discountRate: "0.20",
        discountAmount: "12000.00",
        discountedMerchandiseTotal: "47996.00",
        shippingCost: stored.shippingCost,
      });
      expect(repeat.order.shippingCost.toString()).not.toBe(first.order.shippingCost.toString());
      expect(repeat.order.orderTotal.toString()).toBe(
        repeat.order.discountedMerchandiseTotal.plus(repeat.order.shippingCost).toString(),
      );
    });
  });
});
