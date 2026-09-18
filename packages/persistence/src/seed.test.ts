import assert from "node:assert/strict";
import { test } from "vitest";

import { runConfirmResetCommand, runSeedCommand } from "./commands.js";
import { confirmDatabaseReset } from "./reset.js";
import { seedWarehouses, warehouseSeeds } from "./seed.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("seed data matches the six PRD warehouses with stable UUIDv7 IDs", () => {
  assert.deepEqual(
    warehouseSeeds.map(({ name, latitude, longitude, stock }) => [
      name,
      latitude,
      longitude,
      stock,
    ]),
    [
      ["Los Angeles", 33.9425, -118.408056, 355],
      ["New York", 40.639722, -73.778889, 578],
      ["São Paulo", -23.435556, -46.473056, 265],
      ["Paris", 49.009722, 2.547778, 694],
      ["Warsaw", 52.165833, 20.967222, 245],
      ["Hong Kong", 22.308889, 113.914444, 419],
    ],
  );
  for (const seed of warehouseSeeds) {
    assert.match(seed.id, uuidV7);
  }
  assert.equal(new Set(warehouseSeeds.map((seed) => seed.id)).size, 6);
  assert.deepEqual(
    warehouseSeeds.map((seed) => seed.id),
    warehouseSeeds.map((seed) => seed.id).toSorted(),
    "seed IDs sort in PRD order",
  );
  assert.ok(Object.isFrozen(warehouseSeeds));
});

test("seeding inserts only missing warehouses and never updates existing stock", async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const result = await seedWarehouses({
    query: async (text, values) => {
      calls.push({ text, values });
      return { rowCount: 2 };
    },
  });

  assert.deepEqual(result, { inserted: 2, existing: 4 });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.match(call.text, /INSERT INTO warehouse \(id, name, latitude, longitude, stock\)/);
  assert.match(call.text, /ON CONFLICT \(id\) DO NOTHING\s*$/);
  assert.doesNotMatch(call.text, /UPDATE|DO UPDATE/i);
  assert.equal(call.values.length, 30);
  assert.deepEqual(call.values.slice(0, 5), [
    "01996000-0000-7000-8000-000000000001",
    "Los Angeles",
    33.9425,
    -118.408056,
    355,
  ]);
  assert.match(call.text, /\(\$26::uuid, \$27, \$28::double precision/);

  const unknownCount = await seedWarehouses({ query: async () => ({ rowCount: null }) });
  assert.deepEqual(unknownCount, { inserted: 0, existing: 6 });
});

test("the seed command reports the result and always ends its pool", async () => {
  const messages: string[] = [];
  let ended = 0;
  await runSeedCommand({
    createPool: () => ({
      query: async () => ({ rowCount: 6 }),
      end: async () => {
        ended += 1;
      },
    }),
    log: (message) => messages.push(message),
  });
  assert.deepEqual(messages, [
    "Seeded warehouses: 6 inserted, 0 already present (stock unchanged).",
  ]);
  assert.equal(ended, 1);

  await assert.rejects(
    runSeedCommand({
      createPool: () => ({
        query: async () => {
          throw new Error("connection refused");
        },
        end: async () => {
          ended += 1;
        },
      }),
      log: () => assert.fail("must not report success"),
    }),
    /connection refused/,
  );
  assert.equal(ended, 2);
});

test("database reset refuses without an exact confirmation of the target database", () => {
  const url = "postgresql://scos:secret@localhost:5432/scos_wt_abc";
  assert.throws(() => confirmDatabaseReset({}), /DATABASE_URL is required/);
  assert.throws(
    () => confirmDatabaseReset({ DATABASE_URL: url }),
    /Refusing to reset database "scos_wt_abc"/,
  );
  assert.throws(
    () => confirmDatabaseReset({ DATABASE_URL: url, SCOS_CONFIRM_DATABASE_RESET: "1" }),
    /SCOS_CONFIRM_DATABASE_RESET=scos_wt_abc/,
  );
  assert.throws(
    () => confirmDatabaseReset({ DATABASE_URL: url, SCOS_CONFIRM_DATABASE_RESET: "scos" }),
    /Refusing/,
  );
  assert.throws(
    () => confirmDatabaseReset({ DATABASE_URL: "not a url", SCOS_CONFIRM_DATABASE_RESET: "x" }),
    /valid PostgreSQL connection URL/,
  );
  assert.throws(
    () =>
      confirmDatabaseReset({
        DATABASE_URL: "postgresql://scos@localhost:5432",
        SCOS_CONFIRM_DATABASE_RESET: "",
      }),
    /must name the database/,
  );
  assert.equal(
    confirmDatabaseReset({ DATABASE_URL: url, SCOS_CONFIRM_DATABASE_RESET: "scos_wt_abc" }),
    "scos_wt_abc",
  );
  const secretFree: string[] = [];
  runConfirmResetCommand(
    { DATABASE_URL: url, SCOS_CONFIRM_DATABASE_RESET: "scos_wt_abc" },
    (message) => secretFree.push(message),
  );
  assert.deepEqual(secretFree, ['Confirmed destructive reset of database "scos_wt_abc".']);
  assert.throws(() => runConfirmResetCommand({ DATABASE_URL: url }), /Refusing/);
});
