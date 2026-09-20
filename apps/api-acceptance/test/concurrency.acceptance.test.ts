/**
 * QA API acceptance: a bounded batch of concurrent POST /api/v1/orders over
 * the served API and the acceptance database with scarce stock.
 *
 * Only invariants are asserted (no oversell, no negative stock, at most one
 * Order per submissionId, documented statuses only). Timing is measured and
 * reported on one `SCOS_CONCURRENCY_REPORT ` line; no latency or throughput
 * target is asserted or implied.
 *
 * @module
 */

import type { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  lockWaiters,
  openPool,
  readState,
  resetDatabase,
  setAllStock,
  stockById,
} from "./support/database";
import { type HttpResult, expectErrorEnvelope, expectJson, postJson } from "./support/http";
import { expectedOrder } from "./support/oracle";
import { AT_PARIS, warehouse } from "./support/prd";
import { acceptanceDatabaseUrl, sharedApi } from "./support/shared-api";

const api = sharedApi();
let pool: Pool;

beforeAll(async () => {
  pool = openPool(acceptanceDatabaseUrl());
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

/** Fixed parameters of the measured batch. */
const PARAMETERS = {
  requests: 30,
  maxInFlight: 10,
  distinctSubmissions: 24,
  sharedSubmissionRepeats: 6,
  quantityPerRequest: 2,
  initialStock: { Paris: 25 },
  destination: "Paris warehouse (zero shipping)",
} as const;

const SHARED_ID = "qa-conc-shared";

interface Outcome {
  readonly submissionId: string;
  readonly response: HttpResult;
  readonly durationMs: number;
}

/** Runs `tasks` with at most `limit` in flight, preserving result order. */
async function withConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task !== undefined) {
        results[index] = await task();
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const round = (value: number) => Math.round(value * 100) / 100;

test("a bounded concurrent batch never oversells, never duplicates an Order and returns only documented statuses", async () => {
  const paris = warehouse("Paris").id;
  await setAllStock(pool, { [paris]: PARAMETERS.initialStock.Paris });
  const stockBefore = await stockById(pool);
  const initialTotal = Object.values(stockBefore).reduce((sum, value) => sum + value, 0);
  expect(initialTotal).toBe(PARAMETERS.initialStock.Paris);

  // Demand (24 + 1) x 2 = 50 units against 25 in stock: real contention.
  // The shared submissionId is spread through the batch so its repeats overlap
  // distinct submissions and each other.
  const submissionIds: string[] = [];
  let distinct = 0;
  for (let index = 0; index < PARAMETERS.requests; index += 1) {
    if (index % 5 === 2) {
      submissionIds.push(SHARED_ID);
    } else {
      submissionIds.push(`qa-conc-${distinct}`);
      distinct += 1;
    }
  }
  expect(distinct).toBe(PARAMETERS.distinctSubmissions);
  expect(submissionIds.filter((id) => id === SHARED_ID)).toHaveLength(
    PARAMETERS.sharedSubmissionRepeats,
  );

  // Lock waiters sampled from a separate connection throughout the run.
  let sampling = true;
  let peakLockWaiters = 0;
  let samples = 0;
  const sampler = (async () => {
    while (sampling) {
      peakLockWaiters = Math.max(peakLockWaiters, await lockWaiters(pool));
      samples += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();

  const started = performance.now();
  let outcomes: Outcome[];
  try {
    outcomes = await withConcurrency(
      submissionIds.map((submissionId) => async () => {
        const begin = performance.now();
        const response = await postJson(api, "/api/v1/orders", {
          submissionId,
          quantity: PARAMETERS.quantityPerRequest,
          ...AT_PARIS,
        });
        return { submissionId, response, durationMs: performance.now() - begin };
      }),
      PARAMETERS.maxInFlight,
    );
  } finally {
    sampling = false;
    await sampler;
  }
  const wallTimeMs = performance.now() - started;

  // Every response is 201, 422 or a documented 503 with Retry-After; never 500.
  const statusCounts: Record<string, number> = {};
  for (const { response } of outcomes) {
    statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
  }
  const acceptedOrders = new Map<string, { submissionId: string; quantity: number }>();
  const sharedAcceptedTexts = new Set<string>();
  for (const { submissionId, response } of outcomes) {
    expect([201, 422, 503], response.text).toContain(response.status);
    if (response.status === 201) {
      const order = expectJson(response, 201) as {
        orderNumber: string;
        submissionId: string;
        quantity: number;
      };
      expect(order).toStrictEqual(
        expectedOrder(submissionId, PARAMETERS.quantityPerRequest, AT_PARIS),
      );
      acceptedOrders.set(order.orderNumber, order);
      if (submissionId === SHARED_ID) {
        sharedAcceptedTexts.add(response.text);
      }
    } else if (response.status === 422) {
      const body = expectJson(response, 422) as { error: { code: string } };
      expect(body.error.code).toBe("INSUFFICIENT_STOCK");
    } else {
      expectErrorEnvelope(response, 503, "SERVICE_UNAVAILABLE", { issues: "absent" });
      expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    }
  }

  // At most one Order per submissionId, in the responses and in the database.
  const acceptedIds = [...acceptedOrders.values()].map((order) => order.submissionId);
  expect(new Set(acceptedIds).size).toBe(acceptedIds.length);
  expect(sharedAcceptedTexts.size).toBeLessThanOrEqual(1);
  const state = await readState(pool);
  const keys = state.orders.map((order) => order.submission_key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(state.orders.map((order) => order.order_number).sort()).toStrictEqual(
    [...acceptedOrders.keys()].sort(),
  );

  // No negative stock; accepted units equal the stock consumed and never exceed it.
  const stockAfter = await stockById(pool);
  for (const value of Object.values(stockAfter)) {
    expect(value).toBeGreaterThanOrEqual(0);
  }
  const consumed = initialTotal - Object.values(stockAfter).reduce((sum, value) => sum + value, 0);
  const acceptedUnits = [...acceptedOrders.values()].reduce(
    (sum, order) => sum + order.quantity,
    0,
  );
  expect(acceptedUnits).toBe(consumed);
  expect(state.orders.reduce((sum, order) => sum + order.quantity, 0)).toBe(consumed);
  expect(state.allocations.reduce((sum, row) => sum + row.quantity, 0)).toBe(consumed);
  expect(acceptedUnits).toBeLessThanOrEqual(initialTotal);
  // Guard against a vacuous pass: some submissions must win the contention.
  expect(statusCounts["201"] ?? 0).toBeGreaterThan(0);
  if ((statusCounts["503"] ?? 0) === 0) {
    // With no transient failures every request that finds at least 2 units is
    // accepted, so stock is consumed down to the last odd unit: 12 Orders of 2.
    // (The 422 count is not fixed: it depends on whether the shared ID wins.)
    expect(acceptedOrders.size).toBe(12);
    expect(acceptedUnits).toBe(24);
  }

  const durations = outcomes.map((outcome) => outcome.durationMs).sort((a, b) => a - b);
  const report = {
    parameters: PARAMETERS,
    statusCounts,
    acceptedOrders: acceptedOrders.size,
    acceptedUnits,
    stockConsumed: consumed,
    wallTimeMs: round(wallTimeMs),
    requestDurationMs: {
      min: round(durations[0] ?? 0),
      median: round(median(durations)),
      max: round(durations.at(-1) ?? 0),
    },
    peakLockWaiters,
    lockWaiterSamples: samples,
    serviceUnavailable: statusCounts["503"] ?? 0,
  };
  console.info(`SCOS_CONCURRENCY_REPORT ${JSON.stringify(report)}`);
});
