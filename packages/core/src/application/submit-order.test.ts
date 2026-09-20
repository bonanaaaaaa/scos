import { describe, expect, test } from "vitest";

import {
  type SubmissionStore,
  type SubmissionTransaction,
  SubmissionKeyTakenError,
  TransientSubmissionError,
} from "#application/ports/submission-store";
import { type NewOrder, type Order, restoreOrder } from "#domain/ordering/order";
import { ORDER_NUMBER_PATTERN } from "#domain/ordering/order-number";
import type { SubmissionKey } from "#domain/ordering/submission-key";
import { DomainError } from "#domain/shared/errors";
import type { WarehouseStock } from "#domain/shipping/allocation";

import {
  MAX_SUBMISSION_ATTEMPTS,
  type SubmitOrderOutcome,
  createSubmitOrder,
} from "./submit-order";

/**
 * In-memory SubmissionStore. A transaction works on a copy of the state and
 * commits it only when the work resolves, like a real rollback. `beforeSave`
 * hooks run one per save call and may throw to inject failures.
 */
class FakeSubmissionStore implements SubmissionStore {
  warehouses: WarehouseStock[];
  orders: Order[] = [];
  readonly calls: string[] = [];
  readonly beforeSave: Array<(store: FakeSubmissionStore) => void> = [];
  #nextId = 1;

  constructor(warehouses: readonly WarehouseStock[]) {
    this.warehouses = warehouses.map((warehouse) => ({ ...warehouse }));
  }

  async findOrderBySubmissionKey(key: SubmissionKey): Promise<Order | null> {
    this.calls.push("find");
    return this.orders.find((order) => order.submissionKey === key) ?? null;
  }

  async runInTransaction<T>(work: (tx: SubmissionTransaction) => Promise<T>): Promise<T> {
    this.calls.push("begin");
    const warehouses = this.warehouses.map((warehouse) => ({ ...warehouse }));
    const orders = [...this.orders];
    const tx: SubmissionTransaction = {
      lockInventory: async () => {
        this.calls.push("lock");
        return Object.freeze(warehouses.map((warehouse) => Object.freeze({ ...warehouse })));
      },
      findOrderBySubmissionKey: async (key) => {
        this.calls.push("tx.find");
        return orders.find((order) => order.submissionKey === key) ?? null;
      },
      saveAcceptedOrder: async (order) => {
        this.calls.push("save");
        this.beforeSave.shift()?.(this);
        return this.#save(order, warehouses, orders);
      },
    };
    const result = await work(tx);
    this.warehouses = warehouses;
    this.orders = orders;
    this.calls.push("commit");
    return result;
  }

  /** What the adapter does: enforce cross-row invariants, write, and reread. */
  #save(order: NewOrder, warehouses: WarehouseStock[], orders: Order[]): Order {
    if (orders.some((existing) => existing.submissionKey === order.submissionKey)) {
      throw new SubmissionKeyTakenError("duplicate submission_key");
    }
    const allocated = order.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
    if (allocated !== order.quantity) throw new Error("allocations must sum to quantity");
    for (const allocation of order.allocations) {
      const index = warehouses.findIndex((w) => w.warehouseId === allocation.warehouseId);
      const warehouse = warehouses[index];
      if (warehouse === undefined || warehouse.available < allocation.quantity) {
        throw new Error("allocation exceeds stock");
      }
      warehouses[index] = { ...warehouse, available: warehouse.available - allocation.quantity };
    }
    const stored = restoreOrder({
      id: `order-${this.#nextId++}`,
      orderNumber: order.orderNumber,
      submissionKey: order.submissionKey,
      quantity: order.quantity,
      destination: { latitude: order.destination.latitude, longitude: order.destination.longitude },
      unitPrice: order.unitPrice.toString(),
      discountRate: order.discountRate,
      discountAmount: order.discountAmount.toString(),
      shippingCost: order.shippingCost.toString(),
      allocations: order.allocations.map(({ warehouseId, quantity }) => ({
        warehouseId,
        quantity,
      })),
    });
    orders.push(stored);
    return stored;
  }

  stock(): Record<string, number> {
    return Object.fromEntries(this.warehouses.map((w) => [w.warehouseId, w.available]));
  }
}

const INVENTORY: readonly WarehouseStock[] = [
  { warehouseId: "a", latitude: 0, longitude: 1, available: 20 },
  { warehouseId: "b", latitude: 0, longitude: 2, available: 20 },
];

