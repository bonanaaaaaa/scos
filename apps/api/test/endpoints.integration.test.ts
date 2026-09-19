import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  type ComposedApplication,
  composeHealthApplication,
  composeSubmitOrderApplication,
  composeVerifyOrderApplication,
} from "../src/composition";
import { orderResponseSchema, verifyOrderResponseSchema } from "../src/http/contracts";
import { AT_PARIS, PARIS, postJson, silentLogger, snapshot } from "./support/app";
import { type TestDatabase, createTestDatabase, readState, stockById } from "./support/database";

let db: TestDatabase;
const opened: ComposedApplication[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.reset();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((composed) => composed.close()));
});

function track(composed: ComposedApplication): ComposedApplication {
  opened.push(composed);
  return composed;
}

async function backends(): Promise<number> {
  const result = await db.pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()",
  );
  return result.rows[0]?.count ?? 0;
}

describe("per-endpoint compositions against PostgreSQL", () => {
  test("verify and submit run as separate apps over separate pools", async () => {
    const baseline = await backends();
    const verify = track(
      composeVerifyOrderApplication({ databaseUrl: db.url, logger: silentLogger }),
    );
    const submit = track(
      composeSubmitOrderApplication({ databaseUrl: db.url, logger: silentLogger }),
    );
    const health = composeHealthApplication();
    const stockBefore = await stockById(db.pool);

    // Each app serves only its own route.
    expect((await health.app.request("/health")).status).toBe(200);
    expect((await postJson(verify, "/orders", { submissionId: "x" })).status).toBe(404);
    expect((await postJson(submit, "/orders/verify", {})).status).toBe(404);

    const before = verifyOrderResponseSchema.parse(
      (await snapshot(postJson(verify, "/orders/verify", { quantity: 700, ...AT_PARIS }))).json(),
    );
    expect(before.allocations[0]).toMatchObject({ warehouseId: PARIS, quantity: 694 });

    const body = { submissionId: "endpoint-1", quantity: 100, ...AT_PARIS };
    const first = await snapshot(postJson(submit, "/orders", body));
    expect(first.status, first.text).toBe(201);
    expect(orderResponseSchema.parse(first.json()).allocations).toStrictEqual([
      { warehouseId: PARIS, quantity: 100 },
    ]);

    // Verification, on its own pool, sees the deducted stock.
    const after = verifyOrderResponseSchema.parse(
      (await snapshot(postJson(verify, "/orders/verify", { quantity: 700, ...AT_PARIS }))).json(),
    );
    expect(after.allocations[0]).toMatchObject({ warehouseId: PARIS, quantity: 594 });
    expect(await stockById(db.pool)).toStrictEqual({
      ...stockBefore,
      [PARIS]: (stockBefore[PARIS] ?? 0) - 100,
    });
    // Two pools, each holding its own idle connection.
    expect(await backends()).toBeGreaterThanOrEqual(baseline + 2);

    // A repeat returns the original Order without another deduction, and the
    // verify app keeps working after the submit app is closed.
    const state = await readState(db.pool);
    const repeat = await snapshot(postJson(submit, "/orders", body));
    expect(repeat.status).toBe(201);
    expect(repeat.text).toBe(first.text);
    expect(await readState(db.pool)).toStrictEqual(state);

    await submit.close();
    const stillServing = await snapshot(
      postJson(verify, "/orders/verify", { quantity: 1, ...AT_PARIS }),
    );
    expect(stillServing.status).toBe(200);
  });

  test("a repeat through a fresh submit composition returns the original Order", async () => {
    const body = { submissionId: "endpoint-2", quantity: 30, ...AT_PARIS };
    const first = await snapshot(
      postJson(track(composeSubmitOrderApplication({ databaseUrl: db.url })), "/orders", body),
    );
    expect(first.status, first.text).toBe(201);
    const state = await readState(db.pool);

    const repeat = await snapshot(
      postJson(track(composeSubmitOrderApplication({ databaseUrl: db.url })), "/orders", body),
    );

    expect(repeat.status).toBe(201);
    expect(repeat.text).toBe(first.text);
    expect(await readState(db.pool)).toStrictEqual(state);
  });
});
