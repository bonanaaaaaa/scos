import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, test } from "vitest";

import { formatMoney, toOrderRecord } from "../src/records.js";
import {
  assertDatabaseError,
  createMigratedDatabase,
  type MigratedDatabase,
  runPrisma,
} from "./support/database.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const RESTRICT_VIOLATION = "23001";
const NUMERIC_OVERFLOW = "22003";

const applicationTables = ["customer_order", "order_allocation", "warehouse"];

let db: MigratedDatabase;

const unique = (prefix: string) => `${prefix}-${randomUUID()}`;

async function insertWarehouse(stock = 10): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    "INSERT INTO warehouse (name, latitude, longitude, stock) VALUES ($1, 0, 0, $2) RETURNING id",
    [unique("warehouse"), stock],
  );
  return result.rows[0]!.id;
}

// Explicit insert timestamps are permitted (ADR 0003); an UPDATE cannot set
// updated_at because the trigger overrides it, so backdate on insert.
async function insertBackdatedWarehouse(): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO warehouse (name, latitude, longitude, stock, created_at, updated_at)
     VALUES ($1, 0, 0, 10, '2000-01-01Z', '2000-01-01Z') RETURNING id`,
    [unique("backdated")],
  );
  return result.rows[0]!.id;
}

// An accepted Order carries the client's duplicate-request key and the Order
// Request it fulfilled: quantity 10 at 150.00 each, with no discount and
// 10.00 shipping.
const acceptedOrder = {
  quantity: "10",
  destination_latitude: "1.5",
  destination_longitude: "-2.5",
  unit_price: "150.00",
  merchandise_subtotal: "1500.00",
  discount_rate: "0.00",
  discount_amount: "0.00",
  discounted_merchandise_total: "1500.00",
  shipping_cost: "10.00",
  order_total: "1510.00",
};

type OrderOverrides = Partial<
  Record<keyof typeof acceptedOrder | "order_number" | "submission_key", string>
>;

async function insertOrder(overrides: OrderOverrides = {}): Promise<string> {
  const row: Record<string, string> = {
    order_number: unique("ORD"),
    submission_key: unique("attempt"),
    ...acceptedOrder,
    ...overrides,
  };
  const columns = Object.keys(row);
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO customer_order (${columns.join(", ")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id`,
    Object.values(row),
  );
  return result.rows[0]!.id;
}

async function insertAllocation(orderId: string, warehouseId: string, quantity = 10) {
  await db.pool.query(
    "INSERT INTO order_allocation (order_id, warehouse_id, quantity) VALUES ($1, $2, $3)",
    [orderId, warehouseId, quantity],
  );
}

