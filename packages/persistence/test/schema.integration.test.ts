import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

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

const applicationTables = ["order_allocations", "orders", "warehouses"];

let db: MigratedDatabase;

const unique = (prefix: string) => `${prefix}-${randomUUID()}`;

async function insertWarehouse(stock = 10): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    "INSERT INTO warehouses (name, latitude, longitude, stock) VALUES ($1, 0, 0, $2) RETURNING id",
    [unique("warehouse"), stock],
  );
  return result.rows[0]!.id;
}

// Explicit insert timestamps are permitted (ADR 0003); an UPDATE cannot set
// updated_at because the trigger overrides it, so backdate on insert.
async function insertBackdatedWarehouse(): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO warehouses (name, latitude, longitude, stock, created_at, updated_at)
     VALUES ($1, 0, 0, 10, '2000-01-01Z', '2000-01-01Z') RETURNING id`,
    [unique("backdated")],
  );
  return result.rows[0]!.id;
}

// An accepted Order carries the client's duplicate-request key and the Order
// Request it fulfilled: quantity 10 at 150.00 each, with no discount and
// 10.00 shipping. The subtotal and totals are derived on read, not stored.
const acceptedOrder = {
  quantity: "10",
  destination_latitude: "1.5",
  destination_longitude: "-2.5",
  unit_price: "150.00",
  discount_rate: "0.00",
  discount_amount: "0.00",
  shipping_cost: "10.00",
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
    `INSERT INTO orders (${columns.join(", ")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id`,
    Object.values(row),
  );
  return result.rows[0]!.id;
}

async function insertAllocation(orderId: string, warehouseId: string, quantity = 10) {
  await db.pool.query(
    "INSERT INTO order_allocations (order_id, warehouse_id, quantity) VALUES ($1, $2, $3)",
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
      expect(history.rows).toStrictEqual([
        { migration_name: "20260918000000_initial_ordering_schema", ok: true },
      ]);

      const redeploy = await runPrisma(["migrate", "deploy"], db.url);
      expect(redeploy.stdout).toMatch(/No pending migrations to apply/);

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
      expect(diff.stdout).toMatch(/No difference detected/);
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
      expect(tables.rows.map((row) => row.table_name)).toStrictEqual(applicationTables);

      const enums = await db.pool.query("SELECT 1 FROM pg_type WHERE typtype = 'e'");
      expect(enums.rowCount).toBe(0);
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
      expect(columns.rowCount).toBe(applicationTables.length * 2);
      for (const column of columns.rows) {
        expect(column.data_type, JSON.stringify(column)).toBe("timestamp with time zone");
        expect(column.is_nullable, JSON.stringify(column)).toBe("NO");
        expect(column.column_default, JSON.stringify(column)).toBe("now()");
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
      expect(triggers.rows).toStrictEqual(
        applicationTables.map((table) => ({
          table_name: table,
          trigger_name: `update_${table}_updated_at`,
        })),
      );
    });

    test("raw SQL and Prisma inserts populate equal transaction-time timestamps", async () => {
      const raw = await db.pool.query<{ equal: boolean; at_now: boolean }>(
        `INSERT INTO warehouses (name, latitude, longitude, stock) VALUES ($1, 0, 0, 1)
         RETURNING created_at = updated_at AS equal, created_at = NOW() AS at_now`,
        [unique("raw")],
      );
      expect(raw.rows[0]).toStrictEqual({ equal: true, at_now: true });

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
            discountRate: "0.00",
            discountAmount: "0.00",
            shippingCost: "10.00",
          },
        });
        return tx.$queryRaw<{ equal: boolean; at_now: boolean }[]>`
          SELECT w.created_at = w.updated_at AND o.created_at = o.updated_at AS equal,
                 w.created_at = NOW() AND o.created_at = NOW() AS at_now
          FROM warehouses w, orders o
          WHERE w.id = ${warehouse.id}::uuid AND o.id = ${order.id}::uuid`;
      });
      expect(checks).toStrictEqual([{ equal: true, at_now: true }]);
    });

    test("raw SQL updates keep created_at and override a supplied updated_at", async () => {
      const id = await insertBackdatedWarehouse();
      const updated = await db.pool.query(
        `UPDATE warehouses SET stock = stock - 1, updated_at = '1999-01-01Z' WHERE id = $1
         RETURNING stock, created_at = '2000-01-01Z' AS created_kept, updated_at = NOW() AS updated_now`,
        [id],
      );
      expect(updated.rows[0]).toStrictEqual({ stock: 9, created_kept: true, updated_now: true });
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
          FROM warehouses WHERE id = ${id}::uuid`;
        return { stock: warehouse.stock, returnedUpdatedAt: warehouse.updatedAt, check };
      });
      expect(result.stock).toBe(8);
      expect(result.check).toStrictEqual({ created_kept: true, updated_now: true });
      expect(
        result.returnedUpdatedAt.getUTCFullYear(),
        "Prisma returns the trigger value",
      ).toBeGreaterThan(2000);
    });

    test("a no-op update still refreshes updated_at to the transaction time", async () => {
      const id = await insertBackdatedWarehouse();
      const noop = await db.pool.query(
        `UPDATE warehouses SET stock = stock WHERE id = $1
         RETURNING stock, updated_at = NOW() AS updated_now`,
        [id],
      );
      expect(noop.rows[0]).toStrictEqual({ stock: 10, updated_now: true });
    });

    test("statements in one transaction share NOW(); repeated updates do not advance it", async () => {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO warehouses (name, latitude, longitude, stock) VALUES ($1, 0, 0, 5) RETURNING id",
          [unique("txn")],
        );
        const id = inserted.rows[0]!.id;
        await client.query("SELECT pg_sleep(0.02)");
        await client.query("UPDATE warehouses SET stock = stock - 1 WHERE id = $1", [id]);
        await client.query("SELECT pg_sleep(0.02)");
        await client.query("UPDATE warehouses SET stock = stock - 1 WHERE id = $1", [id]);
        const order = await client.query<{ id: string }>(
          `INSERT INTO orders (order_number, submission_key, quantity,
             destination_latitude, destination_longitude, unit_price, discount_rate,
             discount_amount, shipping_cost)
           VALUES ($1, $2, 1, 0, 0, '150.00', '0.00', '0.00', '10.00')
           RETURNING id`,
          [unique("ORD"), unique("attempt")],
        );
        const check = await client.query(
          `SELECT w.created_at = NOW() AND w.updated_at = NOW()
                  AND o.created_at = NOW() AND o.updated_at = NOW() AS shared,
                  clock_timestamp() > NOW() + interval '30 milliseconds' AS time_passed,
                  w.stock
           FROM warehouses w, orders o WHERE w.id = $1 AND o.id = $2`,
          [id, order.rows[0]!.id],
        );
        expect(check.rows[0]).toStrictEqual({ shared: true, time_passed: true, stock: 3 });
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
        await client.query("UPDATE warehouses SET stock = 0 WHERE id = $1", [id]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      const after = await db.pool.query(
        "SELECT stock, updated_at = '2000-01-01Z' AS unchanged FROM warehouses WHERE id = $1",
        [id],
      );
      expect(after.rows[0]).toStrictEqual({ stock: 10, unchanged: true });
    });

    test("order and allocation updates are covered by the trigger", async () => {
      const orderId = await insertOrder();
      await insertAllocation(orderId, await insertWarehouse());
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const before = await client.query<{ order_created: string; allocation_created: string }>(
          `SELECT o.created_at::text AS order_created, a.created_at::text AS allocation_created
           FROM orders o JOIN order_allocations a ON a.order_id = o.id
           WHERE o.id = $1`,
          [orderId],
        );
        const order = await client.query(
          `UPDATE orders SET order_number = order_number, updated_at = '1999-01-01Z'
           WHERE id = $1
           RETURNING created_at = $2::timestamptz AS created_kept, updated_at = NOW() AS updated_now`,
          [orderId, before.rows[0]!.order_created],
        );
        expect(order.rows[0]).toStrictEqual({ created_kept: true, updated_now: true });
        const allocation = await client.query(
          `UPDATE order_allocations SET quantity = quantity, updated_at = '1999-01-01Z'
           WHERE order_id = $1
           RETURNING created_at = $2::timestamptz AS created_kept, updated_at = NOW() AS updated_now`,
          [orderId, before.rows[0]!.allocation_created],
        );
        expect(allocation.rows[0]).toStrictEqual({ created_kept: true, updated_now: true });
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
        "SELECT updated_at = '2000-01-01Z' AS unchanged FROM warehouses WHERE id = $1",
        [id],
      );
      expect(after.rows[0]).toStrictEqual({ unchanged: true });
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
          discountRate: "0.00",
          discountAmount: "0.00",
          shippingCost: "10.00",
        },
      });
      await insertAllocation(order.id, warehouseId);
      const versions = await db.pool.query(
        `SELECT
           (SELECT uuid_extract_version(id) FROM warehouses WHERE id = $1) AS warehouse,
           (SELECT uuid_extract_version(id) FROM orders WHERE id = $2) AS "order",
           (SELECT uuid_extract_version(id) FROM order_allocations WHERE order_id = $2) AS allocation`,
        [warehouseId, order.id],
      );
      expect(versions.rows[0]).toStrictEqual({ warehouse: 7, order: 7, allocation: 7 });
    });
  });

  describe("constraints", () => {
    test("warehouse stock is nonnegative and coordinates are bounded", async () => {
      await assertDatabaseError(insertWarehouse(-1), {
        code: CHECK_VIOLATION,
        constraint: "warehouses_stock_check",
      });
      const id = await insertWarehouse(0);
      await assertDatabaseError(
        db.pool.query("UPDATE warehouses SET stock = stock - 1 WHERE id = $1", [id]),
        { code: CHECK_VIOLATION, constraint: "warehouses_stock_check" },
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
          db.pool.query(`UPDATE warehouses SET ${column} = $2 WHERE id = $1`, [id, value]),
          { code: CHECK_VIOLATION, constraint: `warehouses_${column}_check` },
        );
      }
      await db.pool.query("UPDATE warehouses SET latitude = -90, longitude = 180 WHERE id = $1", [
        id,
      ]);
      await assertDatabaseError(
        db.pool.query(
          "INSERT INTO warehouses (name, latitude, longitude, stock) VALUES ('  ', 0, 0, 1)",
        ),
        { code: CHECK_VIOLATION, constraint: "warehouses_name_check" },
      );
    });

    test("Orders require a unique nonblank order number", async () => {
      const orderNumber = unique("ORD");
      await insertOrder({ order_number: orderNumber });
      await assertDatabaseError(insertOrder({ order_number: orderNumber }), {
        code: UNIQUE_VIOLATION,
        constraint: "orders_order_number_key",
      });
      await assertDatabaseError(insertOrder({ order_number: "" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_order_number_check",
      });
      await assertDatabaseError(insertOrder({ order_number: "   " }), {
        code: CHECK_VIOLATION,
        constraint: "orders_order_number_check",
      });
    });

    test("one Order per duplicate-request key, non-blank and at most 255 characters", async () => {
      const submissionKey = unique("attempt");
      await insertOrder({ submission_key: submissionKey });
      await assertDatabaseError(insertOrder({ submission_key: submissionKey }), {
        code: UNIQUE_VIOLATION,
        constraint: "orders_submission_key_key",
      });
      await assertDatabaseError(insertOrder({ submission_key: "" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_submission_key_check",
      });
      await assertDatabaseError(insertOrder({ submission_key: "   " }), {
        code: CHECK_VIOLATION,
        constraint: "orders_submission_key_check",
      });
      await assertDatabaseError(
        insertOrder({ submission_key: `k${randomUUID()}`.padEnd(256, "x") }),
        { code: CHECK_VIOLATION, constraint: "orders_submission_key_check" },
      );
      const longestKey = `k${randomUUID()}`.padEnd(255, "x");
      expect(longestKey.length).toBe(255);
      await insertOrder({ submission_key: longestKey });
      const stored = await db.pool.query<{ length: number }>(
        "SELECT char_length(submission_key) AS length FROM orders WHERE submission_key = $1",
        [longestKey],
      );
      expect(stored.rows).toStrictEqual([{ length: 255 }]);
    });

    test("Orders require a positive quantity and a bounded destination", async () => {
      await assertDatabaseError(insertOrder({ quantity: "0" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_quantity_check",
      });
      // Quantity participates in the discount CHECK, which is evaluated first
      // (constraint-name order): a negative quantity at a positive price makes
      // the derived subtotal negative. A zero unit price isolates the quantity
      // constraint.
      await assertDatabaseError(insertOrder({ quantity: "-5", unit_price: "0.00" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_quantity_check",
      });
      await assertDatabaseError(insertOrder({ quantity: "-5" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_discount_amount_check",
      });

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
          constraint: `orders_${column}_check`,
        });
      }
      await insertOrder({ destination_latitude: "-90", destination_longitude: "180" });
      await insertOrder({ destination_latitude: "90", destination_longitude: "-180" });
    });

    test("orders carries exactly the expected CHECK constraints", async () => {
      // orders_unit_price_check can never be the first CHECK to fire:
      // with a positive quantity a negative price fails the discount CHECK,
      // and with a negative quantity the quantity CHECK precedes it by name.
      // Assert it exists rather than claim to observe it.
      const checks = await db.pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'public.orders'::regclass AND contype = 'c'
         ORDER BY conname`,
      );
      expect(checks.rows.map((row) => row.conname)).toStrictEqual([
        "orders_destination_latitude_check",
        "orders_destination_longitude_check",
        "orders_discount_amount_check",
        "orders_discount_rate_check",
        "orders_merchandise_subtotal_range_check",
        "orders_order_number_check",
        "orders_order_total_range_check",
        "orders_quantity_check",
        "orders_shipping_cost_check",
        "orders_submission_key_check",
        "orders_unit_price_check",
      ]);
    });

    test("stored commercial facts are nonnegative and the rate is bounded", async () => {
      const cases: [OrderOverrides, string][] = [
        [{ discount_rate: "1.50" }, "orders_discount_rate_check"],
        [{ discount_rate: "-0.01" }, "orders_discount_rate_check"],
        [{ discount_amount: "-10.00" }, "orders_discount_amount_check"],
        [{ shipping_cost: "-10.00" }, "orders_shipping_cost_check"],
        // A negative unit price makes the derived subtotal negative, so the
        // discount CHECK (evaluated before unit_price_check by name) rejects it.
        [{ unit_price: "-150.00" }, "orders_discount_amount_check"],
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
        shipping_cost: "0.00",
      });
      await insertOrder({ unit_price: "0.00" });
    });

    test("the discount cannot exceed the derived merchandise subtotal", async () => {
      await assertDatabaseError(insertOrder({ discount_amount: "1500.01" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_discount_amount_check",
      });
      // The subtotal follows the quantity: 150.00 x 9 = 1350.00.
      await assertDatabaseError(insertOrder({ quantity: "9", discount_amount: "1350.01" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_discount_amount_check",
      });
      // A discount of the whole subtotal leaves a zero discounted total.
      await insertOrder({ discount_rate: "1.00", discount_amount: "1500.00" });
    });

    test("derived amounts must fit NUMERIC(12,2)", async () => {
      // The CHECK expressions are unbounded NUMERIC, so an out-of-range derived
      // amount is a CHECK violation, not a numeric overflow.
      await assertDatabaseError(insertOrder({ quantity: "2", unit_price: "9999999999.99" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_merchandise_subtotal_range_check",
      });
      // 9999.99 x 1000001 is exactly 9999999999.99; one more unit is beyond it.
      await assertDatabaseError(insertOrder({ quantity: "1000002", unit_price: "9999.99" }), {
        code: CHECK_VIOLATION,
        constraint: "orders_merchandise_subtotal_range_check",
      });
      // A discount does not bring an out-of-range subtotal back into range.
      await assertDatabaseError(
        insertOrder({
          quantity: "2",
          unit_price: "9999999999.99",
          discount_amount: "9999999999.99",
          shipping_cost: "0.00",
        }),
        { code: CHECK_VIOLATION, constraint: "orders_merchandise_subtotal_range_check" },
      );

      // Subtotal in range, order total one cent beyond it.
      await assertDatabaseError(
        insertOrder({ quantity: "1", unit_price: "9999999999.99", shipping_cost: "0.01" }),
        { code: CHECK_VIOLATION, constraint: "orders_order_total_range_check" },
      );
      await assertDatabaseError(
        insertOrder({
          quantity: "1",
          unit_price: "9999999999.99",
          discount_amount: "0.01",
          shipping_cost: "0.02",
        }),
        { code: CHECK_VIOLATION, constraint: "orders_order_total_range_check" },
      );

      // Boundaries: the subtotal and the order total exactly at 9999999999.99.
      await insertOrder({ quantity: "1", unit_price: "9999999999.99", shipping_cost: "0.00" });
      await insertOrder({ quantity: "1000001", unit_price: "9999.99", shipping_cost: "0.00" });
      await insertOrder({ quantity: "1", unit_price: "9999999999.98", shipping_cost: "0.01" });
      await insertOrder({
        quantity: "1",
        unit_price: "9999999999.99",
        discount_amount: "0.01",
        shipping_cost: "0.01",
      });
      await insertOrder({
        quantity: "1000000",
        unit_price: "9999.99",
        discount_rate: "0.20",
        discount_amount: "1999998000.00",
        shipping_cost: "2000007999.99",
      });
    });

    test("totals derived by the mapping equal PostgreSQL's exact NUMERIC arithmetic", async () => {
      const ids = [
        await insertOrder(),
        await insertOrder({ quantity: "3", unit_price: "0.10" }),
        await insertOrder({
          quantity: "2147483647",
          unit_price: "0.01",
          discount_amount: "0.01",
          shipping_cost: "0.01",
        }),
        await insertOrder({
          quantity: "1000000",
          unit_price: "9999.99",
          discount_rate: "0.20",
          discount_amount: "1999998000.00",
        }),
      ];
      const computed = await db.pool.query<{
        id: string;
        merchandiseSubtotal: string;
        discountedMerchandiseTotal: string;
        orderTotal: string;
      }>(
        `SELECT id,
                (unit_price * quantity)::text AS "merchandiseSubtotal",
                (unit_price * quantity - discount_amount)::text AS "discountedMerchandiseTotal",
                (unit_price * quantity - discount_amount + shipping_cost)::text AS "orderTotal"
         FROM orders WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      expect(computed.rowCount).toBe(ids.length);
      const rows = await db.prisma.order.findMany({
        where: { id: { in: ids } },
        include: { allocations: true },
      });
      const mapped = new Map(rows.map((row) => [row.id, toOrderRecord(row)]));
      for (const expected of computed.rows) {
        const { id, merchandiseSubtotal, discountedMerchandiseTotal, orderTotal } = mapped.get(
          expected.id,
        )!;
        expect({ id, merchandiseSubtotal, discountedMerchandiseTotal, orderTotal }).toStrictEqual(
          expected,
        );
      }
      expect(computed.rows.map((row) => row.orderTotal).sort()).toStrictEqual(
        ["10.30", "1510.00", "21474836.47", "7999992010.00"].sort(),
      );
    });

    test("discount rates beyond NUMERIC(3,2) are rounded to scale or overflow", async () => {
      // PostgreSQL rounds excess scale instead of rejecting it, so a finer tier
      // needs a wider column first (see docs/database-schema.md).
      const id = await insertOrder({ discount_rate: "0.125" });
      const stored = await db.pool.query<{ discount_rate: string }>(
        "SELECT discount_rate FROM orders WHERE id = $1",
        [id],
      );
      expect(stored.rows).toStrictEqual([{ discount_rate: "0.13" }]);
      await assertDatabaseError(insertOrder({ discount_rate: "10.00" }), {
        code: NUMERIC_OVERFLOW,
      });
    });

    test("allocations are positive, unique per warehouse, and reference existing rows", async () => {
      const warehouseId = await insertWarehouse();
      const orderId = await insertOrder();
      await assertDatabaseError(insertAllocation(orderId, warehouseId, 0), {
        code: CHECK_VIOLATION,
        constraint: "order_allocations_quantity_check",
      });
      await assertDatabaseError(insertAllocation(orderId, warehouseId, -1), {
        code: CHECK_VIOLATION,
        constraint: "order_allocations_quantity_check",
      });
      await insertAllocation(orderId, warehouseId, 4);
      await assertDatabaseError(insertAllocation(orderId, warehouseId, 6), {
        code: UNIQUE_VIOLATION,
        constraint: "order_allocations_order_id_warehouse_id_key",
      });
      await assertDatabaseError(insertAllocation(orderId, randomUUID()), {
        code: FOREIGN_KEY_VIOLATION,
        constraint: "order_allocations_warehouse_id_fkey",
      });
      await assertDatabaseError(insertAllocation(randomUUID(), warehouseId), {
        code: FOREIGN_KEY_VIOLATION,
        constraint: "order_allocations_order_id_fkey",
      });
    });

    test("historical records cannot be deleted through referenced rows", async () => {
      const warehouseId = await insertWarehouse();
      const orderId = await insertOrder();
      await insertAllocation(orderId, warehouseId);

      await assertDatabaseError(
        db.pool.query("DELETE FROM warehouses WHERE id = $1", [warehouseId]),
        {
          code: RESTRICT_VIOLATION,
          constraint: "order_allocations_warehouse_id_fkey",
        },
      );
      await assertDatabaseError(db.pool.query("DELETE FROM orders WHERE id = $1", [orderId]), {
        code: RESTRICT_VIOLATION,
        constraint: "order_allocations_order_id_fkey",
      });
      await assertDatabaseError(
        db.pool.query("UPDATE warehouses SET id = uuidv7() WHERE id = $1", [warehouseId]),
        { code: RESTRICT_VIOLATION, constraint: "order_allocations_warehouse_id_fkey" },
      );
      await assertDatabaseError(
        db.pool.query("UPDATE orders SET id = uuidv7() WHERE id = $1", [orderId]),
        { code: RESTRICT_VIOLATION, constraint: "order_allocations_order_id_fkey" },
      );

      const remaining = await db.pool.query(
        "SELECT count(*)::int AS allocations FROM order_allocations WHERE order_id = $1",
        [orderId],
      );
      expect(remaining.rows[0]).toStrictEqual({ allocations: 1 });
    });
  });

  describe("money round-trips", () => {
    // Quantity 1 with a full discount lets every stored money column hold the
    // same amount: subtotal = amount, discounted total = 0.00, total = amount.
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
            discountRate: "1.00",
            discountAmount: amount,
            shippingCost: amount,
          },
        });
        expect(formatMoney(order.unitPrice)).toBe(amount);
        expect(formatMoney(order.discountAmount)).toBe(amount);
        expect(formatMoney(order.shippingCost)).toBe(amount);
        const reread = await db.prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { allocations: true },
        });
        const record = toOrderRecord(reread);
        expect({
          unitPrice: record.unitPrice,
          discountAmount: record.discountAmount,
          shippingCost: record.shippingCost,
          merchandiseSubtotal: record.merchandiseSubtotal,
          discountedMerchandiseTotal: record.discountedMerchandiseTotal,
          orderTotal: record.orderTotal,
        }).toStrictEqual({
          unitPrice: amount,
          discountAmount: amount,
          shippingCost: amount,
          merchandiseSubtotal: amount,
          discountedMerchandiseTotal: "0.00",
          orderTotal: amount,
        });
        const raw = await db.pool.query(
          "SELECT unit_price, discount_amount, shipping_cost FROM orders WHERE id = $1",
          [order.id],
        );
        expect(raw.rows).toStrictEqual([
          { unit_price: amount, discount_amount: amount, shipping_cost: amount },
        ]);
      });
    }

    test("amounts beyond NUMERIC(12,2) are rejected rather than stored", async () => {
      // The value overflows while being coerced to the column type, before any
      // CHECK is evaluated.
      for (const column of ["unit_price", "discount_amount", "shipping_cost"] as const) {
        await assertDatabaseError(insertOrder({ quantity: "1", [column]: "10000000000.00" }), {
          code: NUMERIC_OVERFLOW,
        });
      }
      const orderNumber = unique("ORD");
      await expect(
        db.prisma.order.create({
          data: {
            orderNumber,
            submissionKey: unique("attempt"),
            quantity: 1,
            destinationLatitude: 0,
            destinationLongitude: 0,
            unitPrice: "10000000000.00",
            discountRate: "0.00",
            discountAmount: "0.00",
            shippingCost: "0.00",
          },
        }),
      ).rejects.toThrow(/numeric field overflow|22003/i);
      const stored = await db.pool.query("SELECT 1 FROM orders WHERE order_number = $1", [
        orderNumber,
      ]);
      expect(stored.rowCount).toBe(0);
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
          discountRate: "0.05",
          discountAmount: "225.00",
          shippingCost: "123.45",
          allocations: {
            create: [
              { warehouseId: warehouseA, quantity: 20 },
              { warehouseId: warehouseB, quantity: 10 },
            ],
          },
        },
        include: { allocations: { orderBy: { quantity: "desc" } } },
      });

      // merchandiseSubtotal, discountedMerchandiseTotal, and orderTotal are
      // derived by the mapping; the row stores only the facts created above.
      const order = toOrderRecord(created);
      expect({
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
      }).toStrictEqual({
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
      });
      expect(order.createdAt).toBeInstanceOf(Date);

      const byNumber = await db.prisma.order.findUniqueOrThrow({
        where: { orderNumber },
        include: { allocations: true },
      });
      expect(toOrderRecord(byNumber).id).toBe(order.id);

      // The duplicate-submission lookup used by order submission (ADR 0004).
      const byKey = await db.prisma.order.findUniqueOrThrow({ where: { submissionKey } });
      expect(byKey.id).toBe(order.id);
    });
  });
});
