/**
 * QA API acceptance: unknown routes, and black-box behavior while the
 * database is unreachable (no failure injection: the server is simply pointed
 * at a port that refuses connections).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type TestDatabase, createTestDatabase } from "../support/database";
import {
  AT_PARIS,
  type RunningApi,
  expectErrorEnvelope,
  expectJson,
  get,
  postJson,
  request,
  startApi,
} from "./support";

describe("unknown routes and methods", () => {
  let db: TestDatabase;
  let api: RunningApi;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.reset();
    api = await startApi(db.url);
  });

  afterAll(async () => {
    await api?.stop();
    await db?.drop();
  });

  test.each([
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
  ])("%s %s is 404 NOT_FOUND in the envelope", async (method, path) => {
    const response = await request(api, path, {
      method,
      contentType: method === "GET" || method === "DELETE" ? null : "application/json",
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    });
    expectErrorEnvelope(response, 404, "NOT_FOUND", { issues: "absent" });
  });
});

describe("database unreachable", () => {
  let api: RunningApi;
  let databaseUrl: string;

  beforeAll(async () => {
    // Port 1 (tcpmux) is privileged and not listening, so connections are refused
    // at once. An ephemeral "closed" port could be reused by a parallel test file.
    databaseUrl = "postgresql://qa_user:qa-secret-password@127.0.0.1:1/scos_unreachable";
    api = await startApi(databaseUrl);
  });

  afterAll(async () => {
    await api?.stop();
  });

  test('GET /health is still 200 {"status":"ok"}', async () => {
    expect(expectJson(await get(api, "/health"), 200)).toStrictEqual({ status: "ok" });
  });

  test.each([
    ["/api/v1/orders/verify", { quantity: 5, ...AT_PARIS }],
    ["/api/v1/orders", { submissionId: "qa-down", quantity: 5, ...AT_PARIS }],
  ])(
    "POST %s is a 500 or 503 envelope that exposes no internals and never implies acceptance",
    async (path, body) => {
      const response = await postJson(api, path, body);
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
});
