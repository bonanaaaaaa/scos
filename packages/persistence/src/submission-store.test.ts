import {
  DomainError,
  type NewOrder,
  SubmissionKeyTakenError,
  type SubmissionKey,
  TransientSubmissionError,
  createOrder,
  estimateOrder,
  orderRequestSchema,
  submissionKeySchema,
} from "@scos/core";
import { describe, expect, test, vi } from "vitest";

import { Prisma, type PrismaClient } from "./generated/prisma/client";
import {
  DEFAULT_SUBMISSION_TRANSACTION_OPTIONS,
  type OrderRow,
  assertAllocationsCoverQuantity,
  createPrismaSubmissionStore,
  toDomainOrder,
  toInventorySnapshot,
} from "./submission-store";

const decimal = (value: string) => new Prisma.Decimal(value);
const LA = "01996000-0000-7000-8000-000000000001";
const NY = "01996000-0000-7000-8000-000000000002";
const key = (value: string) => submissionKeySchema.parse(value);

const row: OrderRow = {
  id: "01996000-0000-7000-8000-0000000000aa",
  orderNumber: "SO-7K3M9Q2XH4TB",
  submissionKey: "submission-1",
  quantity: 400,
  destinationLatitude: 33.9425,
  destinationLongitude: -118.408056,
  unitPrice: decimal("150"),
  discountRate: decimal("0.2"),
  discountAmount: decimal("12000"),
  shippingCost: decimal("654.32"),
  allocations: [
    { warehouseId: LA, quantity: 355 },
    { warehouseId: NY, quantity: 45 },
  ],
};

function newOrder(quantity = 10): NewOrder {
  const estimate = estimateOrder(
    orderRequestSchema.parse({ quantity, latitude: 33.9425, longitude: -118.408056 }),
    [{ warehouseId: LA, latitude: 33.9425, longitude: -118.408056, available: 100 }],
  );
  return createOrder({
    orderNumber: "SO-0000000000AA",
    submissionKey: key("submission-1"),
    estimate,
  });
}

function knownError(code: string, meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("failed", {
    code,
    clientVersion: "7.10.0",
    meta,
  });
}

function uniqueViolation(index: string) {
  return knownError("P2002", {
    driverAdapterError: {
      cause: { originalCode: "23505", kind: "UniqueConstraintViolation", constraint: { index } },
    },
  });
}

/** Records the SQL text of every tagged-template raw call. */
function sqlOf(strings: TemplateStringsArray) {
  return strings.join("?").replaceAll(/\s+/g, " ").trim();
}

interface FakeOptions {
  readonly warehouses?: readonly {
    id: string;
    latitude: number;
    longitude: number;
    stock: number;
  }[];
  readonly stockUpdated?: number;
  readonly createError?: unknown;
  readonly stored?: OrderRow | null;
}

function fakePrisma(options: FakeOptions = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const transactionOptions: unknown[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: sqlOf(strings), values });
      return sqlOf(strings).startsWith("SELECT id::text") ? (options.warehouses ?? []) : [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: sqlOf(strings), values });
      return options.stockUpdated ?? 1;
    }),
    order: {
      findUnique: vi.fn(async () => options.stored ?? null),
      findUniqueOrThrow: vi.fn(async () => options.stored ?? row),
      create: vi.fn(async () => {
        if (options.createError !== undefined) {
          throw options.createError;
        }
        return { id: row.id };
      }),
    },
  };
  const prisma = {
    order: tx.order,
    $transaction: vi.fn(
      async (work: (client: typeof tx) => Promise<unknown>, txOptions: unknown) => {
        transactionOptions.push(txOptions);
        return work(tx);
      },
    ),
  };
  return { prisma: prisma as unknown as PrismaClient, tx, calls, transactionOptions };
}

describe("toDomainOrder", () => {
  test("maps a stored row to the domain Order with exact decimal strings and derived totals", () => {
    const order = toDomainOrder(row);
    expect(JSON.parse(JSON.stringify(order))).toStrictEqual({
      id: row.id,
      orderNumber: "SO-7K3M9Q2XH4TB",
      submissionKey: "submission-1",
      quantity: 400,
      destination: { latitude: 33.9425, longitude: -118.408056 },
      unitPrice: "150.00",
      merchandiseSubtotal: "60000.00",
      discountRate: "0.20",
      discountAmount: "12000.00",
      discountedMerchandiseTotal: "48000.00",
      shippingCost: "654.32",
      orderTotal: "48654.32",
      // Allocations keep the order they were read in.
      allocations: [
        { warehouseId: LA, quantity: 355 },
        { warehouseId: NY, quantity: 45 },
      ],
    });
    expect(Object.isFrozen(order)).toBe(true);
  });

  test("keeps stored amounts that current commercial rules would not produce", () => {
    const order = toDomainOrder({
      ...row,
      unitPrice: decimal("149.99"),
      discountRate: decimal("0.05"),
    });
    expect(order.unitPrice.toString()).toBe("149.99");
    expect(order.discountRate).toBe("0.05");
    expect(order.merchandiseSubtotal.toString()).toBe("59996.00");
  });

  test("refuses rows that cannot be exact domain values", () => {
    expect(() => toDomainOrder({ ...row, shippingCost: decimal("1.005") })).toThrow(
      /at most 2 decimal places/,
    );
    expect(() => toDomainOrder({ ...row, discountRate: decimal("0.125") })).toThrow(
      /at most 2 decimal places/,
    );
    expect(() => toDomainOrder({ ...row, allocations: [] })).toThrow(DomainError);
    expect(() => toDomainOrder({ ...row, orderNumber: "" })).toThrow(DomainError);
    expect(() => toDomainOrder({ ...row, submissionKey: " padded" })).toThrow(DomainError);
  });
});

