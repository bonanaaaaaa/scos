import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { expect, test } from "vitest";

const databaseTestUrl = process.env.DATABASE_TEST_URL;

test(
  "real PostgreSQL transactions roll back without retaining test rows",
  { timeout: 20_000 },
  async () => {
    // expect.assert narrows databaseTestUrl to a truthy string for the checks below.
    expect.assert(databaseTestUrl, "DATABASE_TEST_URL must point to the isolated test database");
    expect(databaseTestUrl, "DATABASE_TEST_URL must differ from DATABASE_URL").not.toBe(
      process.env.DATABASE_URL,
    );
    expect(
      new URL(databaseTestUrl).pathname,
      "DATABASE_TEST_URL must name the dedicated scos_test database",
    ).toBe("/scos_test");

    const client = new Client({
      connectionString: databaseTestUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    const schema = `integration_${randomUUID().replaceAll("-", "")}`;

    let testFailure: unknown;
    let connected = false;
    try {
      await client.connect();
      connected = true;

      const database = await client.query<{ name: string }>("SELECT current_database() AS name");
      expect(database.rows[0]?.name).toBe("scos_test");

      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${schema}.rollback_probe (id integer PRIMARY KEY)`);
      await client.query("BEGIN");
      await client.query(`INSERT INTO ${schema}.rollback_probe (id) VALUES ($1)`, [1]);

      const insideTransaction = await client.query<{ count: string }>(
        `SELECT count(*) FROM ${schema}.rollback_probe`,
      );
      expect(insideTransaction.rows[0]?.count).toBe("1");

      await client.query("ROLLBACK");

      const afterRollback = await client.query<{ count: string }>(
        `SELECT count(*) FROM ${schema}.rollback_probe`,
      );
      expect(afterRollback.rows[0]?.count).toBe("0");
    } catch (error) {
      testFailure = error;
    }

    const cleanupFailures: unknown[] = [];
    if (connected) {
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await client.end();
    } catch (error) {
      cleanupFailures.push(error);
    }

    if (testFailure !== undefined && cleanupFailures.length > 0) {
      throw new AggregateError(
        [testFailure, ...cleanupFailures],
        "Integration assertion and database cleanup both failed",
      );
    }
    if (testFailure !== undefined) {
      throw testFailure;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Database cleanup failed");
    }
  },
);
