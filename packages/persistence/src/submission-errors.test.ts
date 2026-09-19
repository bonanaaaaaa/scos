import { SubmissionKeyTakenError, TransientSubmissionError } from "@scos/core";
import { DatabaseError } from "pg";
import { describe, expect, test } from "vitest";

import { Prisma } from "./generated/prisma/client";
import { classifySubmissionError, databaseErrorDetails } from "./submission-errors";

// Shapes observed from Prisma 7.10 with @prisma/adapter-pg against PostgreSQL
// 18 (see the integration suite): the pg error is converted by PrismaPg into
// `meta.driverAdapterError.cause`.
function prismaError(code: string, meta: Record<string, unknown>, message = "Prisma error") {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "7.10.0",
    meta,
  });
}

function driverError(prismaCode: string, cause: Record<string, unknown>) {
  const driverAdapterError = Object.assign(new Error(String(cause.kind)), { cause });
  return prismaError(prismaCode, { driverAdapterError });
}

const uniqueViolation = (constraint: Record<string, unknown>, prismaCode = "P2010") =>
  driverError(prismaCode, {
    originalCode: "23505",
    originalMessage: "duplicate key value violates unique constraint",
    kind: "UniqueConstraintViolation",
    constraint,
    table: "orders",
  });

const postgresError = (sqlState: string, kind = "postgres") =>
  driverError("P2010", { originalCode: sqlState, originalMessage: "failed", kind });

function pgDatabaseError(code: string | undefined, constraint?: string) {
  const error = new DatabaseError("failed", 0, "error");
  if (code !== undefined) {
    error.code = code;
  }
  if (constraint !== undefined) {
    error.constraint = constraint;
  }
  return error;
}

describe("databaseErrorDetails", () => {
  test("reads the SQLSTATE and constraint that PrismaPg attached to a Prisma error", () => {
    expect(databaseErrorDetails(uniqueViolation({ index: "orders_submission_key_key" }))).toEqual({
      sqlState: "23505",
      constraint: "orders_submission_key_key",
    });
    expect(databaseErrorDetails(postgresError("55P03"))).toEqual({
      sqlState: "55P03",
      constraint: undefined,
    });
  });

  test("rebuilds the unique constraint name when PrismaPg only reports the columns", () => {
    expect(databaseErrorDetails(uniqueViolation({ fields: ["order_number"] }))).toEqual({
      sqlState: "23505",
      constraint: "orders_order_number_key",
    });
    expect(databaseErrorDetails(uniqueViolation({ fields: [] }))?.constraint).toBeUndefined();
    expect(databaseErrorDetails(uniqueViolation({ fields: [1] }))?.constraint).toBeUndefined();
    expect(
      databaseErrorDetails(
        driverError("P2010", {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { fields: ["submission_key"] },
        }),
      )?.constraint,
    ).toBeUndefined();
    expect(databaseErrorDetails(uniqueViolation({}))?.constraint).toBeUndefined();
  });

  test("reads a pg DatabaseError used directly", () => {
    expect(databaseErrorDetails(pgDatabaseError("23505", "orders_submission_key_key"))).toEqual({
      sqlState: "23505",
      constraint: "orders_submission_key_key",
    });
    expect(databaseErrorDetails(pgDatabaseError(undefined))).toBeUndefined();
  });

  test("returns undefined for errors that carry no PostgreSQL error", () => {
    expect(databaseErrorDetails(new Error("boom"))).toBeUndefined();
    expect(databaseErrorDetails("boom")).toBeUndefined();
    expect(databaseErrorDetails(prismaError("P2028", {}))).toBeUndefined();
    expect(
      databaseErrorDetails(prismaError("P2010", { driverAdapterError: { cause: "text" } })),
    ).toBeUndefined();
    expect(
      databaseErrorDetails(prismaError("P2010", { driverAdapterError: { cause: { kind: "x" } } })),
    ).toBeUndefined();
  });
});

describe("classifySubmissionError", () => {
  test("a unique violation on submission_key means another submission took the key", () => {
    for (const error of [
      uniqueViolation({ index: "orders_submission_key_key" }),
      uniqueViolation({ index: "orders_submission_key_key" }, "P2002"),
      uniqueViolation({ fields: ["submission_key"] }),
      pgDatabaseError("23505", "orders_submission_key_key"),
    ]) {
      const classified = classifySubmissionError(error);
      expect(classified).toBeInstanceOf(SubmissionKeyTakenError);
      expect((classified as Error).cause).toBe(error);
    }
  });

  test("a unique violation on order_number is a transient collision", () => {
    const error = uniqueViolation({ index: "orders_order_number_key" });
    const classified = classifySubmissionError(error);
    expect(classified).toBeInstanceOf(TransientSubmissionError);
    expect((classified as Error).cause).toBe(error);
  });

  test("serialization failures, deadlocks, and lock or statement timeouts are transient", () => {
    for (const error of [
      postgresError("40001", "TransactionWriteConflict"),
      postgresError("40P01", "TransactionWriteConflict"),
      driverError("P2034", { originalCode: "40001", kind: "TransactionWriteConflict" }),
      postgresError("55P03"),
      postgresError("57014"),
      pgDatabaseError("40P01"),
    ]) {
      expect(classifySubmissionError(error)).toBeInstanceOf(TransientSubmissionError);
    }
  });

  test("a Prisma write conflict without driver details is transient", () => {
    expect(classifySubmissionError(prismaError("P2034", {}))).toBeInstanceOf(
      TransientSubmissionError,
    );
  });

  test("interactive-transaction timeouts that never committed are transient", () => {
    const expiredAtCommit = prismaError(
      "P2028",
      { operation: "commit", timeout: 300, timeTaken: 2006 },
      "Transaction API error: A commit cannot be executed on an expired transaction.",
    );
    const expiredAtQuery = prismaError("P2028", {
      operation: "query",
      timeout: 200,
      timeTaken: 506,
    });
    const notStarted = prismaError(
      "P2028",
      {},
      "Transaction API error: Unable to start a transaction in the given time.",
    );
    for (const error of [expiredAtCommit, expiredAtQuery, notStarted]) {
      expect(classifySubmissionError(error)).toBeInstanceOf(TransientSubmissionError);
    }
  });

  test("other transaction API errors propagate unchanged", () => {
    for (const error of [
      prismaError(
        "P2028",
        {},
        "Transaction API error: Transaction already closed: A commit cannot be executed on a committed transaction.",
      ),
      prismaError("P2028", { operation: "commit" }),
      prismaError("P2028", { operation: "rollback", timeout: 1, timeTaken: 2 }),
      prismaError("P2028", { isolationLevel: "Chaos" }),
      Object.assign(prismaError("P2028", {}), { meta: undefined }),
    ]) {
      expect(classifySubmissionError(error)).toBe(error);
    }
  });

  test("every other failure propagates unchanged", () => {
    const failures = [
      uniqueViolation({ index: "order_allocations_order_id_warehouse_id_key" }),
      postgresError("23514"),
      postgresError("P0001"),
      pgDatabaseError("22012"),
      prismaError("P2025", {}),
      new Error("allocations do not sum"),
      "not an error",
    ];
    for (const error of failures) {
      expect(classifySubmissionError(error)).toBe(error);
    }
  });

  test("already typed port errors pass through as they are", () => {
    const taken = new SubmissionKeyTakenError("taken");
    const transient = new TransientSubmissionError("transient");
    expect(classifySubmissionError(taken)).toBe(taken);
    expect(classifySubmissionError(transient)).toBe(transient);
  });
});
