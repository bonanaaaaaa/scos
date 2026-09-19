/**
 * Driven port: SubmissionStore.
 *
 * What SubmitOrder needs from persistence to accept an Order atomically and
 * deduplicate submissions by the Order's unique submission key (ADR 0004).
 * Core defines the shape; `packages/persistence` implements it with SQL.
 *
 * @see docs/architecture.md, "Layers"
 * @see docs/adr/0004-deduplicate-accepted-orders.md
 * @module
 */

import type { NewOrder, Order } from "../../domain/ordering/order";
import type { SubmissionKey } from "../../domain/ordering/submission-key";
import type { InventorySnapshot } from "../../domain/shipping/allocation";

/**
 * Operations available inside one submission transaction. Every call runs on
 * the same database transaction; row locks taken by {@link lockInventory} are
 * held until it commits or rolls back.
 */
export interface SubmissionTransaction {
  /**
   * Locks ALL warehouse rows (`SELECT ... FOR UPDATE`) in ascending id order,
   * so concurrent submissions queue in the same order and cannot deadlock on
   * each other, and returns their current stock. Must be called first.
   */
  lockInventory(): Promise<InventorySnapshot>;

  /**
   * The authoritative lookup of the accepted Order stored under `key`, made
   * after {@link lockInventory}. Returns `null` when there is none. Must not
   * write or touch timestamps.
   */
  findOrderBySubmissionKey(key: SubmissionKey): Promise<Order | null>;

  /**
   * Inserts the Order and its allocations and deducts each allocated quantity
   * from its warehouse's stock. The database generates the Order `id`.
   *
   * The schema does not enforce these cross-row invariants, so the adapter
   * must verify them and throw (rolling back) if either fails: the allocations
   * sum to the Order quantity, and no allocation exceeds its warehouse's
   * locked stock (stock never goes negative).
   *
   * Returns the Order rebuilt from the persisted rows (with `restoreOrder`),
   * so the first response equals what a later repeat returns.
   *
   * Throws {@link SubmissionKeyTakenError} for a unique violation on
   * `submission_key`, and {@link TransientSubmissionError} for a unique
   * violation on `order_number`.
   */
  saveAcceptedOrder(order: NewOrder): Promise<Order>;
}

/** Everything SubmitOrder needs from persistence. */
export interface SubmissionStore {
  /**
   * An unlocked lookup outside any transaction. It is only an optional
   * short-circuit for repeats and for resolving a
   * {@link SubmissionKeyTakenError}; the locked lookup is authoritative.
   * Returns `null` when no Order has the key.
   *
   * Throws {@link TransientSubmissionError} when the lookup could not run but
   * may succeed later (for example no database connection became available
   * in time). It is a read, so nothing was written.
   */
  findOrderBySubmissionKey(key: SubmissionKey): Promise<Order | null>;

  /**
   * Runs `work` in one new READ COMMITTED transaction. Commits if `work`
   * resolves and returns its value; rolls back and rethrows if it throws.
   *
   * Database failures that may succeed on a new attempt (serialization
   * failure, deadlock, lock or statement timeout, order-number collision,
   * no connection available in time, or a failed commit that did not take
   * effect) must be thrown as
   * {@link TransientSubmissionError}. Other unexpected failures propagate
   * unchanged.
   */
  runInTransaction<T>(work: (tx: SubmissionTransaction) => Promise<T>): Promise<T>;
}

/**
 * A failure after which nothing was committed and a new attempt may succeed:
 * serialization failure (`40001`), deadlock (`40P01`), lock or statement
 * timeout (`55P03`, `57014`), a unique violation on `order_number` (a random
 * order-number collision), or no database connection available in time.
 *
 * Thrown by {@link SubmissionStore.runInTransaction} (the transaction rolled
 * back or never started; SubmitOrder retries it within its bounded number of
 * attempts) and by the unlocked {@link SubmissionStore.findOrderBySubmissionKey}
 * (a read that could not run; SubmitOrder returns `unavailable`).
 */
export class TransientSubmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientSubmissionError";
  }
}

/**
 * A unique violation (`23505`) on `submission_key` while saving: a concurrent
 * submission with the same key committed first. The transaction rolled back.
 * SubmitOrder resolves it with an unlocked lookup as a repeat or a conflict,
 * never as a server error.
 */
export class SubmissionKeyTakenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SubmissionKeyTakenError";
  }
}
