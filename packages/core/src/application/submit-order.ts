/**
 * Use case: SubmitOrder.
 *
 * Accepts or rejects an order submission atomically against current stock, and
 * deduplicates submissions by the client's `submissionId`, stored as the
 * accepted Order's unique submission key (ADR 0004). Only accepted Orders are
 * stored; rejections are returned and consume no key.
 *
 * Outcomes are application results, never HTTP statuses; the inbound adapter
 * maps them. DomainError and unexpected errors are thrown.
 *
 * @see docs/architecture.md, "Layers"
 * @see docs/adr/0004-deduplicate-accepted-orders.md
 * @module
 */

import { z } from "zod";

import {
  type InsufficientStockEstimate,
  type ShippingExceedsLimitEstimate,
  estimateOrder,
} from "#domain/ordering/estimate";
import { type Order, createOrder, hasSameRequest } from "#domain/ordering/order";
import { generateOrderNumber as randomOrderNumber } from "#domain/ordering/order-number";
import { type OrderRequest, orderRequestSchema } from "#domain/ordering/order-request";
import { type SubmissionKey, submissionKeySchema } from "#domain/ordering/submission-key";
import { latitudeSchema, longitudeSchema } from "#domain/shared/destination";
import { quantitySchema } from "#domain/shared/quantity";

import {
  type SubmissionStore,
  type SubmissionTransaction,
  SubmissionKeyTakenError,
  TransientSubmissionError,
} from "#application/ports/submission-store";

/**
 * Total transaction attempts per submission when an attempt fails with a
 * transient error (serialization failure, deadlock, lock timeout, order-number
 * collision). Business rejections are never retried. After the last attempt
 * the outcome is `unavailable`; nothing was committed, so the key stays
 * reusable.
 */
export const MAX_SUBMISSION_ATTEMPTS = 3;

/** The raw submission a caller passes in; validated before any port call. */
export interface SubmitOrderInput {
  readonly submissionId: string;
  readonly quantity: number;
  readonly latitude: number;
  readonly longitude: number;
}

export type SubmitOrderIssue = z.core.$ZodIssue;

/** A new Order (`replayed: false`) or the existing Order for a repeat (`true`). */
export interface AcceptedSubmission {
  readonly kind: "accepted";
  readonly order: Order;
  readonly replayed: boolean;
}

/** A business rejection against current stock; nothing was stored. */
export interface RejectedSubmission {
  readonly kind: "rejected";
  readonly reason: "INSUFFICIENT_STOCK" | "SHIPPING_EXCEEDS_LIMIT";
  readonly estimate: InsufficientStockEstimate | ShippingExceedsLimitEstimate;
}

/**
 * The submission key already belongs to an Order with a different quantity or
 * destination. That Order is unchanged. None of its details (order number or
 * amounts) are included, so reusing someone else's key reveals nothing.
 */
export interface ConflictingSubmission {
  readonly kind: "conflict";
  readonly submissionKey: SubmissionKey;
}

/** Malformed input: every problem, each with its `path`. No port was called. */
export interface InvalidSubmission {
  readonly kind: "invalid";
  readonly issues: readonly SubmitOrderIssue[];
}

/**
 * A transient failure SubmitOrder could not overcome; this request committed
 * nothing. The key stays reusable unless a concurrent request with the same
 * key committed its Order first, in which case a retry returns that Order (or
 * a conflict). Either every transaction attempt failed
 * transiently, or an unlocked lookup of the key failed transiently.
 */
export interface UnavailableSubmission {
  readonly kind: "unavailable";
  /** Transaction attempts made (0 when the initial lookup failed). */
  readonly attempts: number;
}

export type SubmitOrderOutcome =
  | AcceptedSubmission
  | RejectedSubmission
  | ConflictingSubmission
  | InvalidSubmission
  | UnavailableSubmission;

export interface SubmitOrderDependencies {
  readonly store: SubmissionStore;
  /** Defaults to the random `SO-` + 12 Crockford base32 generator. */
  readonly generateOrderNumber?: () => string;
  /** Total attempts for transient failures; defaults to {@link MAX_SUBMISSION_ATTEMPTS}. */
  readonly maxAttempts?: number;
}

export type SubmitOrder = (input: unknown) => Promise<SubmitOrderOutcome>;

/**
 * Validates `{ submissionId, quantity, latitude, longitude }` in one pass so
 * every malformed field is reported with its path.
 */
