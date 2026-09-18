import assert from "node:assert/strict";
import { test } from "vitest";

import { createDatabasePool, persistencePackage, readDatabaseUrl } from "./index.js";

test("the persistence adapter points inward to ordering", () => {
  assert.deepEqual(persistencePackage, { name: "persistence", supports: "ordering" });
});

test("database configuration fails clearly when missing", () => {
  assert.throws(() => readDatabaseUrl({}), /DATABASE_URL is required/);
  assert.throws(() => readDatabaseUrl({ DATABASE_URL: "" }), /DATABASE_URL is required/);
});

test("database pools use the configured connection string without connecting eagerly", async () => {
  const connectionString = "postgresql://example:example@localhost:5432/example";
  const pool = createDatabasePool(connectionString);

  try {
    assert.equal(pool.options.connectionString, connectionString);
  } finally {
    await pool.end();
  }
});
