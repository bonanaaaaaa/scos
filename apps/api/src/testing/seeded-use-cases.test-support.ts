/**
 * The real core use cases over an in-memory copy of the seeded database
 * (`warehouseSeeds`), so tests can replay the OpenAPI examples through the
 * combined app and compare every status and byte with the documentation.
 */

import {
  type InventorySnapshot,
  type NewOrder,
  type Order,
  type SubmissionStore,
  type SubmissionTransaction,
  TransientSubmissionError,
  createSubmitOrder,
  createVerifyOrder,
} from "@scos/core";
import { warehouseSeeds } from "@scos/persistence";
import type { Hono } from "hono";

import { createApp } from "#app";

import { fakeLogger } from "./fixtures.test-support";

/** Current stock of a freshly seeded database. */
export function seedInventory(): InventorySnapshot {
  return warehouseSeeds.map(({ id, latitude, longitude, stock }) => ({
    warehouseId: id,
    latitude,
    longitude,
    available: stock,
  }));
}

/**
 * Accepted Orders keyed by submission key, with stock deducted on save, like
 * the PostgreSQL adapter but without concurrency.
 */
export function inMemorySubmissionStore(): SubmissionStore & {
  readonly orders: Map<string, Order>;
} {
  const orders = new Map<string, Order>();
  let inventory = seedInventory();
  const find = async (key: string) => orders.get(key) ?? null;
  const transaction: SubmissionTransaction = {
    lockInventory: async () => inventory,
    findOrderBySubmissionKey: find,
    async saveAcceptedOrder(order: NewOrder) {
      const saved: Order = {
        ...order,
        id: `01996000-0000-7000-8000-${String(orders.size + 1).padStart(12, "0")}`,
      };
      inventory = inventory.map((warehouse) => ({
        ...warehouse,
        available:
          warehouse.available -
          order.allocations
            .filter(({ warehouseId }) => warehouseId === warehouse.warehouseId)
            .reduce((sum, { quantity }) => sum + quantity, 0),
      }));
      orders.set(order.submissionKey, saved);
      return saved;
    },
  };
  return {
    orders,
    findOrderBySubmissionKey: find,
    runInTransaction: (work) => work(transaction),
  };
}

export type StoreFailure = "none" | "transient" | "unexpected";

export interface SeededAppOptions {
  /** How submission transactions fail; `none` uses the in-memory store. */
  readonly submissionFailure?: StoreFailure;
  /** Makes the inventory read fail, as when the database is unreachable. */
  readonly inventoryFails?: boolean;
  readonly orderNumber?: string;
}

/** The combined app over the real use cases and the seeded inventory. */
export function seededApp(options: SeededAppOptions = {}): Hono {
  const { submissionFailure = "none", inventoryFails = false, orderNumber } = options;
  const store = inMemorySubmissionStore();
  const failing: SubmissionStore = {
    findOrderBySubmissionKey: async () => null,
    runInTransaction: async () => {
      throw submissionFailure === "transient"
        ? new TransientSubmissionError("lock timeout")
        : new Error("connection refused");
    },
  };
  return createApp({
    verifyOrder: createVerifyOrder({
      inventoryReader: {
        readInventorySnapshot: async () => {
          if (inventoryFails) {
            throw new Error("connection refused");
          }
          return seedInventory();
        },
      },
    }),
    submitOrder: createSubmitOrder({
      store: submissionFailure === "none" ? store : failing,
      ...(orderNumber === undefined ? {} : { generateOrderNumber: () => orderNumber }),
    }),
    logger: fakeLogger(),
  });
}
