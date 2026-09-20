/**
 * The suite's own foundation: that the global setup really did start a served
 * API over a migrated, seeded database, and that this app reaches it only
 * over HTTP and PostgreSQL.
 *
 * Every other file assumes this; when it fails, the failure is in the
 * harness, not in the API.
 *
 * @module
 */

import { readFile } from "node:fs/promises";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { WAREHOUSES } from "#test/support/prd";
import { get } from "#test/support/http";
import { openPool, resetDatabase, stockById } from "#test/support/database";
import { acceptanceDatabaseUrl, sharedApi } from "#test/support/shared-api";

const api = sharedApi();
let pool: Pool;

beforeAll(async () => {
  pool = openPool(acceptanceDatabaseUrl());
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("the served API under test", () => {
  test("answers GET /health over HTTP", async () => {
    const result = await get(api, "/health");
    expect(result.status, result.text).toBe(200);
    expect(result.json()).toStrictEqual({ status: "ok" });
  });

  test("runs over a database seeded with the six PRD warehouses", async () => {
    const stock = await stockById(pool);
    expect(Object.keys(stock)).toHaveLength(WAREHOUSES.length);
    for (const warehouse of WAREHOUSES) {
      expect(stock[warehouse.id], warehouse.name).toBe(warehouse.stock);
    }
  });

  test("is reached over a base URL, by an app that depends on no API package", async () => {
    expect(api.baseUrl).toMatch(/^https?:\/\//);
    // The boundary this suite exists to hold: its manifest must not be able to
    // resolve the API or the domain, so no test can import them by accident.
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared).not.toContain("@scos/api");
    expect(declared).not.toContain("@scos/core");
  });
});
