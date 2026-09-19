import {
  type InventorySnapshot,
  type NewOrder,
  type Order,
  type SubmissionKey,
  type SubmissionStore,
  type SubmissionTransaction,
  restoreOrder,
} from "@scos/core";

import { Prisma, type PrismaClient } from "./generated/prisma/client";
import { formatDiscountRate, formatMoney } from "./records";
import { classifySubmissionError } from "./submission-errors";

/**
 * Prisma adapter for the SubmissionStore port (ADR 0004,
 * docs/database-schema.md "Write pattern for submission").
 *
 * Every submission attempt is one READ COMMITTED interactive transaction:
 * lock all warehouse rows in ascending id order, look the submission key up
 * again under the locks, and on acceptance insert the Order and its
 * allocations and deduct stock. The adapter owns the SQL and classifies
 * database failures into the port's typed errors (see submission-errors.ts).
 *
 * @module
 */

export interface PrismaSubmissionStoreOptions {
  /**
   * Milliseconds to wait for a pooled connection before the transaction
   * starts. Elapsing is transient (nothing started). Default 5 000.
   */
  readonly maxWaitMs?: number;
  /**
   * Milliseconds the interactive transaction may run, including waits for the
   * warehouse row locks. Prisma then rolls it back without committing, which
   * is transient. It is also applied as the transaction's PostgreSQL
   * `statement_timeout`, because Prisma's timeout does not cancel a statement
   * that is already running. Default 15 000.
   */
  readonly timeoutMs?: number;
  /**
   * PostgreSQL `lock_timeout` for the transaction, in milliseconds (`55P03`,
   * transient). Must be below `timeoutMs` so a lock wait fails as a database
   * error rather than outliving the transaction. Default 10 000: submissions
   * hold the locks for a few milliseconds, so concurrent attempts queue well
   * within it.
   */
  readonly lockTimeoutMs?: number;
}

export const DEFAULT_SUBMISSION_TRANSACTION_OPTIONS = Object.freeze({
  maxWaitMs: 5_000,
  timeoutMs: 15_000,
  lockTimeoutMs: 10_000,
} satisfies Required<PrismaSubmissionStoreOptions>);

/** The stored columns of an Order and its allocations that the domain needs. */
export interface OrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly submissionKey: string;
  readonly quantity: number;
  readonly destinationLatitude: number;
  readonly destinationLongitude: number;
  readonly unitPrice: Prisma.Decimal;
  readonly discountRate: Prisma.Decimal;
  readonly discountAmount: Prisma.Decimal;
  readonly shippingCost: Prisma.Decimal;
  readonly allocations: readonly { readonly warehouseId: string; readonly quantity: number }[];
}

/** A locked warehouse row as returned by {@link LOCK_WAREHOUSES}. */
export interface WarehouseStockRow {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly stock: number;
}

/**
 * Selects exactly the columns of {@link OrderRow}. Allocations are read in
 * insertion order: their ids are UUIDv7 values from PostgreSQL 18's
 * `uuidv7()`, which is monotonic within a session, and all allocations of an
 * Order are inserted by one statement. The first response and every repeat
 * therefore list them identically.
 */
const orderSelect = {
  id: true,
  orderNumber: true,
  submissionKey: true,
  quantity: true,
  destinationLatitude: true,
  destinationLongitude: true,
  unitPrice: true,
  discountRate: true,
  discountAmount: true,
  shippingCost: true,
  allocations: {
    select: { warehouseId: true, quantity: true },
    orderBy: { id: "asc" },
  },
} as const satisfies Prisma.OrderSelect;

/**
 * Rebuilds the domain Order from its stored row. Decimals become exact
 * strings from the decimal value itself (never a JavaScript number); the
 * derived totals are computed by `restoreOrder`, not read.
 */
export function toDomainOrder(row: OrderRow): Order {
  return restoreOrder({
    id: row.id,
    orderNumber: row.orderNumber,
    submissionKey: row.submissionKey,
    quantity: row.quantity,
    destination: { latitude: row.destinationLatitude, longitude: row.destinationLongitude },
    unitPrice: formatMoney(row.unitPrice),
    discountRate: formatDiscountRate(row.discountRate),
    discountAmount: formatMoney(row.discountAmount),
    shippingCost: formatMoney(row.shippingCost),
    allocations: row.allocations.map(({ warehouseId, quantity }) => ({ warehouseId, quantity })),
  });
}

/** Maps locked warehouse rows to the core inventory snapshot. */
export function toInventorySnapshot(rows: readonly WarehouseStockRow[]): InventorySnapshot {
  return Object.freeze(
    rows.map(({ id, latitude, longitude, stock }) =>
      Object.freeze({ warehouseId: id, latitude, longitude, available: stock }),
    ),
  );
}

