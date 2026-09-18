import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { seedWarehouses, warehouseSeeds } from "../src/seed.js";
import {
  assertDatabaseError,
  createMigratedDatabase,
  type MigratedDatabase,
  packageDirectory,
} from "./support/database.js";

const execFileAsync = promisify(execFile);

// The six PRD warehouses, written out independently of the seed module.
const prdWarehouses = [
  { name: "Los Angeles", latitude: 33.9425, longitude: -118.408056, stock: 355 },
  { name: "New York", latitude: 40.639722, longitude: -73.778889, stock: 578 },
  { name: "São Paulo", latitude: -23.435556, longitude: -46.473056, stock: 265 },
  { name: "Paris", latitude: 49.009722, longitude: 2.547778, stock: 694 },
  { name: "Warsaw", latitude: 52.165833, longitude: 20.967222, stock: 245 },
  { name: "Hong Kong", latitude: 22.308889, longitude: 113.914444, stock: 419 },
];

let db: MigratedDatabase;

function runBuiltCommand(script: string, environment: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, [script], {
    cwd: packageDirectory,
    env: environment,
    timeout: 30_000,
  });
}

async function readWarehouses() {
  const result = await db.pool.query<{
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    stock: number;
    version: number;
    fresh: boolean;
  }>(
    `SELECT id, name, latitude, longitude, stock, uuid_extract_version(id) AS version,
            created_at = updated_at AS fresh
     FROM warehouse ORDER BY id`,
  );
  return result.rows;
}

describe("warehouse seed", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = await createMigratedDatabase();
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  test("the db:seed command inserts exactly the six PRD warehouses with stable UUIDv7 IDs", async () => {
    const { stdout } = await runBuiltCommand("dist/bin/seed.js", {
      ...process.env,
      DATABASE_URL: db.url,
    });
    expect(stdout).toMatch(/6 inserted, 0 already present/);

    const rows = await readWarehouses();
    expect(
      rows.map(({ name, latitude, longitude, stock }) => ({ name, latitude, longitude, stock })),
    ).toStrictEqual(prdWarehouses);
    expect(rows.map((row) => row.id)).toStrictEqual(warehouseSeeds.map((seed) => seed.id));
    expect(rows.every((row) => row.version === 7 && row.fresh)).toBe(true);
  });

  test("rerunning the seed never replenishes consumed stock or touches existing rows", async () => {
    await db.pool.query("UPDATE warehouse SET stock = stock - 55 WHERE name = 'Los Angeles'");
    await db.pool.query("UPDATE warehouse SET stock = 0 WHERE name = 'Warsaw'");
    const before = await db.pool.query(
      "SELECT id, stock, created_at, updated_at FROM warehouse ORDER BY id",
    );

    expect(await seedWarehouses(db.pool)).toStrictEqual({ inserted: 0, existing: 6 });
    const { stdout } = await runBuiltCommand("dist/bin/seed.js", {
      ...process.env,
      DATABASE_URL: db.url,
    });
    expect(stdout).toMatch(/0 inserted, 6 already present/);

    const after = await db.pool.query(
      "SELECT id, stock, created_at, updated_at FROM warehouse ORDER BY id",
    );
    expect(after.rows).toStrictEqual(before.rows);
    const stock = Object.fromEntries((await readWarehouses()).map((row) => [row.name, row.stock]));
    expect(stock["Los Angeles"]).toBe(300);
    expect(stock["Warsaw"]).toBe(0);
    expect(stock["Paris"]).toBe(694);
  });

  test("a rerun restores only a missing warehouse and fails loudly on a conflicting name", async () => {
    await db.pool.query("DELETE FROM warehouse WHERE name = 'Hong Kong'");
    expect(await seedWarehouses(db.pool)).toStrictEqual({ inserted: 1, existing: 5 });
    expect((await readWarehouses()).length).toBe(6);

    await db.pool.query("DELETE FROM warehouse WHERE name = 'Paris'");
    await db.pool.query(
      "INSERT INTO warehouse (name, latitude, longitude, stock) VALUES ('Paris', 0, 0, 1)",
    );
    await assertDatabaseError(seedWarehouses(db.pool), {
      code: "23505",
      constraint: "warehouse_name_key",
    });
    const paris = await db.pool.query("SELECT stock FROM warehouse WHERE name = 'Paris'");
    expect(paris.rows).toStrictEqual([{ stock: 1 }]);
  });

  test("the reset guard refuses without an exact confirmation and changes nothing", async () => {
    const count = async () =>
      (await db.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM warehouse"))
        .rows[0]!.count;
    const before = await count();

    for (const confirmation of [undefined, "yes", "scos_test"]) {
      const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: db.url };
      delete environment.SCOS_CONFIRM_DATABASE_RESET;
      if (confirmation !== undefined) {
        environment.SCOS_CONFIRM_DATABASE_RESET = confirmation;
      }
      await expect(runBuiltCommand("dist/bin/confirm-reset.js", environment)).rejects.toMatchObject(
        {
          code: 1,
          stderr: expect.stringMatching(new RegExp(`Refusing to reset database "${db.name}"`)),
        },
      );
    }

    const { stdout } = await runBuiltCommand("dist/bin/confirm-reset.js", {
      ...process.env,
      DATABASE_URL: db.url,
      SCOS_CONFIRM_DATABASE_RESET: db.name,
    });
    expect(stdout).toMatch(/Confirmed destructive reset/);
    expect(await count()).toBe(before);
  });
});
