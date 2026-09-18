import { expect, test } from "vitest";

import { runConfirmResetCommand, runSeedCommand } from "./commands.js";
import { confirmDatabaseReset } from "./reset.js";
import { seedWarehouses, warehouseSeeds } from "./seed.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("seed data matches the six PRD warehouses with stable UUIDv7 IDs", () => {
  expect(
    warehouseSeeds.map(({ name, latitude, longitude, stock }) => [
      name,
      latitude,
      longitude,
      stock,
    ]),
  ).toStrictEqual([
    ["Los Angeles", 33.9425, -118.408056, 355],
    ["New York", 40.639722, -73.778889, 578],
    ["São Paulo", -23.435556, -46.473056, 265],
    ["Paris", 49.009722, 2.547778, 694],
    ["Warsaw", 52.165833, 20.967222, 245],
    ["Hong Kong", 22.308889, 113.914444, 419],
  ]);
  for (const seed of warehouseSeeds) {
    expect(seed.id).toMatch(uuidV7);
  }
  expect(new Set(warehouseSeeds.map((seed) => seed.id)).size).toBe(6);
  expect(
    warehouseSeeds.map((seed) => seed.id),
    "seed IDs sort in PRD order",
  ).toStrictEqual(warehouseSeeds.map((seed) => seed.id).toSorted());
  expect(Object.isFrozen(warehouseSeeds)).toBe(true);
});

test("seeding inserts only missing warehouses and never updates existing stock", async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const result = await seedWarehouses({
    query: async (text, values) => {
      calls.push({ text, values });
      return { rowCount: 2 };
    },
  });

  expect(result).toStrictEqual({ inserted: 2, existing: 4 });
  expect(calls.length).toBe(1);
  const [call] = calls;
  expect(call).toBeDefined();
  if (call === undefined) {
    throw new Error("seeding must issue exactly one query");
  }
  expect(call.text).toMatch(/INSERT INTO warehouse \(id, name, latitude, longitude, stock\)/);
  expect(call.text).toMatch(/ON CONFLICT \(id\) DO NOTHING\s*$/);
  expect(call.text).not.toMatch(/UPDATE|DO UPDATE/i);
  expect(call.values.length).toBe(30);
  expect(call.values.slice(0, 5)).toStrictEqual([
    "01996000-0000-7000-8000-000000000001",
    "Los Angeles",
    33.9425,
    -118.408056,
    355,
  ]);
  expect(call.text).toMatch(/\(\$26::uuid, \$27, \$28::double precision/);

  const unknownCount = await seedWarehouses({ query: async () => ({ rowCount: null }) });
  expect(unknownCount).toStrictEqual({ inserted: 0, existing: 6 });
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
  expect(messages).toStrictEqual([
    "Seeded warehouses: 6 inserted, 0 already present (stock unchanged).",
  ]);
  expect(ended).toBe(1);

  await expect(
    runSeedCommand({
      createPool: () => ({
        query: async () => {
          throw new Error("connection refused");
        },
        end: async () => {
          ended += 1;
        },
      }),
      log: () => expect.fail("must not report success"),
    }),
  ).rejects.toThrow(/connection refused/);
  expect(ended).toBe(2);
});

test("database reset refuses without an exact confirmation of the target database", () => {
  const url = "postgresql://scos:secret@localhost:5432/scos_wt_abc";
  expect(() => confirmDatabaseReset({})).toThrow(/DATABASE_URL is required/);
  expect(() => confirmDatabaseReset({ DATABASE_URL: url })).toThrow(
    /Refusing to reset database "scos_wt_abc"/,
  );
  expect(() =>
    confirmDatabaseReset({ DATABASE_URL: url, SCOS_CONFIRM_DATABASE_RESET: "1" }),
  ).toThrow(/SCOS_CONFIRM_DATABASE_RESET=scos_wt_abc/);
  expect(() =>
    confirmDatabaseReset({ DATABASE_URL: url, SCOS_CONFIRM_DATABASE_RESET: "scos" }),
  ).toThrow(/Refusing/);
  expect(() =>
    confirmDatabaseReset({ DATABASE_URL: "not a url", SCOS_CONFIRM_DATABASE_RESET: "x" }),
  ).toThrow(/valid PostgreSQL connection URL/);
  expect(() =>
    confirmDatabaseReset({
      DATABASE_URL: "postgresql://scos@localhost:5432",
      SCOS_CONFIRM_DATABASE_RESET: "",
    }),
  ).toThrow(/must name the database/);
  expect(
    confirmDatabaseReset({ DATABASE_URL: url, SCOS_CONFIRM_DATABASE_RESET: "scos_wt_abc" }),
  ).toBe("scos_wt_abc");
  const secretFree: string[] = [];
  runConfirmResetCommand(
    { DATABASE_URL: url, SCOS_CONFIRM_DATABASE_RESET: "scos_wt_abc" },
    (message) => secretFree.push(message),
  );
  expect(secretFree).toStrictEqual(['Confirmed destructive reset of database "scos_wt_abc".']);
  expect(() => runConfirmResetCommand({ DATABASE_URL: url })).toThrow(/Refusing/);
});