/** Throws unless the allocations sum to the Order quantity (schema cannot). */
export function assertAllocationsCoverQuantity(order: NewOrder): void {
  const allocated = order.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
  if (allocated !== order.quantity) {
    throw new Error(
      `Allocations sum to ${allocated}, but the Order quantity is ${order.quantity}; nothing was saved.`,
    );
  }
}

function resolveOptions(
  options: PrismaSubmissionStoreOptions,
): Required<PrismaSubmissionStoreOptions> {
  const resolved = { ...DEFAULT_SUBMISSION_TRANSACTION_OPTIONS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer number of milliseconds.`);
    }
  }
  if (resolved.lockTimeoutMs >= resolved.timeoutMs) {
    throw new RangeError("lockTimeoutMs must be less than timeoutMs.");
  }
  return resolved;
}

async function findOrder(
  client: Prisma.TransactionClient | PrismaClient,
  key: SubmissionKey,
): Promise<Order | null> {
  const row = await client.order.findUnique({ where: { submissionKey: key }, select: orderSelect });
  return row === null ? null : toDomainOrder(row);
}

/** Runs a database call inside the transaction, classifying its failure. */
async function classified<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw classifySubmissionError(error);
  }
}

function createTransaction(tx: Prisma.TransactionClient): SubmissionTransaction {
  let locked = false;
  const requireLock = (operation: string) => {
    if (!locked) {
      throw new Error(`${operation} requires lockInventory() first in the same transaction.`);
    }
  };

  return {
    async lockInventory() {
      const rows = await classified(
        () => tx.$queryRaw<WarehouseStockRow[]>`
          SELECT id::text AS id, latitude, longitude, stock
          FROM warehouses
          ORDER BY id
          FOR UPDATE`,
      );
      locked = true;
      return toInventorySnapshot(rows);
    },

    async findOrderBySubmissionKey(key) {
      requireLock("findOrderBySubmissionKey");
      return classified(() => findOrder(tx, key));
    },

    async saveAcceptedOrder(order) {
      requireLock("saveAcceptedOrder");
      assertAllocationsCoverQuantity(order);
      return classified(async () => {
        const { id } = await tx.order.create({
          data: {
            orderNumber: order.orderNumber,
            submissionKey: order.submissionKey,
            quantity: order.quantity,
            destinationLatitude: order.destination.latitude,
            destinationLongitude: order.destination.longitude,
            unitPrice: order.unitPrice.toString(),
            discountRate: order.discountRate,
            discountAmount: order.discountAmount.toString(),
            shippingCost: order.shippingCost.toString(),
            // One INSERT for all allocations, in the Order's allocation order.
            allocations: {
              createMany: {
                data: order.allocations.map(({ warehouseId, quantity }) => ({
                  warehouseId,
                  quantity,
                })),
              },
            },
          },
          select: { id: true },
        });

        for (const { warehouseId, quantity } of order.allocations) {
          // Guarded deduction: stock never goes negative, and an allocation
          // above the locked stock rolls the whole transaction back.
          const updated = await tx.$executeRaw`
            UPDATE warehouses
            SET stock = stock - ${quantity}
            WHERE id = ${warehouseId}::uuid AND stock >= ${quantity}`;
          if (updated !== 1) {
            throw new Error(
              `Allocation of ${quantity} from warehouse ${warehouseId} exceeds its stock; nothing was saved.`,
            );
          }
        }

        // Build the result from the persisted rows so the first response
        // equals every later repeat.
        const saved = await tx.order.findUniqueOrThrow({ where: { id }, select: orderSelect });
        return toDomainOrder(saved);
      });
    },
  };
}

/**
 * Creates the Prisma-backed {@link SubmissionStore}. The client may be shared
 * with other adapters; each `runInTransaction` borrows one pooled connection.
 */
export function createPrismaSubmissionStore(
  prisma: PrismaClient,
  options: PrismaSubmissionStoreOptions = {},
): SubmissionStore {
  const { maxWaitMs, timeoutMs, lockTimeoutMs } = resolveOptions(options);

  return {
    findOrderBySubmissionKey(key) {
      return findOrder(prisma, key);
    },

    async runInTransaction(work) {
      try {
        return await prisma.$transaction(
          async (tx) => {
            // SET LOCAL equivalents: they end with the transaction.
            await tx.$queryRaw`
              SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
                     set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`;
            return work(createTransaction(tx));
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: maxWaitMs,
            timeout: timeoutMs,
          },
        );
      } catch (error) {
        throw classifySubmissionError(error);
      }
    },
  };
}
