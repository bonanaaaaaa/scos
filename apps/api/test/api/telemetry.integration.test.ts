/**
 * QA API acceptance: telemetry of the real HTTP listener, observed through an
 * in-memory test sink injected at `startServer`'s `startTelemetry` seam
 * (in-memory spans and metrics, the production Pino logger writing to a
 * capture stream with PinoInstrumentation correlation).
 *
 * Drives success (201), rejection (422), replay of an accepted id, malformed
 * input (400) and an unexpected error (500, database unreachable), and checks
 * W3C trace continuation, span/log correlation, isolation of concurrent
 * requests, the submission outcome counter and the absence of request data
 * and connection details. The developer-owned in-process span trees and
 * decorator attributes (test/telemetry.integration.test.ts) are not repeated.
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  type TestDatabase,
  createTestDatabase,
  holdWarehouseLocks,
  waitForLockWaiters,
} from "../support/database";
import {
  ABOVE_LIMIT,
  AT_PARIS,
  MANHATTAN,
  type RunningApi,
  type TestObservability,
  expectErrorEnvelope,
  expectJson,
  request,
  startApi,
  testObservability,
} from "./support";

const SUBMISSIONS = "scos.order.submissions";
const REQUEST_DURATION = "http.server.request.duration";

let db: TestDatabase;
let sink: TestObservability;
let api: RunningApi;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.reset();
  sink = testObservability();
  api = await startApi(db.url, { observability: sink.runtime });
});

afterEach(async () => {
  await api?.stop();
  await sink?.shutdown();
});

let traceCounter = 0;

/** A fresh sampled W3C trace context, as an upstream caller would send. */
function caller(): { traceId: string; parentSpanId: string; traceparent: string } {
  traceCounter += 1;
  const suffix = traceCounter.toString(16).padStart(8, "0");
  const traceId = `4bf92f3577b34da6a3ce929d${suffix}`;
  const parentSpanId = `00f067aa${suffix}`;
  return { traceId, parentSpanId, traceparent: `00-${traceId}-${parentSpanId}-01` };
}

function send(target: RunningApi, path: string, body: unknown, traceparent: string, raw?: string) {
  return request(target, path, {
    body: raw ?? JSON.stringify(body),
    headers: { traceparent },
  });
}

function spansOf(observed: TestObservability, traceId: string): ReadableSpan[] {
  return observed.harness.finished().filter((span) => span.spanContext().traceId === traceId);
}

function serverSpan(observed: TestObservability, traceId: string): ReadableSpan {
  const servers = spansOf(observed, traceId).filter((span) => span.kind === SpanKind.SERVER);
  expect(servers, `SERVER spans of ${traceId}`).toHaveLength(1);
  return servers[0] as ReadableSpan;
}

function logsOf(observed: TestObservability, traceId: string): Record<string, unknown>[] {
  return observed.logs.records().filter((record) => record.trace_id === traceId);
}

/**
 * The caller's trace is continued: the one SERVER span has the inbound
 * trace id and the caller's span as parent, every span of the request shares
 * the trace, and the request log carries that trace id and the SERVER span id.
 */
function expectCorrelated(
  observed: TestObservability,
  context: ReturnType<typeof caller>,
  status: number,
): ReadableSpan {
  const server = serverSpan(observed, context.traceId);
  expect(server.parentSpanContext?.spanId).toBe(context.parentSpanId);
  expect(server.parentSpanContext?.isRemote).toBe(true);
  expect(server.attributes["http.response.status_code"]).toBe(status);

  const spanIds = new Set(spansOf(observed, context.traceId).map((s) => s.spanContext().spanId));
  for (const span of spansOf(observed, context.traceId)) {
    if (span !== server) {
      expect(spanIds.has(span.parentSpanContext?.spanId ?? ""), span.name).toBe(true);
    }
  }

  const records = logsOf(observed, context.traceId);
  const completed = records.filter((record) => record.msg === "request completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({
    trace_id: context.traceId,
    span_id: server.spanContext().spanId,
    trace_flags: "01",
    "http.response.status_code": status,
  });
  for (const record of records) {
    expect(spanIds.has(String(record.span_id)), String(record.msg)).toBe(true);
  }
  return server;
}