const input = (overrides: Record<string, unknown> = {}) => ({
  submissionId: "key-1",
  quantity: 30,
  latitude: 0,
  longitude: 0,
  ...overrides,
});

/** Money and frozen objects as plain JSON, so amounts compare by value. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const setup = (inventory: readonly WarehouseStock[] = INVENTORY) => {
  const store = new FakeSubmissionStore(inventory);
  let generated = 0;
  const submitOrder = createSubmitOrder({
    store,
    generateOrderNumber: () => `SO-00000000000${++generated}`,
  });
  return { store, submitOrder };
};

function acceptedOrder(outcome: SubmitOrderOutcome): Order {
  if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
  return outcome.order;
}

const transient = () => {
  throw new TransientSubmissionError("serialization failure");
};

describe("SubmitOrder validation", () => {
  test("reports every malformed field with its path before calling the store", async () => {
    const { store, submitOrder } = setup();
    const outcome = await submitOrder({
      submissionId: " padded",
      quantity: 0,
      latitude: 91,
      longitude: "0",
    });
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") return;
    expect(outcome.issues.map(({ path, code }) => ({ path, code }))).toStrictEqual([
      { path: ["submissionId"], code: "custom" },
      { path: ["quantity"], code: "too_small" },
      { path: ["latitude"], code: "too_big" },
      { path: ["longitude"], code: "invalid_type" },
    ]);
    expect(store.calls).toStrictEqual([]);
  });

  test.each([
    ["a missing submissionId", { submissionId: undefined }, ["submissionId"]],
    ["a blank submissionId", { submissionId: "" }, ["submissionId"]],
    ["a 256-character submissionId", { submissionId: "x".repeat(256) }, ["submissionId"]],
    ["a submissionId containing NUL", { submissionId: "key\u0000" }, ["submissionId"]],
    ["a submissionId with a lone surrogate", { submissionId: "key\ud800" }, ["submissionId"]],
    ["a fractional quantity", { quantity: 1.5 }, ["quantity"]],
  ])("rejects %s without calling the store", async (_label, overrides, path) => {
    const { store, submitOrder } = setup();
    const outcome = await submitOrder(input(overrides));
    expect(outcome).toMatchObject({ kind: "invalid", issues: [{ path }] });
    expect(store.calls).toStrictEqual([]);
  });

  test("rejects non-object input", async () => {
    const { store, submitOrder } = setup();
    expect(await submitOrder(null)).toMatchObject({ kind: "invalid", issues: [{ path: [] }] });
    expect(store.calls).toStrictEqual([]);
  });

  test("rejects an invalid maxAttempts at creation", () => {
    const store = new FakeSubmissionStore(INVENTORY);
    for (const maxAttempts of [0, -1, 1.5, Number.NaN]) {
      expect(() => createSubmitOrder({ store, maxAttempts })).toThrow(RangeError);
    }
  });
});

describe("SubmitOrder acceptance", () => {
  test("saves one Order, deducts stock nearest-first and returns the persisted Order", async () => {
    const { store, submitOrder } = setup();
    const outcome = await submitOrder(input());
    expect(outcome).toMatchObject({ kind: "accepted", replayed: false });
    const order = acceptedOrder(outcome);
    expect(plain(order)).toStrictEqual({
      id: "order-1",
      orderNumber: "SO-000000000001",
      submissionKey: "key-1",
      quantity: 30,
      destination: { latitude: 0, longitude: 0 },
      unitPrice: "150.00",
      merchandiseSubtotal: "4500.00",
      discountRate: "0.05",
      discountAmount: "225.00",
      discountedMerchandiseTotal: "4275.00",
      shippingCost: order.shippingCost.toString(),
      orderTotal: order.orderTotal.toString(),
      allocations: [
        { warehouseId: "a", quantity: 20 },
        { warehouseId: "b", quantity: 10 },
      ],
    });
    expect(order.allocations.reduce((sum, a) => sum + a.quantity, 0)).toBe(order.quantity);
    expect(store.orders).toHaveLength(1);
    expect(store.stock()).toStrictEqual({ a: 0, b: 10 });
    expect(store.calls).toStrictEqual(["find", "begin", "lock", "tx.find", "save", "commit"]);
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  test("uses the default random order number generator", async () => {
    const store = new FakeSubmissionStore(INVENTORY);
    const order = acceptedOrder(await createSubmitOrder({ store })(input()));
    expect(order.orderNumber).toMatch(ORDER_NUMBER_PATTERN);
  });

  test("a new key is evaluated against the stock left by earlier Orders", async () => {
    const { store, submitOrder } = setup();
    acceptedOrder(await submitOrder(input()));
    const second = await submitOrder(input({ submissionId: "key-2", quantity: 10 }));
    expect(acceptedOrder(second).allocations).toStrictEqual([{ warehouseId: "b", quantity: 10 }]);
    expect(store.stock()).toStrictEqual({ a: 0, b: 0 });
  });
});

describe("SubmitOrder business rejections", () => {
  test("insufficient stock is returned, writes nothing and is not retried", async () => {
    const { store, submitOrder } = setup();
    const outcome = await submitOrder(input({ quantity: 41 }));
    expect(outcome).toMatchObject({ kind: "rejected", reason: "INSUFFICIENT_STOCK" });
    if (outcome.kind === "rejected") {
      expect(outcome.estimate.merchandiseSubtotal.toString()).toBe("6150.00");
    }
    expect(store.orders).toStrictEqual([]);
    expect(store.stock()).toStrictEqual({ a: 20, b: 20 });
    expect(store.calls).toStrictEqual(["find", "begin", "lock", "tx.find", "commit"]);
  });

  test("shipping over the limit is returned, writes nothing and is not retried", async () => {
    const { store, submitOrder } = setup([
      { warehouseId: "far", latitude: 0, longitude: 179, available: 5 },
    ]);
    const outcome = await submitOrder(input({ quantity: 1 }));
    expect(outcome).toMatchObject({ kind: "rejected", reason: "SHIPPING_EXCEEDS_LIMIT" });
    expect(store.orders).toStrictEqual([]);
    expect(store.stock()).toStrictEqual({ far: 5 });
    expect(store.calls.filter((call) => call === "begin")).toHaveLength(1);
  });

  test("a rejected key is not consumed: the same key is reevaluated and can succeed", async () => {
    const { store, submitOrder } = setup();
    expect((await submitOrder(input({ quantity: 41 }))).kind).toBe("rejected");
    store.warehouses.push({ warehouseId: "c", latitude: 0, longitude: 3, available: 1 });
    const retry = await submitOrder(input({ quantity: 41 }));
    expect(acceptedOrder(retry).submissionKey).toBe("key-1");
  });
});

describe("SubmitOrder duplicate submissions", () => {
  test("a repeat is short-circuited by the unlocked lookup without a transaction", async () => {
    const { store, submitOrder } = setup();
    const first = acceptedOrder(await submitOrder(input()));
    store.calls.length = 0;
    store.warehouses = store.warehouses.map((w) => ({ ...w, available: 0 }));

    const repeat = await submitOrder(input());
    expect(repeat).toMatchObject({ kind: "accepted", replayed: true });
    expect(plain(acceptedOrder(repeat))).toStrictEqual(plain(first));
    expect(store.calls).toStrictEqual(["find"]);
    expect(store.orders).toHaveLength(1);
  });

  test("JSON key order and -0 do not make a repeat a conflict", async () => {
    const { store, submitOrder } = setup();
    acceptedOrder(await submitOrder(input()));
    const reordered = JSON.parse(
      '{"longitude":0,"latitude":-0,"quantity":30,"submissionId":"key-1"}',
    );
    expect(await submitOrder(reordered)).toMatchObject({ kind: "accepted", replayed: true });
    expect(await submitOrder(input({ latitude: -0, longitude: -0 }))).toMatchObject({
      kind: "accepted",
      replayed: true,
    });
    expect(store.orders).toHaveLength(1);
  });

  test.each([
    ["quantity", { quantity: 31 }],
    ["latitude", { latitude: 0.5 }],
    ["longitude", { longitude: 0.5 }],
  ])("a different %s with the same key conflicts without changing the Order", async (_, change) => {
    const { store, submitOrder } = setup();
    const first = acceptedOrder(await submitOrder(input()));
    const stock = store.stock();
    store.calls.length = 0;

    const outcome = await submitOrder(input(change));
    expect(outcome).toStrictEqual({ kind: "conflict", submissionKey: "key-1" });
    expect(store.calls).toStrictEqual(["find"]);
    expect(plain(store.orders)).toStrictEqual([plain(first)]);
    expect(store.stock()).toStrictEqual(stock);
  });

  describe("the locked lookup is authoritative", () => {
    /** A store whose unlocked lookup misses an Order that is visible under the locks. */
    const setupWithHiddenOrder = async () => {
      const { store, submitOrder } = setup();
      const first = acceptedOrder(await submitOrder(input()));
      store.findOrderBySubmissionKey = async () => {
        store.calls.push("find");
        return null;
      };
      store.calls.length = 0;
      return { store, submitOrder, first };
    };

    test("a repeat found under the locks is replayed without a write", async () => {
      const { store, submitOrder, first } = await setupWithHiddenOrder();
      const outcome = await submitOrder(input());
      expect(outcome).toMatchObject({ kind: "accepted", replayed: true });
      expect(plain(acceptedOrder(outcome))).toStrictEqual(plain(first));
      expect(store.calls).toStrictEqual(["find", "begin", "lock", "tx.find", "commit"]);
      expect(store.stock()).toStrictEqual({ a: 0, b: 10 });
    });

    test("a changed input found under the locks conflicts without a write", async () => {
      const { store, submitOrder } = await setupWithHiddenOrder();
      const outcome = await submitOrder(input({ quantity: 5 }));
      expect(outcome).toStrictEqual({ kind: "conflict", submissionKey: "key-1" });
      expect(store.calls).toStrictEqual(["find", "begin", "lock", "tx.find", "commit"]);
      expect(store.orders).toHaveLength(1);
    });
  });

  describe("a concurrent winner took the key (unique violation)", () => {
    /** Commits a winning Order for key-1 outside the losing transaction, then fails its save. */
    const concurrentWinner = (quantity: number) => (store: FakeSubmissionStore) => {
      store.orders.push(
        restoreOrder({
          id: "winner",
          orderNumber: "SO-WWWWWWWWWWWW",
          submissionKey: "key-1",
          quantity,
          destination: { latitude: 0, longitude: 0 },
          unitPrice: "150.00",
          discountRate: "0.00",
          discountAmount: "0.00",
          shippingCost: "0.00",
          allocations: [{ warehouseId: "a", quantity }],
        }),
      );
      throw new SubmissionKeyTakenError("duplicate key value violates orders_submission_key_key");
    };

    test("with the same input it replays the winner", async () => {
      const { store, submitOrder } = setup();
      store.beforeSave.push(concurrentWinner(30));
      const outcome = await submitOrder(input());
      expect(outcome).toMatchObject({ kind: "accepted", replayed: true, order: { id: "winner" } });
      expect(store.calls).toStrictEqual(["find", "begin", "lock", "tx.find", "save", "find"]);
      expect(store.orders).toHaveLength(1);
      // The losing transaction rolled back: its stock deduction was discarded.
      expect(store.stock()).toStrictEqual({ a: 20, b: 20 });
    });

    test("with a different input it conflicts", async () => {
      const { store, submitOrder } = setup();
      store.beforeSave.push(concurrentWinner(1));
      expect(await submitOrder(input())).toStrictEqual({
        kind: "conflict",
        submissionKey: "key-1",
      });
      expect(store.orders.map((order) => order.id)).toStrictEqual(["winner"]);
    });

    test("when the winner is not visible it retries like a transient failure", async () => {
      const { store, submitOrder } = setup();
      store.beforeSave.push(() => {
        throw new SubmissionKeyTakenError("duplicate submission_key");
      });
      const outcome = await submitOrder(input());
      expect(outcome).toMatchObject({ kind: "accepted", replayed: false });
      expect(store.calls.filter((call) => call === "begin")).toHaveLength(2);
      expect(store.orders).toHaveLength(1);
    });
  });
});

