import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, test } from "vitest";

import {
  formatMoney,
  toOrderRecord,
  toSubmissionRecord,
  toSubmissionRejectionRecord,
} from "../src/records.js";
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

const applicationTables = [
  "customer_order",
  "order_allocation",
  "rejection_reason",
  "submission",
  "submission_outcome",
  "submission_rejection",
  "warehouse",
];

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

async function insertSubmission(outcome: "ACCEPTED" | "REJECTED", quantity = 10): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO submission (submission_key, quantity, destination_latitude, destination_longitude, outcome)
     VALUES ($1, $2, 1.5, -2.5, $3) RETURNING id`,
    [unique("attempt"), quantity, outcome],
  );
  return result.rows[0]!.id;
}

const acceptedAmounts = {
  unit_price: "150.00",
  merchandise_subtotal: "1500.00",
  discount_rate: "0.0000",
  discount_amount: "0.00",
  discounted_merchandise_total: "1500.00",
  shipping_cost: "10.00",
  order_total: "1510.00",
};

async function insertOrder(
  submissionId: string,
  overrides: Partial<
    Record<keyof typeof acceptedAmounts | "submission_outcome" | "order_number", string>
  > = {},
): Promise<string> {
  const row: Record<string, string> = {
    order_number: unique("ORD"),
    submission_id: submissionId,
    ...acceptedAmounts,
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

async function insertRejection(
  submissionId: string,
  reason: string,
  shippingCost: string | null,
  orderTotal: string | null,
  outcome = "REJECTED",
) {
  await db.pool.query(
    `INSERT INTO submission_rejection (submission_id, submission_outcome, reason, unit_price,
       merchandise_subtotal, discount_rate, discount_amount, discounted_merchandise_total,
       shipping_cost, order_total)
     VALUES ($1, $2, $3, '150.00', '1500.00', '0.0000', '0.00', '1500.00', $4, $5)`,
    [submissionId, outcome, reason, shippingCost, orderTotal],
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

    test("insert lookup values with descriptions and timestamps", async () => {
      const outcomes = await db.pool.query(
        `SELECT value, description IS NOT NULL AS described, created_at = updated_at AS fresh
         FROM submission_outcome ORDER BY value`,
      );
      assert.deepEqual(outcomes.rows, [
        { value: "ACCEPTED", described: true, fresh: true },
        { value: "REJECTED", described: true, fresh: true },
      ]);
      const reasons = await db.pool.query(
        `SELECT value, description IS NOT NULL AS described, created_at = updated_at AS fresh
         FROM rejection_reason ORDER BY value`,
      );
      assert.deepEqual(reasons.rows, [
        { value: "INSUFFICIENT_STOCK", described: true, fresh: true },
        { value: "SHIPPING_EXCEEDS_LIMIT", described: true, fresh: true },
      ]);
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
        const submission = await tx.submission.create({
          data: {
            submissionKey: unique("attempt"),
            quantity: 1,
            destinationLatitude: 0,
            destinationLongitude: 0,
            outcome: "REJECTED",
          },
        });
        return tx.$queryRaw<{ equal: boolean; at_now: boolean }[]>`
          SELECT w.created_at = w.updated_at AND s.created_at = s.updated_at AS equal,
                 w.created_at = NOW() AND s.created_at = NOW() AS at_now
          FROM warehouse w, submission s
          WHERE w.id = ${warehouse.id}::uuid AND s.id = ${submission.id}::uuid`;
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
        const submission = await client.query<{ id: string }>(
          `INSERT INTO submission (submission_key, quantity, destination_latitude, destination_longitude, outcome)
           VALUES ($1, 1, 0, 0, 'REJECTED') RETURNING id`,
          [unique("txn")],
        );
        const check = await client.query(
          `SELECT w.created_at = NOW() AND w.updated_at = NOW()
                  AND s.created_at = NOW() AND s.updated_at = NOW() AS shared,
                  clock_timestamp() > NOW() + interval '30 milliseconds' AS time_passed,
                  w.stock
           FROM warehouse w, submission s WHERE w.id = $1 AND s.id = $2`,
          [id, submission.rows[0]!.id],
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

    test("lookup table updates are covered by the trigger", async () => {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const before = await client.query<{ created_at: string }>(
          "SELECT created_at::text AS created_at FROM rejection_reason WHERE value = 'INSUFFICIENT_STOCK'",
        );
        const updated = await client.query(
          `UPDATE rejection_reason SET description = description, updated_at = '1999-01-01Z'
           WHERE value = 'INSUFFICIENT_STOCK'
           RETURNING created_at = $1::timestamptz AS created_kept, updated_at = NOW() AS updated_now`,
          [before.rows[0]!.created_at],
        );
        assert.deepEqual(updated.rows[0], { created_kept: true, updated_now: true });
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
      const submission = await db.prisma.submission.create({
        data: {
          submissionKey: unique("attempt"),
          quantity: 1,
          destinationLatitude: 0,
          destinationLongitude: 0,
          outcome: "ACCEPTED",
        },
      });
      const orderId = await insertOrder(submission.id);
      await insertAllocation(orderId, warehouseId);
      const versions = await db.pool.query(
        `SELECT
           (SELECT uuid_extract_version(id) FROM warehouse WHERE id = $1) AS warehouse,
           (SELECT uuid_extract_version(id) FROM submission WHERE id = $2) AS submission,
           (SELECT uuid_extract_version(id) FROM customer_order WHERE id = $3) AS "order",
           (SELECT uuid_extract_version(id) FROM order_allocation WHERE order_id = $3) AS allocation`,
        [warehouseId, submission.id, orderId],
      );
      assert.deepEqual(versions.rows[0], { warehouse: 7, submission: 7, order: 7, allocation: 7 });
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

    test("submissions require a unique nonblank key of at most 255 characters, positive quantity, and bounded destination", async () => {
      const key = unique("attempt");
      const insert = (submissionKey: string, quantity: number, latitude = 0, longitude = 0) =>
        db.pool.query(
          `INSERT INTO submission (submission_key, quantity, destination_latitude, destination_longitude, outcome)
           VALUES ($1, $2, $3, $4, 'ACCEPTED')`,
          [submissionKey, quantity, latitude, longitude],
        );
      await insert(key, 1);
      await assertDatabaseError(insert(key, 1), {
        code: UNIQUE_VIOLATION,
        constraint: "submission_submission_key_key",
      });
      await assertDatabaseError(insert("", 1), {
        code: CHECK_VIOLATION,
        constraint: "submission_submission_key_check",
      });
      await assertDatabaseError(insert("   ", 1), {
        code: CHECK_VIOLATION,
        constraint: "submission_submission_key_check",
      });
      await assertDatabaseError(insert(`k${randomUUID()}`.padEnd(256, "x"), 1), {
        code: CHECK_VIOLATION,
        constraint: "submission_submission_key_check",
      });
      const longestKey = `k${randomUUID()}`.padEnd(255, "x");
      assert.equal(longestKey.length, 255);
      await insert(longestKey, 1);
      const stored = await db.pool.query<{ length: number }>(
        "SELECT char_length(submission_key) AS length FROM submission WHERE submission_key = $1",
        [longestKey],
      );
      assert.deepEqual(stored.rows, [{ length: 255 }]);
      await assertDatabaseError(insert(unique("attempt"), 0), {
        code: CHECK_VIOLATION,
        constraint: "submission_quantity_check",
      });
      await assertDatabaseError(insert(unique("attempt"), 1, 91, 0), {
        code: CHECK_VIOLATION,
        constraint: "submission_destination_latitude_check",
      });
      await assertDatabaseError(insert(unique("attempt"), 1, 0, -180.5), {
        code: CHECK_VIOLATION,
        constraint: "submission_destination_longitude_check",
      });
      await assertDatabaseError(
        db.pool.query(
          `INSERT INTO submission (submission_key, quantity, destination_latitude, destination_longitude, outcome)
           VALUES ($1, 1, 0, 0, 'PENDING')`,
          [unique("attempt")],
        ),
        { code: FOREIGN_KEY_VIOLATION, constraint: "submission_outcome_fkey" },
      );
    });

    test("one accepted Order per submission, never on a rejected submission", async () => {
      const accepted = await insertSubmission("ACCEPTED");
      await insertOrder(accepted);
      await assertDatabaseError(insertOrder(accepted), {
        code: UNIQUE_VIOLATION,
        constraint: "customer_order_submission_id_key",
      });

      const rejected = await insertSubmission("REJECTED");
      await assertDatabaseError(insertOrder(rejected), {
        code: FOREIGN_KEY_VIOLATION,
        constraint: "customer_order_submission_fkey",
      });
      await assertDatabaseError(insertOrder(rejected, { submission_outcome: "REJECTED" }), {
        code: CHECK_VIOLATION,
        constraint: "customer_order_submission_outcome_check",
      });
      await assertDatabaseError(insertOrder(randomUUID()), {
        code: FOREIGN_KEY_VIOLATION,
        constraint: "customer_order_submission_fkey",
      });

      const other = await insertSubmission("ACCEPTED");
      const orderNumber = unique("ORD");
      await insertOrder(other, { order_number: orderNumber });
      await assertDatabaseError(
        insertOrder(await insertSubmission("ACCEPTED"), { order_number: orderNumber }),
        { code: UNIQUE_VIOLATION, constraint: "customer_order_order_number_key" },
      );
    });

    test("an accepted submission's outcome cannot be changed once it has an Order", async () => {
      const accepted = await insertSubmission("ACCEPTED");
      await insertOrder(accepted);
      await assertDatabaseError(
        db.pool.query("UPDATE submission SET outcome = 'REJECTED' WHERE id = $1", [accepted]),
        { code: RESTRICT_VIOLATION, constraint: "customer_order_submission_fkey" },
      );
    });

    test("Order snapshots are nonnegative and arithmetically consistent", async () => {
      const cases: [Partial<Record<keyof typeof acceptedAmounts, string>>, string][] = [
        [{ order_total: "1510.01" }, "customer_order_order_total_check"],
        [
          { discounted_merchandise_total: "1499.00", order_total: "1509.00" },
          "customer_order_discounted_merchandise_total_check",
        ],
        [{ discount_rate: "1.5000" }, "customer_order_discount_rate_check"],
        [{ discount_rate: "-0.0100" }, "customer_order_discount_rate_check"],
        [{ unit_price: "-1.00" }, "customer_order_unit_price_check"],
        [{ shipping_cost: "-10.00", order_total: "1490.00" }, "customer_order_shipping_cost_check"],
      ];
      for (const [overrides, constraint] of cases) {
        await assertDatabaseError(insertOrder(await insertSubmission("ACCEPTED"), overrides), {
          code: CHECK_VIOLATION,
          constraint,
        });
      }
      await insertOrder(await insertSubmission("ACCEPTED"), {
        discount_rate: "0.1500",
        discount_amount: "225.00",
        discounted_merchandise_total: "1275.00",
        shipping_cost: "0.00",
        order_total: "1275.00",
      });
    });

    test("allocations are positive, unique per warehouse, and reference existing rows", async () => {
      const warehouseId = await insertWarehouse();
      const orderId = await insertOrder(await insertSubmission("ACCEPTED"));
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

    test("rejections reference rejected submissions and valid reasons with consistent amounts", async () => {
      await insertRejection(await insertSubmission("REJECTED"), "INSUFFICIENT_STOCK", null, null);
      await insertRejection(
        await insertSubmission("REJECTED"),
        "SHIPPING_EXCEEDS_LIMIT",
        "300.00",
        "1800.00",
      );

      await assertDatabaseError(
        insertRejection(
          await insertSubmission("REJECTED"),
          "INSUFFICIENT_STOCK",
          "10.00",
          "1510.00",
        ),
        { code: CHECK_VIOLATION, constraint: "submission_rejection_reason_amounts_check" },
      );
      await assertDatabaseError(
        insertRejection(await insertSubmission("REJECTED"), "INSUFFICIENT_STOCK", "10.00", null),
        { code: CHECK_VIOLATION, constraint: "submission_rejection_reason_amounts_check" },
      );
      await assertDatabaseError(
        insertRejection(await insertSubmission("REJECTED"), "SHIPPING_EXCEEDS_LIMIT", null, null),
        { code: CHECK_VIOLATION, constraint: "submission_rejection_reason_amounts_check" },
      );
      await assertDatabaseError(
        insertRejection(
          await insertSubmission("REJECTED"),
          "SHIPPING_EXCEEDS_LIMIT",
          "300.00",
          "1799.99",
        ),
        { code: CHECK_VIOLATION, constraint: "submission_rejection_order_total_check" },
      );
      // The reason/amount CHECK rejects unknown reasons before the foreign key
      // is evaluated; the reason foreign key is exercised by the restricted
      // lookup deletion below.
      await assertDatabaseError(
        insertRejection(await insertSubmission("REJECTED"), "OUT_OF_STOCK", null, null),
        { code: CHECK_VIOLATION, constraint: "submission_rejection_reason_amounts_check" },
      );
      await assertDatabaseError(
        insertRejection(await insertSubmission("ACCEPTED"), "INSUFFICIENT_STOCK", null, null),
        { code: FOREIGN_KEY_VIOLATION, constraint: "submission_rejection_submission_fkey" },
      );
      await assertDatabaseError(
        insertRejection(
          await insertSubmission("ACCEPTED"),
          "INSUFFICIENT_STOCK",
          null,
          null,
          "ACCEPTED",
        ),
        { code: CHECK_VIOLATION, constraint: "submission_rejection_submission_outcome_check" },
      );
      const once = await insertSubmission("REJECTED");
      await insertRejection(once, "INSUFFICIENT_STOCK", null, null);
      await assertDatabaseError(insertRejection(once, "INSUFFICIENT_STOCK", null, null), {
        code: UNIQUE_VIOLATION,
        constraint: "submission_rejection_pkey",
      });
    });

    test("lookup values must be uppercase identifiers", async () => {
      await assertDatabaseError(
        db.pool.query("INSERT INTO submission_outcome (value) VALUES ('accepted')"),
        { code: CHECK_VIOLATION, constraint: "submission_outcome_value_check" },
      );
      await assertDatabaseError(
        db.pool.query("INSERT INTO rejection_reason (value) VALUES ('BAD-CODE')"),
        { code: CHECK_VIOLATION, constraint: "rejection_reason_value_check" },
      );
    });

    test("historical records cannot be deleted through referenced rows", async () => {
      const warehouseId = await insertWarehouse();
      const submissionId = await insertSubmission("ACCEPTED");
      const orderId = await insertOrder(submissionId);
      await insertAllocation(orderId, warehouseId);
      const rejectedId = await insertSubmission("REJECTED");
      await insertRejection(rejectedId, "INSUFFICIENT_STOCK", null, null);

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
        db.pool.query("DELETE FROM submission WHERE id = $1", [submissionId]),
        {
          code: RESTRICT_VIOLATION,
          constraint: "customer_order_submission_fkey",
        },
      );
      await assertDatabaseError(
        db.pool.query("DELETE FROM submission WHERE id = $1", [rejectedId]),
        {
          code: RESTRICT_VIOLATION,
          constraint: "submission_rejection_submission_fkey",
        },
      );
      await assertDatabaseError(
        db.pool.query("DELETE FROM submission_outcome WHERE value = 'ACCEPTED'"),
        { code: RESTRICT_VIOLATION, constraint: "submission_outcome_fkey" },
      );
      await assertDatabaseError(
        db.pool.query("DELETE FROM rejection_reason WHERE value = 'INSUFFICIENT_STOCK'"),
        { code: RESTRICT_VIOLATION, constraint: "submission_rejection_reason_fkey" },
      );
      await assertDatabaseError(
        db.pool.query("UPDATE warehouse SET id = uuidv7() WHERE id = $1", [warehouseId]),
        { code: RESTRICT_VIOLATION, constraint: "order_allocation_warehouse_id_fkey" },
      );

      const remaining = await db.pool.query(
        `SELECT (SELECT count(*) FROM order_allocation WHERE order_id = $1)::int AS allocations,
                (SELECT count(*) FROM submission_rejection WHERE submission_id = $2)::int AS rejections`,
        [orderId, rejectedId],
      );
      assert.deepEqual(remaining.rows[0], { allocations: 1, rejections: 1 });
    });
  });

  describe("money and outcome round-trips", () => {
    for (const amount of ["0.00", "0.01", "9999999999.99"]) {
      test(`NUMERIC(12,2) round-trips ${amount} exactly through Prisma and pg`, async () => {
        const submission = await db.prisma.submission.create({
          data: {
            submissionKey: unique("money"),
            quantity: 1,
            destinationLatitude: 0,
            destinationLongitude: 0,
            outcome: "ACCEPTED",
          },
        });
        const order = await db.prisma.order.create({
          data: {
            orderNumber: unique("ORD"),
            submissionId: submission.id,
            unitPrice: amount,
            merchandiseSubtotal: amount,
            discountRate: "0.0000",
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
        insertOrder(await insertSubmission("ACCEPTED"), {
          unit_price: "10000000000.00",
        }),
        { code: NUMERIC_OVERFLOW },
      );
      const submission = await insertSubmission("ACCEPTED");
      await assert.rejects(
        db.prisma.order.create({
          data: {
            orderNumber: unique("ORD"),
            submissionId: submission,
            unitPrice: "10000000000.00",
            merchandiseSubtotal: "10000000000.00",
            discountRate: "0.0000",
            discountAmount: "0.00",
            discountedMerchandiseTotal: "10000000000.00",
            shippingCost: "0.00",
            orderTotal: "10000000000.00",
          },
        }),
        /numeric field overflow|22003/i,
      );
      const stored = await db.pool.query("SELECT 1 FROM customer_order WHERE submission_id = $1", [
        submission,
      ]);
      assert.equal(stored.rowCount, 0);
    });

    test("an accepted outcome round-trips through Prisma and the typed mappings", async () => {
      const warehouseA = await insertWarehouse(100);
      const warehouseB = await insertWarehouse(100);
      const key = unique("accepted");
      const submission = await db.prisma.submission.create({
        data: {
          submissionKey: key,
          quantity: 30,
          destinationLatitude: 13.7563,
          destinationLongitude: 100.5018,
          outcome: "ACCEPTED",
          order: {
            create: {
              orderNumber: unique("ORD"),
              unitPrice: "150.00",
              merchandiseSubtotal: "4500.00",
              discountRate: "0.0500",
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
          },
        },
        include: { order: { include: { allocations: { orderBy: { quantity: "desc" } } } } },
      });

      const submissionRecord = toSubmissionRecord(submission);
      assert.equal(submissionRecord.outcome, "ACCEPTED");
      assert.deepEqual(submissionRecord.destination, { latitude: 13.7563, longitude: 100.5018 });
      assert.ok(submission.order);
      const order = toOrderRecord(submission.order);
      assert.deepEqual(
        {
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
          unitPrice: "150.00",
          merchandiseSubtotal: "4500.00",
          discountRate: "0.0500",
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

      const byKey = await db.prisma.submission.findUniqueOrThrow({
        where: { submissionKey: key },
        include: { order: { include: { allocations: true } }, rejection: true },
      });
      assert.equal(byKey.rejection, null);
      assert.equal(toOrderRecord(byKey.order!).id, order.id);
    });

    test("both rejection outcomes round-trip through Prisma and the typed mappings", async () => {
      const insufficient = await db.prisma.submission.create({
        data: {
          submissionKey: unique("rejected"),
          quantity: 5000,
          destinationLatitude: 0,
          destinationLongitude: 0,
          outcome: "REJECTED",
          rejection: {
            create: {
              reason: "INSUFFICIENT_STOCK",
              unitPrice: "150.00",
              merchandiseSubtotal: "750000.00",
              discountRate: "0.2000",
              discountAmount: "150000.00",
              discountedMerchandiseTotal: "600000.00",
            },
          },
        },
        include: { rejection: true, order: true },
      });
      assert.equal(toSubmissionRecord(insufficient).outcome, "REJECTED");
      assert.equal(insufficient.order, null);
      assert.deepEqual(toSubmissionRejectionRecord(insufficient.rejection!), {
        submissionId: insufficient.id,
        reason: "INSUFFICIENT_STOCK",
        unitPrice: "150.00",
        merchandiseSubtotal: "750000.00",
        discountRate: "0.2000",
        discountAmount: "150000.00",
        discountedMerchandiseTotal: "600000.00",
        shippingCost: null,
        orderTotal: null,
        createdAt: insufficient.rejection!.createdAt,
        updatedAt: insufficient.rejection!.updatedAt,
      });

      const excessive = await db.prisma.submission.create({
        data: {
          submissionKey: unique("rejected"),
          quantity: 1,
          destinationLatitude: -89.9,
          destinationLongitude: 179.9,
          outcome: "REJECTED",
          rejection: {
            create: {
              reason: "SHIPPING_EXCEEDS_LIMIT",
              unitPrice: "150.00",
              merchandiseSubtotal: "150.00",
              discountRate: "0.0000",
              discountAmount: "0.00",
              discountedMerchandiseTotal: "150.00",
              shippingCost: "22.51",
              orderTotal: "172.51",
            },
          },
        },
        include: { rejection: true },
      });
      const record = toSubmissionRejectionRecord(excessive.rejection!);
      assert.equal(record.reason, "SHIPPING_EXCEEDS_LIMIT");
      assert.equal(record.shippingCost, "22.51");
      assert.equal(record.orderTotal, "172.51");
    });
  });
});
