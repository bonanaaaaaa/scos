/**
 * Persistence tracing against real PostgreSQL: the decorator spans around the
 * Prisma adapters, the submission counter across accept/replay/reject and a
 * real lock timeout, the absence of sensitive data, and an unreachable
 * collector that neither changes results nor holds database locks.
 */

import { MAX_SUBMISSION_ATTEMPTS } from "@scos/core";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { composeSubmitOrderApplication } from "#endpoints/submit-order/composition";
import { composeVerifyOrderApplication } from "#endpoints/verify-order/composition";
import { parseHealthConfig } from "#endpoints/health/config";
import { createTelemetryRuntime } from "#telemetry/node/sdk";
import { SUBMISSIONS_METRIC } from "#telemetry/telemetry";
import { startBlackHole } from "#testing/black-hole.test-support";
import { type TestTelemetry, testTelemetry } from "#testing/telemetry.test-support";
import {
  AT_PARIS,
  Applications,
  FAR_AWAY,
  postJson,
  silentLogger,
  snapshot,
} from "#test/support/app";
import {
  type TestDatabase,
  createTestDatabase,
  holdWarehouseLocks,
  stockById,
} from "#test/support/database";

let db: TestDatabase;
let harness: TestTelemetry;
const applications = new Applications();

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.reset();
  harness = testTelemetry();
});

afterEach(async () => {
  await applications.closeAll();
  await harness.shutdown();
});

function tracedApplication() {
  return applications.compose(db.url, { telemetry: harness.telemetry });
}

function spansOf(traceId: string): ReadableSpan[] {
  return harness.finished().filter((span) => span.spanContext().traceId === traceId);
}

function lastServer(): ReadableSpan {
  const server = harness
    .finished()
    .filter((span) => span.kind === SpanKind.SERVER)
    .at(-1);
  if (server === undefined) {
    throw new Error("no server span");
  }
  return server;
}

/** name -> parent name, for one request's trace. */
function tree(server: ReadableSpan): Record<string, string | undefined> {
  const spans = spansOf(server.spanContext().traceId);
  const byId = new Map(spans.map((span) => [span.spanContext().spanId, span.name]));
  return Object.fromEntries(
    spans.map((span) => [
      span.name,
      span.parentSpanContext === undefined ? undefined : byId.get(span.parentSpanContext.spanId),
    ]),
  );
}

async function submissionCounts(): Promise<Record<string, number>> {
  const points = await harness.points(SUBMISSIONS_METRIC);
  return Object.fromEntries(
    points.map((point) => [
      Object.values(point.attributes)
        .map((value) => String(value))
        .join("/"),
      point.value,
    ]),
  );
}