describe("SubmitOrder transient failures", () => {
  test("retries a transient failure and succeeds on attempt 2 with a new order number", async () => {
    const { store, submitOrder } = setup();
    store.beforeSave.push(transient);
    const order = acceptedOrder(await submitOrder(input()));
    expect(order.orderNumber).toBe("SO-000000000002");
    expect(store.calls).toStrictEqual([
      "find",
      "begin",
      "lock",
      "tx.find",
      "save",
      "begin",
      "lock",
      "tx.find",
      "save",
      "commit",
    ]);
    expect(store.orders).toHaveLength(1);
    expect(store.stock()).toStrictEqual({ a: 0, b: 10 });
  });

  test(`gives up after exactly ${MAX_SUBMISSION_ATTEMPTS} attempts and leaves the key reusable`, async () => {
    expect(MAX_SUBMISSION_ATTEMPTS).toBe(3);
    const { store, submitOrder } = setup();
    store.beforeSave.push(transient, transient, transient);
    expect(await submitOrder(input())).toStrictEqual({ kind: "unavailable", attempts: 3 });
    expect(store.calls.filter((call) => call === "begin")).toHaveLength(3);
    expect(store.orders).toStrictEqual([]);
    expect(store.stock()).toStrictEqual({ a: 20, b: 20 });

    expect(acceptedOrder(await submitOrder(input())).submissionKey).toBe("key-1");
  });

  test("honours a custom maxAttempts, including key-taken retries", async () => {
    const store = new FakeSubmissionStore(INVENTORY);
    const submitOrder = createSubmitOrder({ store, maxAttempts: 1 });
    store.beforeSave.push(() => {
      throw new SubmissionKeyTakenError("duplicate submission_key");
    });
    expect(await submitOrder(input())).toStrictEqual({ kind: "unavailable", attempts: 1 });
    expect(store.calls.filter((call) => call === "begin")).toHaveLength(1);
  });
});