async function submissionCounts(observed: TestObservability): Promise<Record<string, number>> {
  const points = await observed.harness.points(SUBMISSIONS);
  return Object.fromEntries(
    points.map((point) => [
      Object.entries(point.attributes)
        .map(([key, value]) => `${key}=${String(value)}`)
        .sort()
        .join(","),
      point.value,
    ]),
  );
}

const SUBMISSION_ATTRIBUTE_KEYS = [
  "error.type",
  "scos.submission.outcome",
  "scos.submission.rejection_reason",
  "scos.submission.replayed",
];
const DURATION_ATTRIBUTE_KEYS = [
  "error.type",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "url.scheme",
];
const ROUTES = ["/health", "/api/v1/orders", "/api/v1/orders/verify"];

/** Every metric data point uses only the documented, bounded attributes. */
async function expectBoundedMetrics(observed: TestObservability): Promise<void> {
  for (const point of await observed.harness.points(SUBMISSIONS)) {
    for (const key of Object.keys(point.attributes)) {
      expect(SUBMISSION_ATTRIBUTE_KEYS).toContain(key);
    }
    expect(["accepted", "rejected", "conflict", "invalid", "unavailable", "error"]).toContain(
      point.attributes["scos.submission.outcome"],
    );
    expect(typeof point.attributes["scos.submission.replayed"]).toBe("boolean");
    const reason = point.attributes["scos.submission.rejection_reason"];
    if (reason !== undefined) {
      expect(["INSUFFICIENT_STOCK", "SHIPPING_EXCEEDS_LIMIT"]).toContain(reason);
    }
    const errorType = point.attributes["error.type"];
    if (errorType !== undefined) {
      expect(errorType).toMatch(/^[A-Za-z_$][\w$]*$/);
    }
  }
  for (const point of await observed.harness.histogram(REQUEST_DURATION)) {
    for (const key of Object.keys(point.attributes)) {
      expect(DURATION_ATTRIBUTE_KEYS).toContain(key);
    }
    const route = point.attributes["http.route"];
    if (route !== undefined) {
      expect(ROUTES).toContain(route);
    }
  }
}

/**
 * Where request data could leak: span names, attributes and events, metric
 * names and data-point attributes, and every log record. Timestamps and
 * measured durations are left out, since a number such as 0.0407128 would
 * falsely "contain" a coordinate.
 */
async function recordedText(observed: TestObservability): Promise<string> {
  const logs = observed.logs.records().map((record) => {
    const { time: _time, "http.server.request.duration": _duration, ...rest } = record;
    return rest;
  });
  return JSON.stringify([
    observed.harness.finished().map((span) => [span.name, span.attributes, span.events]),
    (await observed.harness.metrics()).map((metric) => [
      metric.descriptor.name,
      metric.dataPoints.map((point) => point.attributes),
    ]),
    logs,
  ]);
}