describe("persistence decorator spans over the real database", () => {
  test("verification: SERVER > VerifyOrder > InventoryReader.readInventorySnapshot", async () => {
    const response = await snapshot(
      postJson(tracedApplication(), "/api/v1/orders/verify", { quantity: 30, ...AT_PARIS }),
    );
    expect(response.status, response.text).toBe(200);

    const server = lastServer();
    expect(server.name).toBe("POST /api/v1/orders/verify");
    expect(tree(server)).toStrictEqual({
      "POST /api/v1/orders/verify": undefined,
      VerifyOrder: "POST /api/v1/orders/verify",
      "InventoryReader.readInventorySnapshot": "VerifyOrder",
    });
    expect(harness.span("InventoryReader.readInventorySnapshot").attributes).toStrictEqual({
      "scos.inventory.warehouse_count": 6,
    });
    const read = harness.span("InventoryReader.readInventorySnapshot");
    expect(read.duration[0] * 1e9 + read.duration[1]).toBeGreaterThan(0);
  });

  test("acceptance, replay and rejection: spans per port and one counter increment per request", async () => {
    const composed = tracedApplication();
    const body = { submissionId: "telemetry-1", quantity: 30, ...AT_PARIS };

    const accepted = await snapshot(postJson(composed, "/api/v1/orders", body));
    expect(accepted.status, accepted.text).toBe(201);
    const acceptedServer = lastServer();
    expect(tree(acceptedServer)).toStrictEqual({
      "POST /api/v1/orders": undefined,
      SubmitOrder: "POST /api/v1/orders",
      "SubmissionStore.findOrderBySubmissionKey": "SubmitOrder",
      "SubmissionStore.runInTransaction": "SubmitOrder",
      "SubmissionTransaction.lockInventory": "SubmissionStore.runInTransaction",
      "SubmissionTransaction.findOrderBySubmissionKey": "SubmissionStore.runInTransaction",
      "SubmissionTransaction.saveAcceptedOrder": "SubmissionStore.runInTransaction",
    });
    for (const span of spansOf(acceptedServer.spanContext().traceId)) {
      expect(span.status.code, span.name).toBe(SpanStatusCode.UNSET);
    }

    const replay = await snapshot(postJson(composed, "/api/v1/orders", body));
    expect(replay.status).toBe(201);
    expect(replay.text).toBe(accepted.text);
    const replayServer = lastServer();
    // The unlocked lookup finds the Order: no transaction, no stock touched.
    expect(tree(replayServer)).toStrictEqual({
      "POST /api/v1/orders": undefined,
      SubmitOrder: "POST /api/v1/orders",
      "SubmissionStore.findOrderBySubmissionKey": "SubmitOrder",
    });
    expect(
      spansOf(replayServer.spanContext().traceId).find(
        (span) => span.name === "SubmissionStore.findOrderBySubmissionKey",
      )?.attributes,
    ).toStrictEqual({ "scos.submission.order_found": true });

    const rejected = await snapshot(
      postJson(composed, "/api/v1/orders", {
        submissionId: "telemetry-2",
        quantity: 1,
        ...FAR_AWAY,
      }),
    );
    expect(rejected.status).toBe(422);
    const rejectedServer = lastServer();
    for (const span of spansOf(rejectedServer.spanContext().traceId)) {
      expect(span.status.code, span.name).toBe(SpanStatusCode.UNSET);
    }

    expect(await submissionCounts()).toStrictEqual({
      "accepted/false": 1,
      "accepted/true": 1,
      "rejected/false/SHIPPING_EXCEEDS_LIMIT": 1,
    });

    // No submission key, order number, coordinates, SQL or connection details anywhere.
    const orderNumber = (JSON.parse(accepted.text) as { orderNumber: string }).orderNumber;
    // Where data could leak: span names, attributes and events, and metric
    // names and data-point attributes. Timestamps and measured values are
    // left out: a duration such as 0.00171 would falsely "contain" 170.
    const recorded = JSON.stringify([
      harness.finished().map((span) => [span.name, span.attributes, span.events]),
      (await harness.metrics()).map((metric) => [
        metric.descriptor.name,
        metric.dataPoints.map((point) => point.attributes),
      ]),
    ]);
    for (const secret of [
      "telemetry-1",
      "telemetry-2",
      orderNumber,
      String(AT_PARIS.latitude),
      String(AT_PARIS.longitude),
      String(FAR_AWAY.longitude),
      "SELECT",
      "scos_test",
    ]) {
      expect(recorded, secret).not.toContain(secret);
    }
  });

  test("a real lock timeout: failed transaction spans with a safe error code, SubmitOrder unavailable, 503 ERROR", async () => {
    const composed = applications.compose(db.url, {
      telemetry: harness.telemetry,
      submissionStore: { lockTimeoutMs: 150, timeoutMs: 5_000, maxWaitMs: 5_000 },
    });
    const locks = await holdWarehouseLocks(db.url);
    let response;
    try {
      response = await snapshot(
        postJson(composed, "/api/v1/orders", {
          submissionId: "locked-1",
          quantity: 10,
          ...AT_PARIS,
        }),
      );
    } finally {
      await locks.release();
    }
    expect(response.status, response.text).toBe(503);

    const server = lastServer();
    const spans = spansOf(server.spanContext().traceId);
    const transactions = spans.filter((span) => span.name === "SubmissionStore.runInTransaction");
    expect(transactions).toHaveLength(MAX_SUBMISSION_ATTEMPTS);
    for (const span of transactions) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes).toStrictEqual({
        "error.type": "TransientSubmissionError",
        // The lock_timeout reaches persistence as Prisma's P2010 raw-query
        // error; its driver SQLSTATE is what is recorded.
        "scos.error.code": "55P03",
        "db.response.status_code": "55P03",
      });
    }
    const submit = spans.find((span) => span.name === "SubmitOrder");
    expect(submit?.status.code).toBe(SpanStatusCode.ERROR);
    expect(submit?.attributes["error.type"]).toBe("unavailable");
    expect(server.status.code).toBe(SpanStatusCode.ERROR);
    expect(server.attributes["error.type"]).toBe("503");
    expect(await submissionCounts()).toStrictEqual({ "unavailable/false": 1 });
    expect(JSON.stringify(spans.map((span) => span.events))).not.toMatch(/lock|warehouse|SELECT/i);
  });
});

