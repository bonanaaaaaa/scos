/**
 * QA API acceptance: unknown routes, and black-box behavior while the
 * database is unreachable (no failure injection: the server is simply pointed
 * at a port that refuses connections).
 *
 * The unreachable-database scenario needs a differently configured server, so
 * it starts its own process from the built artifact instead of using the
 * shared one — which also keeps it identical when the run is pointed at an
 * already-running API.
 *
 * @module
 */

import { expect, test } from "@playwright/test";
import type { Pool } from "pg";

import { type ApiProcess, spawnApi, stopAllApiProcesses } from "#test/support/api-process";
import { openPool, resetDatabase } from "#test/support/database";
import { formatTitle } from "#test/support/each";
import { expectErrorEnvelope, expectJson, get, postJson, request } from "#test/support/http";
import { AT_PARIS } from "#test/support/prd";
import { acceptanceDatabaseUrl, sharedApi } from "#test/support/shared-api";

const api = sharedApi();

// Any extra listener a test started, in case an assertion threw before its
// own cleanup ran.
test.afterAll(stopAllApiProcesses);

test.describe("unknown routes and methods", () => {
  let pool: Pool;

  test.beforeAll(async () => {
    pool = openPool(acceptanceDatabaseUrl());
    await resetDatabase(pool);
  });

  test.afterAll(async () => {
    await pool.end();
  });

  for (const testCase of [
    ["GET", "/"],
    ["GET", "/nope"],
    ["GET", "/api/v1/orders"],
    ["GET", "/api/v1/orders/verify"],
    ["POST", "/health"],
    ["PUT", "/api/v1/orders"],
    ["DELETE", "/api/v1/orders"],
    ["PATCH", "/api/v1/orders/verify"],
    ["POST", "/api/v1/orders/verify/extra"],
    ["POST", "/order"],
  ] as const) {
    const [method, path] = testCase;
    test(formatTitle("%s %s is 404 NOT_FOUND in the envelope", testCase), async () => {
      const response = await request(api, path, {
        method,
        contentType: method === "GET" || method === "DELETE" ? null : "application/json",
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      expectErrorEnvelope(response, 404, "NOT_FOUND", { issues: "absent" });
    });
  }
});

test.describe("database unreachable", () => {
  // Port 1 (tcpmux) is privileged and not listening, so connections are refused
  // at once. An ephemeral "closed" port could be reused by a parallel test file.
  const databaseUrl = "postgresql://qa_user:qa-secret-password@127.0.0.1:1/scos_unreachable";
  let unreachable: ApiProcess;

  test.beforeAll(async () => {
    // The server starts: /health does not touch the database.
    unreachable = await spawnApi({ databaseUrl });
  });

  test.afterAll(async () => {
    await unreachable?.stop();
  });

  test('GET /health is still 200 {"status":"ok"}', async () => {
    expect(expectJson(await get(unreachable, "/health"), 200)).toStrictEqual({ status: "ok" });
  });

  for (const testCase of [
    ["/api/v1/orders/verify", { quantity: 5, ...AT_PARIS }],
    ["/api/v1/orders", { submissionId: "qa-down", quantity: 5, ...AT_PARIS }],
  ] as const) {
    const [path, body] = testCase;
    test(
      formatTitle(
        "POST %s is a 500 or 503 envelope that exposes no internals and never implies acceptance",
        testCase,
      ),
      async () => {
        const response = await postJson(unreachable, path, body);
        expect([500, 503]).toContain(response.status);
        const code = response.status === 503 ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR";
        expectErrorEnvelope(response, response.status, code, { issues: "absent" });
        for (const secret of [
          "qa-secret-password",
          "qa_user",
          "scos_unreachable",
          "127.0.0.1",
          "ECONNREFUSED",
          "prisma",
          "Prisma",
          "stack",
          "    at ",
        ]) {
          expect(response.text).not.toContain(secret);
        }
        expect(response.text).not.toMatch(/orderNumber|allocations|orderTotal/);
        if (response.status === 503) {
          expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
        }
      },
    );
  }
});