describe("W3C trace context through the real listener", () => {
  test("an inbound traceparent is continued by the SERVER span and carried by the request log", async () => {
    const context = caller();
    const response = await send(
      api,
      "/api/v1/orders/verify",
      { quantity: 3, ...AT_PARIS },
      context.traceparent,
    );
    expectJson(response, 200);

    const server = expectCorrelated(sink, context, 200);
    expect(server.name).toBe("POST /api/v1/orders/verify");
    expect(server.status.code).toBe(SpanStatusCode.UNSET);
    // The response does not echo trace context.
    expect(response.headers.get("traceparent")).toBeNull();
  });

  test("two overlapping requests with different traceparents never mix trace ids in spans or logs", async () => {
    const first = caller();
    const second = caller();
    const locks = await holdWarehouseLocks(db.url);
    let responses;
    try {
      const pending = [
        send(
          api,
          "/api/v1/orders",
          { submissionId: "qa-tel-overlap-a", quantity: 2, ...AT_PARIS },
          first.traceparent,
        ),
        send(
          api,
          "/api/v1/orders",
          { submissionId: "qa-tel-overlap-b", quantity: 3, ...AT_PARIS },
          second.traceparent,
        ),
      ];
      // Both requests are inside their transactions, waiting on the same locks.
      await waitForLockWaiters(db.pool, 2);
      await locks.release();
      responses = await Promise.all(pending);
    } finally {
      await locks.release();
    }
    for (const response of responses) {
      expectJson(response, 201);
    }

    const names = (traceId: string) =>
      spansOf(sink, traceId)
        .map((span) => span.name)
        .sort();
    for (const context of [first, second]) {
      expectCorrelated(sink, context, 201);
      // Each trace holds exactly one request's spans: one of each, none borrowed.
      expect(names(context.traceId)).toStrictEqual([
        "POST /api/v1/orders",
        "SubmissionStore.findOrderBySubmissionKey",
        "SubmissionStore.runInTransaction",
        "SubmissionTransaction.findOrderBySubmissionKey",
        "SubmissionTransaction.lockInventory",
        "SubmissionTransaction.saveAcceptedOrder",
        "SubmitOrder",
      ]);
    }
    // Nothing was recorded under any other trace.
    const traces = new Set(sink.harness.finished().map((span) => span.spanContext().traceId));
    expect([...traces].sort()).toStrictEqual([first.traceId, second.traceId].sort());
    const loggedTraces = new Set(
      sink.logs
        .records()
        .filter((record) => record.trace_id !== undefined)
        .map((record) => record.trace_id),
    );
    expect([...loggedTraces].sort()).toStrictEqual([first.traceId, second.traceId].sort());
  });
});

describe("submission outcomes, correlation and sanitizing through the real listener", () => {
  test("201, 422, replay and 400: correlated, counted with bounded attributes, no request data", async () => {
    const accepted = { submissionId: "qa-tel-accept-4d1c", quantity: 30, ...MANHATTAN };
    const rejected = {
      submissionId: "qa-tel-reject-9b2e",
      quantity: 1,
      latitude: ABOVE_LIMIT.latitude,
      longitude: ABOVE_LIMIT.longitude,
    };
    const malformedText = '{"submissionId":"qa-tel-malformed-7a0f","quantity":';
    const invalid = { submissionId: "qa-tel-invalid-3c5d", quantity: 0, ...MANHATTAN };

    const acceptContext = caller();
    const first = await send(api, "/api/v1/orders", accepted, acceptContext.traceparent);
    const order = expectJson(first, 201) as { orderNumber: string };
    const acceptServer = expectCorrelated(sink, acceptContext, 201);
    expect(acceptServer.status.code).toBe(SpanStatusCode.UNSET);

    const rejectContext = caller();
    const rejection = await send(api, "/api/v1/orders", rejected, rejectContext.traceparent);
    expect((expectJson(rejection, 422) as { error: { code: string } }).error.code).toBe(
      "SHIPPING_EXCEEDS_LIMIT",
    );
    expect(expectCorrelated(sink, rejectContext, 422).status.code).toBe(SpanStatusCode.UNSET);

    const replayContext = caller();
    const replay = await send(api, "/api/v1/orders", accepted, replayContext.traceparent);
    expectJson(replay, 201);
    expect(replay.text).toBe(first.text);
    expectCorrelated(sink, replayContext, 201);

    const malformedContext = caller();
    const malformed = await send(
      api,
      "/api/v1/orders",
      undefined,
      malformedContext.traceparent,
      malformedText,
    );
    expectErrorEnvelope(malformed, 400, "INVALID_REQUEST");
    expect(expectCorrelated(sink, malformedContext, 400).status.code).toBe(SpanStatusCode.UNSET);

    const invalidContext = caller();
    const validation = await send(api, "/api/v1/orders", invalid, invalidContext.traceparent);
    expectErrorEnvelope(validation, 400, "INVALID_REQUEST", { issues: "present" });
    expectCorrelated(sink, invalidContext, 400);

    // One increment per submission that reached the use case; 400s from HTTP
    // validation are not counted (docs/observability.md).
    expect(await submissionCounts(sink)).toStrictEqual({
      "scos.submission.outcome=accepted,scos.submission.replayed=false": 1,
      "scos.submission.outcome=accepted,scos.submission.replayed=true": 1,
      "scos.submission.outcome=rejected,scos.submission.rejection_reason=SHIPPING_EXCEEDS_LIMIT,scos.submission.replayed=false": 1,
    });
    await expectBoundedMetrics(sink);
    const durations = await sink.harness.histogram(REQUEST_DURATION);
    const byStatus = (status: number) =>
      durations
        .filter((point) => point.attributes["http.response.status_code"] === status)
        .reduce((sum, point) => sum + point.value.count, 0);
    expect([byStatus(201), byStatus(422), byStatus(400)]).toStrictEqual([2, 1, 2]);

    const recorded = await recordedText(sink);
    for (const secret of [
      accepted.submissionId,
      rejected.submissionId,
      "qa-tel-malformed-7a0f",
      invalid.submissionId,
      "submissionId",
      malformedText,
      JSON.stringify(accepted),
      order.orderNumber,
      String(MANHATTAN.latitude),
      String(MANHATTAN.longitude),
      String(ABOVE_LIMIT.latitude),
      String(ABOVE_LIMIT.longitude),
      "latitude",
      "longitude",
      "scos_test",
      "postgresql://",
    ]) {
      expect(recorded, secret).not.toContain(secret);
    }
  });
});