test("toInventorySnapshot maps locked warehouse rows to core warehouse stock", () => {
  const snapshot = toInventorySnapshot([{ id: LA, latitude: 1, longitude: 2, stock: 3 }]);
  expect(snapshot).toStrictEqual([{ warehouseId: LA, latitude: 1, longitude: 2, available: 3 }]);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot[0])).toBe(true);
});

test("assertAllocationsCoverQuantity refuses allocations that do not sum to the quantity", () => {
  const order = newOrder(10);
  expect(() => assertAllocationsCoverQuantity(order)).not.toThrow();
  expect(() =>
    assertAllocationsCoverQuantity({
      ...order,
      allocations: [{ warehouseId: LA, quantity: 11 }],
    }),
  ).toThrow(/Allocations sum to 11, but the Order quantity is 10/);
});

describe("createPrismaSubmissionStore options", () => {
  test("validates the transaction timing options", () => {
    const { prisma } = fakePrisma();
    expect(() => createPrismaSubmissionStore(prisma, { timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createPrismaSubmissionStore(prisma, { maxWaitMs: 1.5 })).toThrow(RangeError);
    expect(() => createPrismaSubmissionStore(prisma, { lockTimeoutMs: 15_000 })).toThrow(
      /lockTimeoutMs must be less than timeoutMs/,
    );
    expect(() =>
      createPrismaSubmissionStore(prisma, { lockTimeoutMs: 100, timeoutMs: 200 }),
    ).not.toThrow();
  });

  test("runs READ COMMITTED with explicit maxWait and timeout, and sets lock and statement timeouts", async () => {
    const { prisma, calls, transactionOptions } = fakePrisma();
    const store = createPrismaSubmissionStore(prisma);
    await expect(store.runInTransaction(async () => "done")).resolves.toBe("done");

    expect(transactionOptions).toStrictEqual([
      {
        isolationLevel: "ReadCommitted",
        maxWait: DEFAULT_SUBMISSION_TRANSACTION_OPTIONS.maxWaitMs,
        timeout: DEFAULT_SUBMISSION_TRANSACTION_OPTIONS.timeoutMs,
      },
    ]);
    expect(calls).toStrictEqual([
      {
        sql: "SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)",
        values: ["10000ms", "15000ms"],
      },
    ]);
  });
});

describe("runInTransaction", () => {
  test("classifies database failures at the transaction boundary", async () => {
    const { prisma } = fakePrisma({
      createError: uniqueViolation("orders_submission_key_key"),
      warehouses: [{ id: LA, latitude: 33.9425, longitude: -118.408056, stock: 100 }],
    });
    const store = createPrismaSubmissionStore(prisma);
    await expect(
      store.runInTransaction(async (tx) => {
        await tx.lockInventory();
        return tx.saveAcceptedOrder(newOrder());
      }),
    ).rejects.toBeInstanceOf(SubmissionKeyTakenError);

    const timedOut = knownError("P2028", { operation: "commit", timeout: 1, timeTaken: 2 });
    prisma.$transaction = vi.fn(async () => {
      throw timedOut;
    }) as unknown as PrismaClient["$transaction"];
    const error: unknown = await store.runInTransaction(async () => null).catch((e) => e);
    expect(error).toBeInstanceOf(TransientSubmissionError);
    expect((error as Error).cause).toBe(timedOut);
  });

  test("lets errors of the work itself propagate unchanged", async () => {
    const { prisma } = fakePrisma();
    const failure = new DomainError("INVALID_ORDER", "broken");
    await expect(
      createPrismaSubmissionStore(prisma).runInTransaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("locks every warehouse row in id order and returns the snapshot", async () => {
    const { prisma, calls } = fakePrisma({
      warehouses: [
        { id: LA, latitude: 1, longitude: 2, stock: 3 },
        { id: NY, latitude: 4, longitude: 5, stock: 6 },
      ],
    });
    const snapshot = await createPrismaSubmissionStore(prisma).runInTransaction((tx) =>
      tx.lockInventory(),
    );
    expect(snapshot.map((stock) => stock.warehouseId)).toStrictEqual([LA, NY]);
    expect(calls.at(-1)?.sql).toBe(
      "SELECT id::text AS id, latitude, longitude, stock FROM warehouses ORDER BY id FOR UPDATE",
    );
  });

  test("requires lockInventory before the locked lookup or a save", async () => {
    const { prisma, tx } = fakePrisma();
    const store = createPrismaSubmissionStore(prisma);
    await expect(
      store.runInTransaction((transaction) =>
        transaction.findOrderBySubmissionKey(key("submission-1")),
      ),
    ).rejects.toThrow(/lockInventory\(\) first/);
    await expect(
      store.runInTransaction((transaction) => transaction.saveAcceptedOrder(newOrder())),
    ).rejects.toThrow(/lockInventory\(\) first/);
    expect(tx.order.findUnique).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  test("saves the Order with decimal strings, deducts guarded stock, and returns the re-read row", async () => {
    const { prisma, tx, calls } = fakePrisma({ stored: row });
    const order = newOrder(100);
    const saved = await createPrismaSubmissionStore(prisma).runInTransaction(
      async (transaction) => {
        await transaction.lockInventory();
        return transaction.saveAcceptedOrder(order);
      },
    );

    expect(tx.order.create).toHaveBeenCalledWith({
      data: {
        orderNumber: "SO-0000000000AA",
        submissionKey: "submission-1",
        quantity: 100,
        destinationLatitude: 33.9425,
        destinationLongitude: -118.408056,
        unitPrice: "150.00",
        discountRate: "0.15",
        discountAmount: "2250.00",
        shippingCost: "0.00",
        allocations: { createMany: { data: [{ warehouseId: LA, quantity: 100 }] } },
      },
      select: { id: true },
    });
    expect(calls.at(-1)).toStrictEqual({
      sql: "UPDATE warehouses SET stock = stock - ? WHERE id = ?::uuid AND stock >= ?",
      values: [100, LA, 100],
    });
    expect(saved).toStrictEqual(toDomainOrder(row));
  });

  test("refuses an allocation above the locked stock", async () => {
    const { prisma, tx } = fakePrisma({ stockUpdated: 0 });
    await expect(
      createPrismaSubmissionStore(prisma).runInTransaction(async (transaction) => {
        await transaction.lockInventory();
        return transaction.saveAcceptedOrder(newOrder(10));
      }),
    ).rejects.toThrow(/exceeds its stock/);
    expect(tx.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  test("refuses allocations that do not sum to the quantity before writing", async () => {
    const { prisma, tx } = fakePrisma();
    const order = newOrder(10);
    await expect(
      createPrismaSubmissionStore(prisma).runInTransaction(async (transaction) => {
        await transaction.lockInventory();
        return transaction.saveAcceptedOrder({
          ...order,
          allocations: [{ warehouseId: LA, quantity: 9 }],
        });
      }),
    ).rejects.toThrow(/Allocations sum to 9/);
    expect(tx.order.create).not.toHaveBeenCalled();
  });
});

describe("findOrderBySubmissionKey", () => {
  test("reads by submission key, outside and inside the transaction, and maps the row", async () => {
    const { prisma, tx } = fakePrisma({ stored: row });
    const store = createPrismaSubmissionStore(prisma);
    const submissionKey: SubmissionKey = key("submission-1");

    expect(await store.findOrderBySubmissionKey(submissionKey)).toStrictEqual(toDomainOrder(row));
    const locked = await store.runInTransaction(async (transaction) => {
      await transaction.lockInventory();
      return transaction.findOrderBySubmissionKey(submissionKey);
    });
    expect(locked).toStrictEqual(toDomainOrder(row));
    expect(tx.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { submissionKey: "submission-1" },
        select: expect.objectContaining({
          allocations: {
            select: { warehouseId: true, quantity: true },
            orderBy: { id: "asc" },
          },
        }),
      }),
    );
  });

  test("returns null when no Order has the key", async () => {
    const { prisma } = fakePrisma({ stored: null });
    expect(
      await createPrismaSubmissionStore(prisma).findOrderBySubmissionKey(key("missing")),
    ).toBeNull();
  });

  test("classifies a connection timeout of the unlocked lookup and of the transaction", async () => {
    const { prisma, tx } = fakePrisma();
    const store = createPrismaSubmissionStore(prisma);
    tx.order.findUnique.mockRejectedValueOnce(
      new Error("Connection terminated due to connection timeout"),
    );
    await expect(store.findOrderBySubmissionKey(key("k"))).rejects.toBeInstanceOf(
      TransientSubmissionError,
    );

    prisma.$transaction = vi.fn(async () => {
      throw new Error("timeout exceeded when trying to connect");
    }) as unknown as PrismaClient["$transaction"];
    await expect(store.runInTransaction(async () => null)).rejects.toBeInstanceOf(
      TransientSubmissionError,
    );
  });

  test("classifies a failed locked lookup", async () => {
    const { prisma, tx } = fakePrisma();
    tx.order.findUnique.mockRejectedValueOnce(
      knownError("P2010", {
        driverAdapterError: { cause: { originalCode: "57014", kind: "postgres" } },
      }),
    );
    await expect(
      createPrismaSubmissionStore(prisma).runInTransaction(async (transaction) => {
        await transaction.lockInventory();
        return transaction.findOrderBySubmissionKey(key("submission-1"));
      }),
    ).rejects.toBeInstanceOf(TransientSubmissionError);
  });
});