describe("per-endpoint compositions are traced the same way", () => {
  test("separate verify and submit compositions each record their own SERVER and port spans", async () => {
    const verify = composeVerifyOrderApplication({
      databaseUrl: db.url,
      logger: silentLogger,
      telemetry: harness.telemetry,
    });
    const submit = composeSubmitOrderApplication({
      databaseUrl: db.url,
      logger: silentLogger,
      telemetry: harness.telemetry,
    });
    try {
      expect(
        (await postJson(verify, "/api/v1/orders/verify", { quantity: 1, ...AT_PARIS })).status,
      ).toBe(200);
      expect(
        (
          await postJson(submit, "/api/v1/orders", {
            submissionId: "split-1",
            quantity: 1,
            ...AT_PARIS,
          })
        ).status,
      ).toBe(201);
      const names = harness.finished().map((span) => span.name);
      expect(names.filter((name) => name.startsWith("POST "))).toStrictEqual([
        "POST /api/v1/orders/verify",
        "POST /api/v1/orders",
      ]);
      expect(names).toContain("InventoryReader.readInventorySnapshot");
      expect(names).toContain("SubmissionTransaction.saveAcceptedOrder");
    } finally {
      await Promise.all([verify.close(), submit.close()]);
    }
  });
});

describe("an unreachable collector", () => {
  test("changes no result and holds no database lock: export never runs inside the transaction", async () => {
    const blackHole = await startBlackHole();
    const parsed = parseHealthConfig({
      LOG_LEVEL: "silent",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${blackHole.port}`,
      OTEL_EXPORTER_OTLP_TIMEOUT: "30000",
    });
    if (!parsed.success) {
      throw new Error(parsed.errors.join("; "));
    }
    const runtime = createTelemetryRuntime(parsed.config.telemetry);
    try {
      // Short lock timeout: if anything held the warehouse locks after a
      // commit (for example an export awaited inside the transaction), the
      // next submission would fail with 503 instead of 201.
      const composed = applications.compose(db.url, {
        telemetry: runtime.telemetry,
        submissionStore: { lockTimeoutMs: 500, timeoutMs: 5_000, maxWaitMs: 5_000 },
      });
      const before = await stockById(db.pool);
      const started = Date.now();
      for (let index = 1; index <= 5; index += 1) {
        const response = await snapshot(
          postJson(composed, "/api/v1/orders", {
            submissionId: `blackhole-${index}`,
            quantity: 1,
            ...AT_PARIS,
          }),
        );
        expect(response.status, response.text).toBe(201);
        await runtime.forceFlush(50); // an export attempt is in flight to the silent collector
      }
      expect(Date.now() - started).toBeLessThan(10_000);
      const after = await stockById(db.pool);
      const paris = "01996000-0000-7000-8000-000000000004";
      expect(after[paris]).toBe((before[paris] ?? 0) - 5);
      expect(blackHole.accepted()).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown(200);
      await blackHole.close();
    }
  });
});