describe("an unexpected error through the real listener", () => {
  const password = "qa-tel-secret-pw";
  const user = "qa_tel_user";
  // Port 1 is privileged and not listening: connections are refused at once.
  const unreachableUrl = `postgresql://${user}:${password}@127.0.0.1:1/scos_tel_unreachable`;

  test("database unreachable: 500 envelope, ERROR SERVER span, correlated sanitized error log, error outcome", async () => {
    const downSink = testObservability();
    const down = await startApi(unreachableUrl, { observability: downSink.runtime });
    try {
      const submitContext = caller();
      const submit = await send(
        down,
        "/api/v1/orders",
        { submissionId: "qa-tel-down-5e8a", quantity: 5, ...MANHATTAN },
        submitContext.traceparent,
      );
      expectErrorEnvelope(submit, 500, "INTERNAL_ERROR", { issues: "absent" });

      const verifyContext = caller();
      const verify = await send(
        down,
        "/api/v1/orders/verify",
        { quantity: 5, ...MANHATTAN },
        verifyContext.traceparent,
      );
      expectErrorEnvelope(verify, 500, "INTERNAL_ERROR", { issues: "absent" });

      for (const context of [submitContext, verifyContext]) {
        const server = expectCorrelated(downSink, context, 500);
        expect(server.status.code).toBe(SpanStatusCode.ERROR);
        expect(server.attributes["error.type"]).toMatch(/^[A-Za-z_$][\w$]*$/);
        // The failure is logged at error level inside the request's trace.
        const errors = logsOf(downSink, context.traceId).filter(
          (record) => record.level === "error",
        );
        expect(errors.length).toBeGreaterThanOrEqual(1);
        for (const record of errors) {
          expect(record.span_id).toBeTypeOf("string");
        }
      }

      const counts = await submissionCounts(downSink);
      expect(Object.keys(counts)).toHaveLength(1);
      const [key] = Object.keys(counts);
      expect(key).toMatch(
        /^error\.type=[A-Za-z_$][\w$]*,scos\.submission\.outcome=error,scos\.submission\.replayed=false$/,
      );
      expect(Object.values(counts)).toStrictEqual([1]);
      await expectBoundedMetrics(downSink);

      const recorded = await recordedText(downSink);
      for (const secret of [
        password,
        user,
        "scos_tel_unreachable",
        "postgresql://",
        "127.0.0.1:1",
        "qa-tel-down-5e8a",
        "submissionId",
        String(MANHATTAN.latitude),
        String(MANHATTAN.longitude),
      ]) {
        expect(recorded, secret).not.toContain(secret);
      }
    } finally {
      await down.stop();
      await downSink.shutdown();
    }
  });
});
