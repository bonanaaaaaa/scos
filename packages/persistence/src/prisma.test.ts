import assert from "node:assert/strict";
import { test } from "vitest";

import { createDatabasePool } from "./database.js";
import { createPrismaClient } from "./prisma.js";

test("Prisma uses the caller's pool and leaves ending it to the caller", async () => {
  const pool = createDatabasePool("postgresql://example:example@localhost:5432/example");
  try {
    const prisma = createPrismaClient(pool);
    await prisma.$disconnect();
    assert.equal(pool.ended, false);
  } finally {
    await pool.end();
  }
  assert.equal(pool.ended, true);
});
