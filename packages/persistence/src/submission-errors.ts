import { SubmissionKeyTakenError, TransientSubmissionError } from "@scos/core";
import { DatabaseError } from "pg";

import { Prisma } from "#generated/prisma/client";

/**
 * Database error classification for the submission transaction.
 *
 * With the PrismaPg driver adapter, a PostgreSQL error does not reach us as a
 * pg `DatabaseError`. Prisma throws a `PrismaClientKnownRequestError` whose
 * `code` is a Prisma code (`P2010` for a failed raw query, `P2002` for a
 * unique violation from the query API, `P2034` for a write conflict or
 * deadlock), and whose `meta.driverAdapterError.cause` carries what PrismaPg
 * extracted from the pg error:
 *
 * ```text
 * { originalCode: "23505", kind: "UniqueConstraintViolation",
 *   constraint: { index: "orders_submission_key_key" }, table: "orders" }
 * ```
 *
 * Prisma's own transaction manager raises `P2028` (TransactionManagerError)
 * without a driver error. Only two of its variants are known not to have
 * committed anything, so only they are transient:
 *
 * - "Unable to start a transaction in the given time." (`maxWait` elapsed
 *   before a connection was available; nothing started), and
 * - "A {query|commit} cannot be executed on an expired transaction" (the
 *   interactive transaction outlived `timeout`; Prisma rolls it back and never
 *   sends COMMIT). Its `meta` carries numeric `timeout` and `timeTaken`.
 *
 * Every other P2028 ("transaction not found", "already closed", internal
 * consistency, invalid isolation level) is a programming or state error and
 * propagates unchanged.
 *
 * @module
 */

export const SUBMISSION_KEY_CONSTRAINT = "orders_submission_key_key";
export const ORDER_NUMBER_CONSTRAINT = "orders_order_number_key";

/**
 * SQLSTATEs after which a fresh attempt of the whole transaction may succeed:
 * serialization failure, deadlock, lock timeout, statement timeout or cancel.
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014"]);

/** P2034: Prisma's "write conflict or deadlock, please retry". */
const PRISMA_WRITE_CONFLICT = "P2034";
const PRISMA_TRANSACTION_API_ERROR = "P2028";
const TRANSACTION_START_TIMEOUT_MESSAGE = "Unable to start a transaction in the given time.";

/** The SQLSTATE and constraint of a PostgreSQL error, however it surfaced. */
export interface DatabaseErrorDetails {
  readonly sqlState: string;
  readonly constraint: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads `constraint: { index }` or `constraint: { fields }` from PrismaPg. */
function constraintOf(cause: Record<string, unknown>): string | undefined {
  const { constraint, table } = cause;
  if (!isRecord(constraint)) {
    return undefined;
  }
  if (typeof constraint.index === "string") {
    return constraint.index;
  }
  // Without pg's constraint name PrismaPg falls back to the key's columns;
  // rebuild the `<table>_<columns>_key` name the schema uses.
  const { fields } = constraint;
  if (
    typeof table === "string" &&
    Array.isArray(fields) &&
    fields.length > 0 &&
    fields.every((field) => typeof field === "string")
  ) {
    return `${table}_${fields.join("_")}_key`;
  }
  return undefined;
}

/**
 * Extracts the SQLSTATE (and constraint name, if any) from a Prisma error
 * raised through PrismaPg, or from a pg `DatabaseError` used directly.
 * Returns `undefined` for anything that is not a PostgreSQL error.
 */
export function databaseErrorDetails(error: unknown): DatabaseErrorDetails | undefined {
  if (error instanceof DatabaseError) {
    return error.code === undefined
      ? undefined
      : { sqlState: error.code, constraint: error.constraint };
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !isRecord(error.meta)) {
    return undefined;
  }
  const driverAdapterError = error.meta.driverAdapterError;
  const cause = isRecord(driverAdapterError) ? driverAdapterError.cause : undefined;
  if (!isRecord(cause) || typeof cause.originalCode !== "string") {
    return undefined;
  }
  return { sqlState: cause.originalCode, constraint: constraintOf(cause) };
}

/**
 * A P2028 that is known to have rolled back without committing.
 *
 * Pinned to Prisma 7.10.0 (`@prisma/client` runtime, TransactionManager):
 * P2028 carries no machine-readable variant, so the two safe variants are
 * recognised by their `meta` shape and message text, observed and covered by
 * unit tests and a real start-timeout integration test. Re-check both after
 * upgrading Prisma; an unrecognised P2028 falls through and propagates
 * unchanged (a server error), never a false retry.
 *
 * Why retrying them is safe:
 * - Expired transaction (`meta: { operation, timeout, timeTaken }`): Prisma
 *   checks expiry before sending the next query or COMMIT, and rolls the
 *   transaction back on timeout. COMMIT was never sent, so nothing committed.
 * - "Unable to start a transaction in the given time.": `maxWait` elapsed
 *   before a connection was acquired, so BEGIN never ran and the work never
 *   started.
 */
function isUncommittedTransactionTimeout(error: Prisma.PrismaClientKnownRequestError): boolean {
  if (error.code !== PRISMA_TRANSACTION_API_ERROR) {
    return false;
  }
  const meta = isRecord(error.meta) ? error.meta : {};
  const expired =
    (meta.operation === "query" || meta.operation === "commit") &&
    typeof meta.timeout === "number" &&
    typeof meta.timeTaken === "number";
  return expired || error.message.endsWith(TRANSACTION_START_TIMEOUT_MESSAGE);
}

/**
 * pg-pool's connection timeouts (`connectionTimeoutMillis`). PrismaPg passes
 * these non-PostgreSQL errors through unchanged, so they arrive as plain
 * `Error`s recognisable only by message (pinned to pg 8.23.0 / pg-pool 3;
 * re-check after upgrading pg):
 *
 * - "timeout exceeded when trying to connect": every pooled client was busy
 *   for the whole wait.
 * - "Connection terminated due to connection timeout": a new connection was
 *   not established in time.
 *
 * Either way no statement was sent on that connection, so nothing can have
 * committed and a new attempt is safe. No client-side query timeout is
 * configured or classified: pg abandons a timed-out query without closing the
 * connection, which can leave a transaction open on a pooled connection.
 */
export const PG_CONNECTION_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
]);

function isPgConnectionTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    !(error instanceof Prisma.PrismaClientKnownRequestError) &&
    PG_CONNECTION_TIMEOUT_MESSAGES.has(error.message)
  );
}

/**
 * Maps a failure inside, or at the boundary of, the submission transaction to
 * the port's typed errors:
 *
 * - `23505` on `orders_submission_key_key` → {@link SubmissionKeyTakenError}
 * - `23505` on `orders_order_number_key` → {@link TransientSubmissionError}
 * - `40001`, `40P01`, `55P03`, `57014`, Prisma `P2034`, and the uncommitted
 *   P2028 timeouts → {@link TransientSubmissionError}
 * - pg connection timeouts ({@link PG_CONNECTION_TIMEOUT_MESSAGES}) →
 *   {@link TransientSubmissionError}
 *
 * The original error is kept as `cause`. Anything else, including errors that
 * are already typed, is returned unchanged: it is never swallowed.
 */
export function classifySubmissionError(error: unknown): unknown {
  if (error instanceof SubmissionKeyTakenError || error instanceof TransientSubmissionError) {
    return error;
  }
  if (isPgConnectionTimeout(error)) {
    return new TransientSubmissionError(
      "No database connection was available in time; nothing was sent or committed.",
      { cause: error },
    );
  }
  const details = databaseErrorDetails(error);
  if (details !== undefined) {
    if (details.sqlState === "23505" && details.constraint === SUBMISSION_KEY_CONSTRAINT) {
      return new SubmissionKeyTakenError(
        "A concurrent submission already stored an Order with this submission key.",
        { cause: error },
      );
    }
    if (details.sqlState === "23505" && details.constraint === ORDER_NUMBER_CONSTRAINT) {
      return new TransientSubmissionError("The generated order number is already in use.", {
        cause: error,
      });
    }
    if (TRANSIENT_SQLSTATES.has(details.sqlState)) {
      return new TransientSubmissionError(
        `The submission transaction failed transiently (SQLSTATE ${details.sqlState}).`,
        { cause: error },
      );
    }
    return error;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === PRISMA_WRITE_CONFLICT) {
      return new TransientSubmissionError(
        "The submission transaction hit a write conflict or deadlock.",
        { cause: error },
      );
    }
    if (isUncommittedTransactionTimeout(error)) {
      return new TransientSubmissionError(
        "The submission transaction timed out before it committed.",
        { cause: error },
      );
    }
  }
  return error;
}