describe("SubmitOrder unlocked lookup failures", () => {
  const failingLookup = (store: FakeSubmissionStore, failOnCall: number) => {
    const real = store.findOrderBySubmissionKey.bind(store);
    let calls = 0;
    store.findOrderBySubmissionKey = async (key) => {
      calls += 1;
      if (calls === failOnCall) {
        store.calls.push("find");
        throw new TransientSubmissionError("no connection available in time");
      }
      return real(key);
    };
  };

  test("a transient failure of the initial lookup is unavailable, with no transaction", async () => {
    const { store, submitOrder } = setup();
    failingLookup(store, 1);
    expect(await submitOrder(input())).toStrictEqual({ kind: "unavailable", attempts: 0 });
    expect(store.calls).toStrictEqual(["find"]);
    expect(store.orders).toStrictEqual([]);
    // The key is not consumed.
    expect(acceptedOrder(await submitOrder(input())).submissionKey).toBe("key-1");
  });

  test("a transient failure of the lookup that resolves a taken key is unavailable", async () => {
    const { store, submitOrder } = setup();
    failingLookup(store, 2);
    store.beforeSave.push(() => {
      throw new SubmissionKeyTakenError("duplicate submission_key");
    });
    expect(await submitOrder(input())).toStrictEqual({ kind: "unavailable", attempts: 1 });
    expect(store.calls).toStrictEqual(["find", "begin", "lock", "tx.find", "save", "find"]);
    expect(store.orders).toStrictEqual([]);
    expect(store.stock()).toStrictEqual({ a: 20, b: 20 });
  });

  test("other lookup errors still propagate", async () => {
    const { store, submitOrder } = setup();
    const failure = new Error("unexpected");
    store.findOrderBySubmissionKey = async () => {
      throw failure;
    };
    await expect(submitOrder(input())).rejects.toBe(failure);
  });
});