const submitOrderInputSchema = z
  .object({
    submissionId: submissionKeySchema,
    quantity: quantitySchema,
    latitude: latitudeSchema,
    longitude: longitudeSchema,
  })
  .transform(({ submissionId, quantity, latitude, longitude }) => ({
    submissionKey: submissionId,
    // Already validated field by field; parsing again builds the OrderRequest.
    request: orderRequestSchema.parse({ quantity, latitude, longitude }),
  }));

const UNAVAILABLE = Symbol("unavailable");

/**
 * The unlocked lookup, with a {@link TransientSubmissionError} (a read that
 * could not run) reported as {@link UNAVAILABLE} instead of thrown.
 */
async function unlockedLookup(
  store: SubmissionStore,
  submissionKey: SubmissionKey,
): Promise<Order | null | typeof UNAVAILABLE> {
  try {
    return await store.findOrderBySubmissionKey(submissionKey);
  } catch (error) {
    if (error instanceof TransientSubmissionError) {
      return UNAVAILABLE;
    }
    throw error;
  }
}

function unavailable(attempts: number): UnavailableSubmission {
  return Object.freeze({ kind: "unavailable", attempts });
}

/** The same key with the same quantity and destination is a repeat. */
function resolveExisting(
  existing: Order,
  submissionKey: SubmissionKey,
  request: OrderRequest,
): AcceptedSubmission | ConflictingSubmission {
  return hasSameRequest(existing, request)
    ? Object.freeze({ kind: "accepted", order: existing, replayed: true })
    : Object.freeze({ kind: "conflict", submissionKey });
}

/**
 * Creates the SubmitOrder use case.
 *
 * 1. Validate the input; malformed input is `invalid` before any port call.
 * 2. Unlocked lookup: an existing Order short-circuits to a repeat or conflict.
 * 3. In one transaction: lock all warehouse rows, look the key up again
 *    (authoritative), estimate against the locked stock, and either return the
 *    rejection (nothing written) or save the new Order and deduct stock.
 * 4. Retry transient failures up to `maxAttempts` in total, then `unavailable`.
 * 5. If a concurrent submission took the key first, resolve it by looking the
 *    winner up; if it is not visible yet, treat the attempt as transient.
 * 6. If either unlocked lookup fails transiently, return `unavailable`.
 */
export function createSubmitOrder(dependencies: SubmitOrderDependencies): SubmitOrder {
  const {
    store,
    generateOrderNumber = randomOrderNumber,
    maxAttempts = MAX_SUBMISSION_ATTEMPTS,
  } = dependencies;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer.");
  }

  async function attempt(
    tx: SubmissionTransaction,
    submissionKey: SubmissionKey,
    request: OrderRequest,
  ): Promise<SubmitOrderOutcome> {
    const inventory = await tx.lockInventory();
    const existing = await tx.findOrderBySubmissionKey(submissionKey);
    if (existing !== null) {
      return resolveExisting(existing, submissionKey, request);
    }

    const estimate = estimateOrder(request, inventory);
    if (!estimate.valid) {
      return Object.freeze({ kind: "rejected", reason: estimate.reason, estimate });
    }

    const order = createOrder({
      orderNumber: generateOrderNumber(),
      submissionKey,
      estimate,
    });
    const saved = await tx.saveAcceptedOrder(order);
    return Object.freeze({ kind: "accepted", order: saved, replayed: false });
  }

  return async function submitOrder(input: unknown): Promise<SubmitOrderOutcome> {
    const parsed = submitOrderInputSchema.safeParse(input);
    if (!parsed.success) {
      return Object.freeze({ kind: "invalid", issues: Object.freeze([...parsed.error.issues]) });
    }
    const { submissionKey, request } = parsed.data;

    const existing = await unlockedLookup(store, submissionKey);
    if (existing === UNAVAILABLE) {
      return unavailable(0);
    }
    if (existing !== null) {
      return resolveExisting(existing, submissionKey, request);
    }

    for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
      try {
        return await store.runInTransaction((tx) => attempt(tx, submissionKey, request));
      } catch (error) {
        if (error instanceof SubmissionKeyTakenError) {
          const winner = await unlockedLookup(store, submissionKey);
          if (winner === UNAVAILABLE) {
            // Our attempt rolled back; the winner cannot be read right now.
            return unavailable(attempts);
          }
          if (winner !== null) {
            return resolveExisting(winner, submissionKey, request);
          }
          // Not visible yet: retry like any other transient failure.
        } else if (!(error instanceof TransientSubmissionError)) {
          throw error;
        }
      }
    }
    return unavailable(maxAttempts);
  };
}
