/**
 * Tracing decorators for the core use cases and the persistence ports,
 * applied in the compositions. Core and persistence stay free of
 * OpenTelemetry: every span here wraps a port or use-case call from outside.
 * Runtime-neutral: they use only the injected {@link Telemetry} port.
 *
 * - Each call is an INTERNAL span in the active context (the request's
 *   SERVER span), with its duration.
 * - A thrown error marks the span failed with a sanitized exception (class
 *   name and database error code only). Business outcomes (an invalid
 *   estimate, a rejection, a conflict) are returned values and leave the
 *   status unset; SubmitOrder's `unavailable` outcome (503) marks its span
 *   failed.
 * - No span or metric carries submission keys, order numbers, coordinates,
 *   SQL or messages.
 * - Spans end synchronously when the call settles. Export is batched and
 *   asynchronous, so nothing here waits on the network, least of all inside
 *   the submission transaction.
 *
 * @module
 */

import type {
  InventoryReader,
  OrderEstimate,
  SubmissionStore,
  SubmissionTransaction,
  SubmitOrder,
  SubmitOrderOutcome,
  VerifyOrder,
} from "@scos/core";
import { type Attributes, type Span, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";

import { sanitizeError } from "./log-record";
import {
  ATTR_SUBMISSION_OUTCOME,
  ATTR_SUBMISSION_REJECTION_REASON,
  ATTR_SUBMISSION_REPLAYED,
  type SubmissionOutcome,
  type Telemetry,
  recordFailure,
} from "./telemetry";

export const ATTR_ESTIMATE_VALID = "scos.estimate.valid";
export const ATTR_ESTIMATE_REASON = "scos.estimate.reason";
export const ATTR_ORDER_FOUND = "scos.submission.order_found";
export const ATTR_WAREHOUSE_COUNT = "scos.inventory.warehouse_count";

/** Runs `work` in an active INTERNAL span that records a thrown error and ends. */
function inSpan<T>(
  telemetry: Telemetry,
  name: string,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return telemetry.tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

function estimateAttributes(estimate: OrderEstimate): Attributes {
  return estimate.valid
    ? { [ATTR_ESTIMATE_VALID]: true }
    : { [ATTR_ESTIMATE_VALID]: false, [ATTR_ESTIMATE_REASON]: estimate.reason };
}

export function traceVerifyOrder(verifyOrder: VerifyOrder, telemetry: Telemetry): VerifyOrder {
  return (request) =>
    inSpan(telemetry, "VerifyOrder", async (span) => {
      const estimate = await verifyOrder(request);
      // A `valid: false` estimate is a business answer, not an error.
      span.setAttributes(estimateAttributes(estimate));
      return estimate;
    });
}

export function traceInventoryReader(
  reader: InventoryReader,
  telemetry: Telemetry,
): InventoryReader {
  return {
    readInventorySnapshot: () =>
      inSpan(telemetry, "InventoryReader.readInventorySnapshot", async (span) => {
        const snapshot = await reader.readInventorySnapshot();
        span.setAttribute(ATTR_WAREHOUSE_COUNT, snapshot.length);
        return snapshot;
      }),
  };
}

/** The bounded counter/span attributes of a completed SubmitOrder call. */
export function submissionAttributes(outcome: SubmitOrderOutcome): Attributes {
  const replayed = outcome.kind === "accepted" && outcome.replayed;
  const attributes: Attributes = {
    [ATTR_SUBMISSION_OUTCOME]: outcome.kind satisfies SubmissionOutcome,
    [ATTR_SUBMISSION_REPLAYED]: replayed,
  };
  if (outcome.kind === "rejected") {
    attributes[ATTR_SUBMISSION_REJECTION_REASON] = outcome.reason;
  }
  return attributes;
}

/**
 * Traces SubmitOrder and counts `scos.order.submissions` exactly once per
 * call, whatever its outcome: new Orders, replays, rejections, conflicts,
 * `invalid`, `unavailable` and thrown errors (`error`). Retries happen inside
 * the use case, so they are never counted twice. Requests rejected by HTTP
 * validation (400) never reach the use case and are not counted.
 */
export function traceSubmitOrder(submitOrder: SubmitOrder, telemetry: Telemetry): SubmitOrder {
  return (input) =>
    inSpan(telemetry, "SubmitOrder", async (span) => {
      let outcome: SubmitOrderOutcome;
      try {
        outcome = await submitOrder(input);
      } catch (error) {
        // The span records the failure when the error leaves `inSpan`.
        telemetry.submissions.add(1, {
          [ATTR_SUBMISSION_OUTCOME]: "error" satisfies SubmissionOutcome,
          [ATTR_SUBMISSION_REPLAYED]: false,
          [ATTR_ERROR_TYPE]: sanitizeError(error).type,
        });
        throw error;
      }
      const attributes = submissionAttributes(outcome);
      span.setAttributes(attributes);
      if (outcome.kind === "unavailable") {
        // A system failure the use case could not overcome (503), unlike a
        // business rejection or conflict, which leave the status unset.
        span.setAttribute(ATTR_ERROR_TYPE, "unavailable");
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      telemetry.submissions.add(1, attributes);
      return outcome;
    });
}

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