describe("SubmitOrder unexpected errors", () => {
  test("a DomainError propagates and is not retried", async () => {
    const { store, submitOrder } = setup([
      { warehouseId: "a", latitude: 0, longitude: 1, available: 20 },
      { warehouseId: "a", latitude: 0, longitude: 2, available: 20 },
    ]);
    await expect(submitOrder(input())).rejects.toThrow(DomainError);
    await expect(submitOrder(input())).rejects.toMatchObject({ code: "INVALID_INVENTORY" });
    expect(store.calls.filter((call) => call === "begin")).toHaveLength(2);
    expect(store.orders).toStrictEqual([]);
  });

  test("an invalid generated order number is a DomainError", async () => {
    const store = new FakeSubmissionStore(INVENTORY);
    const submitOrder = createSubmitOrder({ store, generateOrderNumber: () => "SO-1" });
    await expect(submitOrder(input())).rejects.toMatchObject({ code: "INVALID_ORDER" });
    expect(store.orders).toStrictEqual([]);
  });

  test("any other error propagates, rolls back and is not retried", async () => {
    const { store, submitOrder } = setup();
    store.beforeSave.push(() => {
      throw new Error("connection lost");
    });
    await expect(submitOrder(input())).rejects.toThrow("connection lost");
    expect(store.calls.filter((call) => call === "begin")).toHaveLength(1);
    expect(store.orders).toStrictEqual([]);
    expect(store.stock()).toStrictEqual({ a: 20, b: 20 });
  });
});

describe("port errors", () => {
  test("carry their name and cause", () => {
    const cause = new Error("40001");
    const transientError = new TransientSubmissionError("retry", { cause });
    expect(transientError).toBeInstanceOf(Error);
    expect(transientError.name).toBe("TransientSubmissionError");
    expect(transientError.cause).toBe(cause);
    const taken = new SubmissionKeyTakenError("taken");
    expect(taken.name).toBe("SubmissionKeyTakenError");
    expect(taken.cause).toBeUndefined();
  });
});
