/**
 * Traces the SubmissionStore port and every call on its transaction. Spans
 * end when each call settles; nothing here waits on telemetry export inside
 * the transaction.
 *
 * @module
 */

import type { SubmissionStore, SubmissionTransaction } from "@scos/core";

import { ATTR_ORDER_FOUND, ATTR_WAREHOUSE_COUNT, inSpan } from "#telemetry/decorators/span";
import type { Telemetry } from "#telemetry/telemetry";

function traceTransaction(tx: SubmissionTransaction, telemetry: Telemetry): SubmissionTransaction {
  return {
    lockInventory: () =>
      inSpan(telemetry, "SubmissionTransaction.lockInventory", async (span) => {
        const snapshot = await tx.lockInventory();
        span.setAttribute(ATTR_WAREHOUSE_COUNT, snapshot.length);
        return snapshot;
      }),
    findOrderBySubmissionKey: (key) =>
      inSpan(telemetry, "SubmissionTransaction.findOrderBySubmissionKey", async (span) => {
        const order = await tx.findOrderBySubmissionKey(key);
        span.setAttribute(ATTR_ORDER_FOUND, order !== null);
        return order;
      }),
    saveAcceptedOrder: (order) =>
      inSpan(telemetry, "SubmissionTransaction.saveAcceptedOrder", () =>
        tx.saveAcceptedOrder(order),
      ),
  };
}

export function traceSubmissionStore(
  store: SubmissionStore,
  telemetry: Telemetry,
): SubmissionStore {
  return {
    findOrderBySubmissionKey: (key) =>
      inSpan(telemetry, "SubmissionStore.findOrderBySubmissionKey", async (span) => {
        const order = await store.findOrderBySubmissionKey(key);
        span.setAttribute(ATTR_ORDER_FOUND, order !== null);
        return order;
      }),
    runInTransaction: (work) =>
      inSpan(telemetry, "SubmissionStore.runInTransaction", () =>
        store.runInTransaction((tx) => work(traceTransaction(tx, telemetry))),
      ),
  };
}