describe("PostgreSQL ordering schema", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = await createMigratedDatabase();
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  describe("migrations", () => {
    test("apply cleanly once and match the Prisma schema without drift", async () => {
      const history = await db.pool.query<{ migration_name: string; ok: boolean }>(
        `SELECT migration_name, finished_at IS NOT NULL AND rolled_back_at IS NULL AS ok
         FROM _prisma_migrations ORDER BY migration_name`,
      );
      assert.deepEqual(history.rows, [
        { migration_name: "20260918000000_initial_ordering_schema", ok: true },
      ]);

      const redeploy = await runPrisma(["migrate", "deploy"], db.url);
      assert.match(redeploy.stdout, /No pending migrations to apply/);

      const diff = await runPrisma(
        [
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
          "--exit-code",
        ],
        db.url,
      );
      assert.match(diff.stdout, /No difference detected/);
    });

    // No categorical value is persisted yet, so the schema has no lookup
    // tables. Native enums stay banned: a future categorical column must use a
    // text lookup table rather than a Prisma enum.
    test("create exactly the application tables and no native enums", async () => {
      const tables = await db.pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           AND table_name <> '_prisma_migrations'
         ORDER BY table_name`,
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        applicationTables,
      );

      const enums = await db.pool.query("SELECT 1 FROM pg_type WHERE typtype = 'e'");
      assert.equal(enums.rowCount, 0);
    });
  });

  describe("database-managed timestamps", () => {
    test("every application table has NOT NULL timestamptz NOW() columns and an enabled trigger", async () => {
      const columns = await db.pool.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
           AND column_name IN ('created_at', 'updated_at')
         ORDER BY table_name, column_name`,
      );
      assert.equal(columns.rowCount, applicationTables.length * 2);
      for (const column of columns.rows) {
        assert.equal(column.data_type, "timestamp with time zone", JSON.stringify(column));
        assert.equal(column.is_nullable, "NO", JSON.stringify(column));
        assert.equal(column.column_default, "now()", JSON.stringify(column));
      }

      const triggers = await db.pool.query<{ table_name: string; trigger_name: string }>(
        `SELECT c.relname AS table_name, t.tgname AS trigger_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgenabled = 'O'
           AND t.tgtype = 19 -- FOR EACH ROW (1) + BEFORE (2) + UPDATE (16)
           AND t.tgfoid = 'public.update_timestamp()'::regprocedure
         ORDER BY c.relname`,
      );
      assert.deepEqual(
        triggers.rows,
        applicationTables.map((table) => ({
          table_name: table,
          trigger_name: `update_${table}_updated_at`,
        })),
      );
    });

    test("raw SQL and Prisma inserts populate equal transaction-time timestamps", async () => {
      const raw = await db.pool.query<{ equal: boolean; at_now: boolean }>(
        `INSERT INTO warehouse (name, latitude, longitude, stock) VALUES ($1, 0, 0, 1)
         RETURNING created_at = updated_at AS equal, created_at = NOW() AS at_now`,
        [unique("raw")],
      );
      assert.deepEqual(raw.rows[0], { equal: true, at_now: true });

      const checks = await db.prisma.$transaction(async (tx) => {
        const warehouse = await tx.warehouse.create({
          data: { name: unique("prisma"), latitude: 0, longitude: 0, stock: 1 },
        });
        const order = await tx.order.create({
          data: {
            orderNumber: unique("ORD"),
            submissionKey: unique("attempt"),
            quantity: 1,
            destinationLatitude: 0,
            destinationLongitude: 0,
            unitPrice: "150.00",
            merchandiseSubtotal: "150.00",
            discountRate: "0.00",
            discountAmount: "0.00",
            discountedMerchandiseTotal: "150.00",
            shippingCost: "10.00",
            orderTotal: "160.00",
          },
        });
        return tx.$queryRaw<{ equal: boolean; at_now: boolean }[]>`
          SELECT w.created_at = w.updated_at AND o.created_at = o.updated_at AS equal,
                 w.created_at = NOW() AND o.created_at = NOW() AS at_now
          FROM warehouse w, customer_order o
          WHERE w.id = ${warehouse.id}::uuid AND o.id = ${order.id}::uuid`;
      });
      assert.deepEqual(checks, [{ equal: true, at_now: true }]);
    });

    test("raw SQL updates keep created_at and override a supplied updated_at", async () => {
      const id = await insertBackdatedWarehouse();
      const updated = await db.pool.query(
        `UPDATE warehouse SET stock = stock - 1, updated_at = '1999-01-01Z' WHERE id = $1
         RETURNING stock, created_at = '2000-01-01Z' AS created_kept, updated_at = NOW() AS updated_now`,
        [id],
      );
      assert.deepEqual(updated.rows[0], { stock: 9, created_kept: true, updated_now: true });
    });

    test("Prisma updates keep created_at and override a supplied updatedAt", async () => {
      const id = await insertBackdatedWarehouse();
      const result = await db.prisma.$transaction(async (tx) => {
        const warehouse = await tx.warehouse.update({
          where: { id },
          data: { stock: { decrement: 2 }, updatedAt: new Date("1999-01-01T00:00:00Z") },
        });
        const [check] = await tx.$queryRaw<{ created_kept: boolean; updated_now: boolean }[]>`
          SELECT created_at = '2000-01-01Z' AS created_kept, updated_at = NOW() AS updated_now
          FROM warehouse WHERE id = ${id}::uuid`;
        return { stock: warehouse.stock, returnedUpdatedAt: warehouse.updatedAt, check };
      });
      assert.equal(result.stock, 8);
      assert.deepEqual(result.check, { created_kept: true, updated_now: true });
      assert.ok(
        result.returnedUpdatedAt.getUTCFullYear() > 2000,
        "Prisma returns the trigger value",
      );
    });

    test("a no-op update still refreshes updated_at to the transaction time", async () => {
      const id = await insertBackdatedWarehouse();
      const noop = await db.pool.query(
        `UPDATE warehouse SET stock = stock WHERE id = $1
         RETURNING stock, updated_at = NOW() AS updated_now`,
        [id],
      );
      assert.deepEqual(noop.rows[0], { stock: 10, updated_now: true });
    });

    test("statements in one transaction share NOW(); repeated updates do not advance it", async () => {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO warehouse (name, latitude, longitude, stock) VALUES ($1, 0, 0, 5) RETURNING id",
          [unique("txn")],
        );
        const id = inserted.rows[0]!.id;
        await client.query("SELECT pg_sleep(0.02)");
        await client.query("UPDATE warehouse SET stock = stock - 1 WHERE id = $1", [id]);
        await client.query("SELECT pg_sleep(0.02)");
        await client.query("UPDATE warehouse SET stock = stock - 1 WHERE id = $1", [id]);
        const order = await client.query<{ id: string }>(
          `INSERT INTO customer_order (order_number, submission_key, quantity,
             destination_latitude, destination_longitude, unit_price, merchandise_subtotal,
             discount_rate, discount_amount, discounted_merchandise_total, shipping_cost,
             order_total)
           VALUES ($1, $2, 1, 0, 0, '150.00', '150.00', '0.00', '0.00', '150.00', '10.00', '160.00')
           RETURNING id`,
          [unique("ORD"), unique("attempt")],
        );
        const check = await client.query(
          `SELECT w.created_at = NOW() AND w.updated_at = NOW()
                  AND o.created_at = NOW() AND o.updated_at = NOW() AS shared,
                  clock_timestamp() > NOW() + interval '30 milliseconds' AS time_passed,
                  w.stock
           FROM warehouse w, customer_order o WHERE w.id = $1 AND o.id = $2`,
          [id, order.rows[0]!.id],
        );
        assert.deepEqual(check.rows[0], { shared: true, time_passed: true, stock: 3 });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });

    test("rollback discards stock and timestamp changes", async () => {
      const id = await insertBackdatedWarehouse();
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE warehouse SET stock = 0 WHERE id = $1", [id]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      const after = await db.pool.query(
        "SELECT stock, updated_at = '2000-01-01Z' AS unchanged FROM warehouse WHERE id = $1",
        [id],
      );
      assert.deepEqual(after.rows[0], { stock: 10, unchanged: true });
    });

    test("order and allocation updates are covered by the trigger", async () => {
      const orderId = await insertOrder();
      await insertAllocation(orderId, await insertWarehouse());
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const before = await client.query<{ order_created: string; allocation_created: string }>(
          `SELECT o.created_at::text AS order_created, a.created_at::text AS allocation_created
           FROM customer_order o JOIN order_allocation a ON a.order_id = o.id
           WHERE o.id = $1`,
          [orderId],
        );
        const order = await client.query(
          `UPDATE customer_order SET order_number = order_number, updated_at = '1999-01-01Z'
           WHERE id = $1
           RETURNING created_at = $2::timestamptz AS created_kept, updated_at = NOW() AS updated_now`,
          [orderId, before.rows[0]!.order_created],
        );
        assert.deepEqual(order.rows[0], { created_kept: true, updated_now: true });
        const allocation = await client.query(
          `UPDATE order_allocation SET quantity = quantity, updated_at = '1999-01-01Z'
           WHERE order_id = $1
           RETURNING created_at = $2::timestamptz AS created_kept, updated_at = NOW() AS updated_now`,
          [orderId, before.rows[0]!.allocation_created],
        );
        assert.deepEqual(allocation.rows[0], { created_kept: true, updated_now: true });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    test("reads through Prisma do not touch timestamps", async () => {
      const id = await insertBackdatedWarehouse();
      await db.prisma.warehouse.findUniqueOrThrow({ where: { id } });
      await db.prisma.warehouse.findMany({ orderBy: { id: "asc" } });
      const after = await db.pool.query(
        "SELECT updated_at = '2000-01-01Z' AS unchanged FROM warehouse WHERE id = $1",
        [id],
      );
      assert.deepEqual(after.rows[0], { unchanged: true });
    });
  });

  describe("generated identifiers", () => {
    test("database defaults generate UUIDv7 values for Prisma and raw SQL inserts", async () => {
      const warehouseId = await insertWarehouse();
      const order = await db.prisma.order.create({
        data: {
          orderNumber: unique("ORD"),
          submissionKey: unique("attempt"),
          quantity: 1,
          destinationLatitude: 0,
          destinationLongitude: 0,
          unitPrice: "150.00",
          merchandiseSubtotal: "150.00",
          discountRate: "0.00",
          discountAmount: "0.00",
          discountedMerchandiseTotal: "150.00",
          shippingCost: "10.00",
          orderTotal: "160.00",
        },
      });
      await insertAllocation(order.id, warehouseId);
      const versions = await db.pool.query(
        `SELECT
           (SELECT uuid_extract_version(id) FROM warehouse WHERE id = $1) AS warehouse,
           (SELECT uuid_extract_version(id) FROM customer_order WHERE id = $2) AS "order",
           (SELECT uuid_extract_version(id) FROM order_allocation WHERE order_id = $2) AS allocation`,
        [warehouseId, order.id],
      );
      assert.deepEqual(versions.rows[0], { warehouse: 7, order: 7, allocation: 7 });
    });
  });

  describe("constraints", () => {
    test("warehouse stock is nonnegative and coordinates are bounded", async () => {
      await assertDatabaseError(insertWarehouse(-1), {
        code: CHECK_VIOLATION,
        constraint: "warehouse_stock_check",
      });
      const id = await insertWarehouse(0);
      await assertDatabaseError(
        db.pool.query("UPDATE warehouse SET stock = stock - 1 WHERE id = $1", [id]),
        { code: CHECK_VIOLATION, constraint: "warehouse_stock_check" },
      );
      for (const [column, value] of [
        ["latitude", 90.000001],
        ["latitude", -90.000001],
        ["longitude", 180.000001],
        ["longitude", -180.000001],
        ["longitude", Number.NaN],
        ["latitude", Number.POSITIVE_INFINITY],
      ] as const) {
        await assertDatabaseError(
          db.pool.query(`UPDATE warehouse SET ${column} = $2 WHERE id = $1`, [id, value]),
          { code: CHECK_VIOLATION, constraint: `warehouse_${column}_check` },
        );
      }
      await db.pool.query("UPDATE warehouse SET latitude = -90, longitude = 180 WHERE id = $1", [
        id,
      ]);
      await assertDatabaseError(
        db.pool.query(
          "INSERT INTO warehouse (name, latitude, longitude, stock) VALUES ('  ', 0, 0, 1)",
        ),
        { code: CHECK_VIOLATION, constraint: "warehouse_name_check" },
      );
    });

    test("Orders require a unique nonblank order number", async () => {
      const orderNumber = unique("ORD");
      await insertOrder({ order_number: orderNumber });
      await assertDatabaseError(insertOrder({ order_number: orderNumber }), {
        code: UNIQUE_VIOLATION,
        constraint: "customer_order_order_number_key",
      });
      await assertDatabaseError(insertOrder({ order_number: "" }), {
        code: CHECK_VIOLATION,
        constraint: "customer_order_order_number_check",
      });
      await assertDatabaseError(insertOrder({ order_number: "   " }), {
        code: CHECK_VIOLATION,
        constraint: "customer_order_order_number_check",
      });
    });

    test("one Order per duplicate-request key, non-blank and at most 255 characters", async () => {
      const submissionKey = unique("attempt");
      await insertOrder({ submission_key: submissionKey });
      await assertDatabaseError(insertOrder({ submission_key: submissionKey }), {
        code: UNIQUE_VIOLATION,
        constraint: "customer_order_submission_key_key",
      });
      await assertDatabaseError(insertOrder({ submission_key: "" }), {
        code: CHECK_VIOLATION,
        constraint: "customer_order_submission_key_check",
      });
      await assertDatabaseError(insertOrder({ submission_key: "   " }), {
        code: CHECK_VIOLATION,
        constraint: "customer_order_submission_key_check",
      });
      await assertDatabaseError(
        insertOrder({ submission_key: `k${randomUUID()}`.padEnd(256, "x") }),
        { code: CHECK_VIOLATION, constraint: "customer_order_submission_key_check" },
      );
      const longestKey = `k${randomUUID()}`.padEnd(255, "x");
      assert.equal(longestKey.length, 255);
      await insertOrder({ submission_key: longestKey });
      const stored = await db.pool.query<{ length: number }>(
        "SELECT char_length(submission_key) AS length FROM customer_order WHERE submission_key = $1",
        [longestKey],
      );
      assert.deepEqual(stored.rows, [{ length: 255 }]);
    });

    test("Orders require a positive quantity and a bounded destination", async () => {
      // Quantity participates in the subtotal CHECK, so consistent amounts
      // isolate the quantity constraint.
      const zeroQuantity = {
        quantity: "0",
        merchandise_subtotal: "0.00",
        discounted_merchandise_total: "0.00",
        order_total: "10.00",
      };
      await assertDatabaseError(insertOrder(zeroQuantity), {
        code: CHECK_VIOLATION,
        constraint: "customer_order_quantity_check",
      });
      await assertDatabaseError(
        insertOrder({ ...zeroQuantity, quantity: "-5", unit_price: "0.00" }),
        { code: CHECK_VIOLATION, constraint: "customer_order_quantity_check" },
      );

      for (const [column, value] of [
        ["destination_latitude", "90.000001"],
        ["destination_latitude", "-90.000001"],
        ["destination_latitude", "Infinity"],
        ["destination_longitude", "180.000001"],
        ["destination_longitude", "-180.000001"],
        ["destination_longitude", "NaN"],
      ] as const) {
        await assertDatabaseError(insertOrder({ [column]: value }), {
          code: CHECK_VIOLATION,
          constraint: `customer_order_${column}_check`,
        });
      }
      await insertOrder({ destination_latitude: "-90", destination_longitude: "180" });
      await insertOrder({ destination_latitude: "90", destination_longitude: "-180" });
    });

    test("the merchandise subtotal must equal unit price times quantity", async () => {
      await assertDatabaseError(
        insertOrder({
          merchandise_subtotal: "1500.01",
          discounted_merchandise_total: "1500.01",
          order_total: "1510.01",
        }),
        { code: CHECK_VIOLATION, constraint: "customer_order_merchandise_subtotal_check" },
      );
      await assertDatabaseError(
        insertOrder({
          quantity: "11",
          merchandise_subtotal: "1500.00",
        }),
        { code: CHECK_VIOLATION, constraint: "customer_order_merchandise_subtotal_check" },
      );
      // A negative unit price cannot be stored either: the product is
      // negative, and every amount derived from it must be nonnegative.
      // PostgreSQL evaluates CHECKs in constraint-name order, so the
      // discounted total rejects the row first.
      await assertDatabaseError(
        insertOrder({
          unit_price: "-150.00",
          merchandise_subtotal: "-1500.00",
          discounted_merchandise_total: "-1500.00",
          order_total: "-1490.00",
        }),
        { code: CHECK_VIOLATION, constraint: "customer_order_discounted_merchandise_total_check" },
      );

      // Exact NUMERIC arithmetic: cent-level prices and large quantities
      // multiply without rounding.
      await insertOrder({
        quantity: "3",
        unit_price: "0.10",
        merchandise_subtotal: "0.30",
        discounted_merchandise_total: "0.30",
        order_total: "10.30",
      });
      await insertOrder({
        quantity: "1000000",
        unit_price: "9999.99",
        merchandise_subtotal: "9999990000.00",
        discount_rate: "0.20",
        discount_amount: "1999998000.00",
        discounted_merchandise_total: "7999992000.00",
        order_total: "7999992010.00",
      });
      // The product is computed in unbounded NUMERIC, so a subtotal beyond
      // NUMERIC(12,2) fails as an overflow before any CHECK is evaluated
      // rather than making the CHECK misbehave.
      await assertDatabaseError(
        insertOrder({
          quantity: "2",
          unit_price: "9999999999.99",
          merchandise_subtotal: "19999999999.98",
          discounted_merchandise_total: "19999999999.98",
          order_total: "20000000009.98",
        }),
        { code: NUMERIC_OVERFLOW },
      );
    });

    test("Order snapshots are nonnegative and arithmetically consistent", async () => {
      const cases: [OrderOverrides, string][] = [
        [{ order_total: "1510.01" }, "customer_order_order_total_check"],
        [
          { discounted_merchandise_total: "1499.00", order_total: "1509.00" },
          "customer_order_discounted_merchandise_total_check",
        ],
        [{ discount_rate: "1.50" }, "customer_order_discount_rate_check"],
        [{ discount_rate: "-0.01" }, "customer_order_discount_rate_check"],
        [
          { discount_amount: "-10.00", discounted_merchandise_total: "1510.00" },
          "customer_order_discount_amount_check",
        ],
        [{ shipping_cost: "-10.00", order_total: "1490.00" }, "customer_order_shipping_cost_check"],
      ];
      for (const [overrides, constraint] of cases) {
        await assertDatabaseError(insertOrder(overrides), {
          code: CHECK_VIOLATION,
          constraint,
        });
      }
      await insertOrder({
        discount_rate: "0.15",
        discount_amount: "225.00",
        discounted_merchandise_total: "1275.00",
        shipping_cost: "0.00",
        order_total: "1275.00",
      });
    });

    test("discount rates beyond NUMERIC(3,2) are rounded to scale or overflow", async () => {
      // PostgreSQL rounds excess scale instead of rejecting it, so a finer tier
      // needs a wider column first (see docs/database-schema.md).
      const id = await insertOrder({ discount_rate: "0.125" });
      const stored = await db.pool.query<{ discount_rate: string }>(
        "SELECT discount_rate FROM customer_order WHERE id = $1",
        [id],
      );
      assert.deepEqual(stored.rows, [{ discount_rate: "0.13" }]);
      await assertDatabaseError(insertOrder({ discount_rate: "10.00" }), {
        code: NUMERIC_OVERFLOW,
      });
    });

    test("allocations are positive, unique per warehouse, and reference existing rows", async () => {
      const warehouseId = await insertWarehouse();
      const orderId = await insertOrder();
      await assertDatabaseError(insertAllocation(orderId, warehouseId, 0), {
        code: CHECK_VIOLATION,
        constraint: "order_allocation_quantity_check",
      });
      await assertDatabaseError(insertAllocation(orderId, warehouseId, -1), {
        code: CHECK_VIOLATION,
        constraint: "order_allocation_quantity_check",
      });
      await insertAllocation(orderId, warehouseId, 4);
      await assertDatabaseError(insertAllocation(orderId, warehouseId, 6), {
        code: UNIQUE_VIOLATION,
        constraint: "order_allocation_order_id_warehouse_id_key",
      });
      await assertDatabaseError(insertAllocation(orderId, randomUUID()), {
        code: FOREIGN_KEY_VIOLATION,
        constraint: "order_allocation_warehouse_id_fkey",
      });
      await assertDatabaseError(insertAllocation(randomUUID(), warehouseId), {
        code: FOREIGN_KEY_VIOLATION,
        constraint: "order_allocation_order_id_fkey",
      });
    });

    test("historical records cannot be deleted through referenced rows", async () => {
      const warehouseId = await insertWarehouse();
      const orderId = await insertOrder();
      await insertAllocation(orderId, warehouseId);

      await assertDatabaseError(
        db.pool.query("DELETE FROM warehouse WHERE id = $1", [warehouseId]),
        {
          code: RESTRICT_VIOLATION,
          constraint: "order_allocation_warehouse_id_fkey",
        },
      );
      await assertDatabaseError(
        db.pool.query("DELETE FROM customer_order WHERE id = $1", [orderId]),
        {
          code: RESTRICT_VIOLATION,
          constraint: "order_allocation_order_id_fkey",
        },
      );
      await assertDatabaseError(
        db.pool.query("UPDATE warehouse SET id = uuidv7() WHERE id = $1", [warehouseId]),
        { code: RESTRICT_VIOLATION, constraint: "order_allocation_warehouse_id_fkey" },
      );
      await assertDatabaseError(
        db.pool.query("UPDATE customer_order SET id = uuidv7() WHERE id = $1", [orderId]),
        { code: RESTRICT_VIOLATION, constraint: "order_allocation_order_id_fkey" },
      );

      const remaining = await db.pool.query(
        "SELECT count(*)::int AS allocations FROM order_allocation WHERE order_id = $1",
        [orderId],
      );
      assert.deepEqual(remaining.rows[0], { allocations: 1 });
    });
  });

  describe("money round-trips", () => {
    for (const amount of ["0.00", "0.01", "9999999999.99"]) {
      test(`NUMERIC(12,2) round-trips ${amount} exactly through Prisma and pg`, async () => {
        const order = await db.prisma.order.create({
          data: {
            orderNumber: unique("ORD"),
            submissionKey: unique("attempt"),
            quantity: 1,
            destinationLatitude: 0,
            destinationLongitude: 0,
            unitPrice: amount,
            merchandiseSubtotal: amount,
            discountRate: "0.00",
            discountAmount: "0.00",
            discountedMerchandiseTotal: amount,
            shippingCost: "0.00",
            orderTotal: amount,
          },
        });
        assert.equal(formatMoney(order.orderTotal), amount);
        const reread = await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        assert.equal(formatMoney(reread.unitPrice), amount);
        assert.equal(formatMoney(reread.orderTotal), amount);
        const raw = await db.pool.query<{ order_total: string }>(
          "SELECT order_total FROM customer_order WHERE id = $1",
          [order.id],
        );
        assert.equal(raw.rows[0]!.order_total, amount);
      });
    }

    test("amounts beyond NUMERIC(12,2) are rejected rather than stored", async () => {
      await assertDatabaseError(
        insertOrder({
          quantity: "1",
          unit_price: "10000000000.00",
          merchandise_subtotal: "10000000000.00",
          discounted_merchandise_total: "10000000000.00",
          order_total: "10000000010.00",
        }),
        { code: NUMERIC_OVERFLOW },
      );
      const orderNumber = unique("ORD");
      await assert.rejects(
        db.prisma.order.create({
          data: {
            orderNumber,
            submissionKey: unique("attempt"),
            quantity: 1,
            destinationLatitude: 0,
            destinationLongitude: 0,
            unitPrice: "10000000000.00",
            merchandiseSubtotal: "10000000000.00",
            discountRate: "0.00",
            discountAmount: "0.00",
            discountedMerchandiseTotal: "10000000000.00",
            shippingCost: "0.00",
            orderTotal: "10000000000.00",
          },
        }),
        /numeric field overflow|22003/i,
      );
      const stored = await db.pool.query("SELECT 1 FROM customer_order WHERE order_number = $1", [
        orderNumber,
      ]);
      assert.equal(stored.rowCount, 0);
    });

    test("an accepted Order round-trips through Prisma and the typed mappings", async () => {
      const warehouseA = await insertWarehouse(100);
      const warehouseB = await insertWarehouse(100);
      const orderNumber = unique("ORD");
      const submissionKey = unique("attempt");
      const created = await db.prisma.order.create({
        data: {
          orderNumber,
          submissionKey,
          quantity: 30,
          destinationLatitude: 13.7563,
          destinationLongitude: 100.5018,
          unitPrice: "150.00",
          merchandiseSubtotal: "4500.00",
          discountRate: "0.05",
          discountAmount: "225.00",
          discountedMerchandiseTotal: "4275.00",
          shippingCost: "123.45",
          orderTotal: "4398.45",
          allocations: {
            create: [
              { warehouseId: warehouseA, quantity: 20 },
              { warehouseId: warehouseB, quantity: 10 },
            ],
          },
        },
        include: { allocations: { orderBy: { quantity: "desc" } } },
      });

      const order = toOrderRecord(created);
      assert.deepEqual(
        {
          orderNumber: order.orderNumber,
          submissionKey: order.submissionKey,
          quantity: order.quantity,
          destination: order.destination,
          unitPrice: order.unitPrice,
          merchandiseSubtotal: order.merchandiseSubtotal,
          discountRate: order.discountRate,
          discountAmount: order.discountAmount,
          discountedMerchandiseTotal: order.discountedMerchandiseTotal,
          shippingCost: order.shippingCost,
          orderTotal: order.orderTotal,
          allocations: order.allocations.map(({ warehouseId, quantity }) => ({
            warehouseId,
            quantity,
          })),
        },
        {
          orderNumber,
          submissionKey,
          quantity: 30,
          destination: { latitude: 13.7563, longitude: 100.5018 },
          unitPrice: "150.00",
          merchandiseSubtotal: "4500.00",
          discountRate: "0.05",
          discountAmount: "225.00",
          discountedMerchandiseTotal: "4275.00",
          shippingCost: "123.45",
          orderTotal: "4398.45",
          allocations: [
            { warehouseId: warehouseA, quantity: 20 },
            { warehouseId: warehouseB, quantity: 10 },
          ],
        },
      );
      assert.ok(order.createdAt instanceof Date);

      const byNumber = await db.prisma.order.findUniqueOrThrow({
        where: { orderNumber },
        include: { allocations: true },
      });
      assert.equal(toOrderRecord(byNumber).id, order.id);

      // The duplicate-submission lookup used by order submission (ADR 0004).
      const byKey = await db.prisma.order.findUniqueOrThrow({ where: { submissionKey } });
      assert.equal(byKey.id, order.id);
    });
  });
});
