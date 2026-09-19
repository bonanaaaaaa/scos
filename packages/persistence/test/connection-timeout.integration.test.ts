import { TransientSubmissionError, submissionKeySchema } from "@scos/core";
import { describe, expect, test } from "vitest";

import { createDatabasePool } from "../src/database";
import { createPrismaClient } from "../src/prisma";
import { classifySubmissionError } from "../src/submission-errors";
import { createPrismaSubmissionStore } from "../src/submission-store";
import { requireTestDatabaseUrl } from "./support/database";

// Real pg-pool behaviour: with its only connection checked out, the next
// checkout waits connectionTimeoutMillis and fails before any statement is
// sent on a connection, so the failure is safe to retry.
describe("pool connection timeout against real PostgreSQL", { timeout: 30_000 }, () => {
  test("'timeout exceeded when trying to connect' is a transient submission failure", async () => {
    const pool = createDatabasePool(requireTestDatabaseUrl(), {
      max: 1,
      connectionTimeoutMillis: 200,
    });
    const prisma = createPrismaClient(pool);
    const held = await pool.connect();
    try {
      await held.query("SELECT 1");

      const raw: unknown = await pool.connect().then(
        (client) => {
          client.release();
          return expect.fail("the pool handed out a second connection");
        },
        (error: unknown) => error,
      );
      expect(raw).toBeInstanceOf(Error);
      expect((raw as Error).message).toBe("timeout exceeded when trying to connect");
      expect(classifySubmissionError(raw)).toBeInstanceOf(TransientSubmissionError);

      // The same failure through Prisma and the submission store.
      const store = createPrismaSubmissionStore(prisma, { maxWaitMs: 5_000 });
      const lookup: unknown = await store
        .findOrderBySubmissionKey(submissionKeySchema.parse("pool-timeout-1"))
        .catch((error: unknown) => error);
      expect(lookup).toBeInstanceOf(TransientSubmissionError);
      expect(((lookup as Error).cause as Error).message).toBe(
        "timeout exceeded when trying to connect",
      );
      const attempt: unknown = await store
        .runInTransaction(async () => "never runs")
        .catch((error: unknown) => error);
      expect(attempt).toBeInstanceOf(TransientSubmissionError);
      expect(((attempt as Error).cause as Error).message).toBe(
        "timeout exceeded when trying to connect",
      );
    } finally {
      held.release();
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
