import { DatabaseError } from "pg";
import { expect } from "vitest";

// The database harness lives in src/testing.ts so other packages can share it
// through `@scos/persistence/testing`. Only the vitest-dependent helpers stay here.
export {
  createMigratedDatabase,
  type MigratedDatabase,
  packageDirectory,
  readPersistedState,
  requireTestDatabaseUrl,
  runPrisma,
} from "../../src/testing";

/** Asserts that a query fails with the given SQLSTATE and constraint name. */
export async function assertDatabaseError(
  operation: Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  const error: unknown = await operation.then(
    () => expect.fail(`expected a PostgreSQL error ${expected.code}, but the operation resolved`),
    (reason: unknown) => reason,
  );
  expect(error, `expected a PostgreSQL error, got ${String(error)}`).toBeInstanceOf(DatabaseError);
  // Unreachable after the expect above; narrows the type for TypeScript.
  if (!(error instanceof DatabaseError)) {
    throw new TypeError(`expected a PostgreSQL error, got ${String(error)}`);
  }
  expect(error.code, error.message).toBe(expected.code);
  if (expected.constraint !== undefined) {
    expect(error.constraint, error.message).toBe(expected.constraint);
  }
}
