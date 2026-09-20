import { describe, expect, test } from "vitest";

import { createDatabasePool } from "./database";
import { createPrismaInventoryReader, type InventoryReaderClient } from "./inventory-reader";
import { createPrismaClient } from "./prisma";

type FindManyArgs = Parameters<InventoryReaderClient["warehouse"]["findMany"]>[0];
type Rows = Awaited<ReturnType<InventoryReaderClient["warehouse"]["findMany"]>>;

/** Stub client that records every findMany call and returns the rows given. */
function stubClient(rows: () => Rows) {
  const calls: FindManyArgs[] = [];
  const client: InventoryReaderClient = {
    warehouse: {
      findMany: async (args) => {
        calls.push(args);
        return rows();
      },
    },
  };
  return { client, calls };
}

const losAngeles = {
  id: "01996000-0000-7000-8000-000000000001",
  name: "Los Angeles",
  latitude: 33.9425,
  longitude: -118.408056,
  stock: 355,
};
const warsaw = {
  id: "01996000-0000-7000-8000-000000000005",
  name: "Warsaw",
  latitude: 52.165833,
  longitude: 20.967222,
  stock: 0,
};

describe("createPrismaInventoryReader", () => {
  test("maps warehouse rows to a frozen inventory snapshot, keeping empty warehouses", async () => {
    const { client } = stubClient(() => [losAngeles, warsaw]);

    const snapshot = await createPrismaInventoryReader(client).readInventorySnapshot();

    expect(snapshot).toStrictEqual([
      {
        warehouseId: "01996000-0000-7000-8000-000000000001",
        warehouseName: "Los Angeles",
        latitude: 33.9425,
        longitude: -118.408056,
        available: 355,
      },
      {
        warehouseId: "01996000-0000-7000-8000-000000000005",
        warehouseName: "Warsaw",
        latitude: 52.165833,
        longitude: 20.967222,
        available: 0,
      },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.every((warehouse) => Object.isFrozen(warehouse))).toBe(true);
  });

  test("each read is one findMany selecting only inventory columns in stable ID order", async () => {
    const { client, calls } = stubClient(() => [losAngeles]);
    const reader = createPrismaInventoryReader(client);
    expect(calls).toHaveLength(0);

    await reader.readInventorySnapshot();

    expect(calls).toStrictEqual([
      {
        select: { id: true, name: true, latitude: true, longitude: true, stock: true },
        orderBy: { id: "asc" },
      },
    ]);
  });

  // An estimate is advisory, so the name belongs to the same live read as the
  // stock: whatever the warehouse is called now is what the estimate names.
  test("the snapshot carries each warehouse's current name", async () => {
    let name = "Warsaw";
    const { client } = stubClient(() => [losAngeles, { ...warsaw, name }]);
    const reader = createPrismaInventoryReader(client);

    expect(
      (await reader.readInventorySnapshot()).map((warehouse) => warehouse.warehouseName),
    ).toStrictEqual(["Los Angeles", "Warsaw"]);

    name = "Warszawa";
    expect(
      (await reader.readInventorySnapshot()).map((warehouse) => warehouse.warehouseName),
    ).toStrictEqual(["Los Angeles", "Warszawa"]);
  });

  test("nothing is cached: every read queries again and sees current stock", async () => {
    let stock = 355;
    const { client, calls } = stubClient(() => [{ ...losAngeles, stock }]);
    const reader = createPrismaInventoryReader(client);

    const first = await reader.readInventorySnapshot();
    stock = 300;
    const second = await reader.readInventorySnapshot();

    expect(first[0]?.available).toBe(355);
    expect(second[0]?.available).toBe(300);
    expect(calls).toHaveLength(2);
  });

  test("an empty warehouse table is an empty snapshot", async () => {
    const { client } = stubClient(() => []);

    expect(await createPrismaInventoryReader(client).readInventorySnapshot()).toStrictEqual([]);
  });

  test("a query failure rejects with the original error", async () => {
    const failure = new Error("connection terminated");
    const reader = createPrismaInventoryReader({
      warehouse: { findMany: () => Promise.reject(failure) },
    });

    await expect(reader.readInventorySnapshot()).rejects.toBe(failure);
  });

  // The value of this test is at compile time: `tsc` proves the generated
  // PrismaClient is assignable to the narrowed InventoryReaderClient. The
  // runtime assertion only keeps the call from being optimised away.
  test("accepts the real Prisma client without connecting", async () => {
    const pool = createDatabasePool("postgresql://example:example@localhost:5432/example");
    const prisma = createPrismaClient(pool);
    try {
      expect(createPrismaInventoryReader(prisma).readInventorySnapshot).toBeTypeOf("function");
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
