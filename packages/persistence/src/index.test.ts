import { describe, expect, test } from "vitest";

import {
  createDatabasePool,
  createPrismaInventoryReader,
  persistencePackage,
  readDatabaseUrl,
} from "./index";
import { createPrismaInventoryReader as inventoryReaderFactory } from "./inventory-reader";

describe("@scos/persistence", () => {
  test("the package root exposes the inventory reader adapter", () => {
    expect(createPrismaInventoryReader).toBe(inventoryReaderFactory);
  });

  test("the persistence adapter points inward to core", () => {
    expect(persistencePackage).toStrictEqual({ name: "persistence", supports: "core" });
  });

  test("database configuration fails clearly when missing", () => {
    expect(() => readDatabaseUrl({})).toThrow(/DATABASE_URL is required/);
    expect(() => readDatabaseUrl({ DATABASE_URL: "" })).toThrow(/DATABASE_URL is required/);
  });

  test("database pools use the configured connection string without connecting eagerly", async () => {
    const connectionString = "postgresql://example:example@localhost:5432/example";
    const pool = createDatabasePool(connectionString);

    try {
      expect(pool.options.connectionString).toBe(connectionString);
    } finally {
      await pool.end();
    }
  });
});
