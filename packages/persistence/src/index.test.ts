import assert from "node:assert/strict";
import test from "node:test";

import { persistencePackage, readDatabaseUrl } from "./index.js";

test("the persistence adapter points inward to ordering", () => {
  assert.deepEqual(persistencePackage, { name: "persistence", supports: "ordering" });
});

test("database configuration fails clearly when missing", () => {
  assert.throws(() => readDatabaseUrl({}), /DATABASE_URL is required/);
});
