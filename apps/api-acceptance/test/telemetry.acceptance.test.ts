/**
 * QA API acceptance: telemetry of the served API, observed from outside the
 * process.
 *
 * Every test here starts its own API process configured to export OTLP/HTTP
 * protobuf to a fake collector running in this process
 * (./support/otlp/collector.ts), drives real HTTP requests at it, stops it,
 * and only then asserts: stopping flushes the batched span processor and the
 * periodic metric reader, so nothing is lost to batching and nothing has to
 * be polled or slept on. Spans and metrics come from the decoded export
 * payloads, log records from the process's stdout.
 *
 * Drives success (201), rejection (422), replay of an accepted id, malformed
 * input (400) and an unexpected error (500, database unreachable), and checks
 * W3C trace continuation, span/log correlation, isolation of concurrent
 * requests, the submission outcome counter and the absence of request data
 * and connection details. The developer-owned in-process span trees and
 * decorator attributes are not repeated.
 *
 * @module
 */

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { type ApiProcess, spawnApi, stopAllApiProcesses } from "./support/api-process";
import {
  holdWarehouseLocks,
  openPool,
  resetDatabase,
  waitForLockWaiters,
} from "./support/database";
import { type HttpResult, expectErrorEnvelope, expectJson, request } from "./support/http";
import type { LogRecord } from "./support/logs";
import { ABOVE_LIMIT } from "./support/oracle";
import {
  METRICS_PATH,
  type OtlpCollector,
  type OtlpPayload,
  TRACES_PATH,
  startCollector,
} from "./support/otlp/collector";
import {
  type Attributes,
  type DecodedHistogramPoint,
  type DecodedMetric,
  type DecodedNumberPoint,
  type DecodedSpan,
  hasRemoteParent,
} from "./support/otlp/decode";
import { AT_PARIS, MANHATTAN } from "./support/prd";
import { acceptanceDatabaseUrl } from "./support/shared-api";

const SUBMISSIONS = "scos.order.submissions";
const REQUEST_DURATION = "http.server.request.duration";

let databaseUrl: string;
let pool: Pool;

beforeAll(() => {
  databaseUrl = acceptanceDatabaseUrl();
  pool = openPool(databaseUrl);
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool?.end();
  // No process this file started may survive the run.
  await stopAllApiProcesses();
});

// ---------------------------------------------------------------------------
// A telemetry-enabled server and its collector
// ---------------------------------------------------------------------------

interface TelemetryApi {
  readonly api: ApiProcess;
  readonly collector: OtlpCollector;
}

/** Everything started by a test, stopped even when the test failed. */
const started: TelemetryApi[] = [];

afterEach(async () => {
  // A collector is an open HTTP server: it must be closed even when stopping
  // the process it served rejects, or the worker's event loop stays alive.
  const results = await Promise.allSettled(
    started.splice(0).map(async (telemetry) => {
      try {
        await telemetry.api.stop();
      } finally {
        await telemetry.collector.close();
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) {
    throw failure.reason;
  }
});

/**
 * Starts a fake collector and an API process exporting to it.
 *
 * The metric reader's interval is short so a run produces several exports,
 * and its timeout must not exceed the interval or the configuration is
 * rejected. The sampler argument is 1 so every root trace is sampled;
 * requests here always arrive with a sampled `traceparent`, which a
 * parent-based sampler honours anyway.
 */
async function startTelemetryApi(url: string): Promise<TelemetryApi> {
  const collector = await startCollector();
  try {
    const api = await spawnApi({
      databaseUrl: url,
      env: {
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        // The configuration appends /v1/traces and /v1/metrics to this.
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        OTEL_TRACES_SAMPLER_ARG: "1",
        OTEL_METRIC_EXPORT_INTERVAL: "2000",
        OTEL_METRIC_EXPORT_TIMEOUT: "2000",
        LOG_LEVEL: "info",
        OTEL_SERVICE_NAME: "scos-api-acceptance",
      },
    });
    const telemetry = { api, collector };
    started.push(telemetry);
    return telemetry;
  } catch (error) {
    await collector.close();
    throw error;
  }
}

/** Everything one process exported and logged, read after it has exited. */
interface Observed {
  readonly spans: readonly DecodedSpan[];
  readonly metrics: readonly DecodedMetric[];
  readonly records: readonly LogRecord[];
  readonly payloads: readonly OtlpPayload[];
}

/**
 * Stops the process and takes the snapshot the assertions run against.
 * Shutdown closes the listener, then the composition, then flushes and stops
 * the telemetry providers, so everything the process recorded has been
 * exported by the time this resolves.
 */
async function observe({ api, collector }: TelemetryApi): Promise<Observed> {
  const code = await api.stop();
  expect(code, api.stderr()).toBe(0);
  const payloads = collector.payloads();
  // A suite that asserts "no secret appears in the payloads" must first know
  // that there were payloads at all.
  for (const path of [TRACES_PATH, METRICS_PATH]) {
    const posted = payloads.filter((payload) => payload.path === path);
    expect(posted.length, `${path} exports`).toBeGreaterThan(0);
    for (const payload of posted) {
      expect(payload.contentType).toBe("application/x-protobuf");
    }
  }
  return {
    spans: collector.spans(),
    metrics: collector.metrics(),
    records: api.records(),
    payloads,
  };
}

// ---------------------------------------------------------------------------
// Driving requests
// ---------------------------------------------------------------------------

interface Caller {
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly traceparent: string;
}

let traceCounter = 0;

/** A fresh sampled W3C trace context, as an upstream caller would send. */
function caller(): Caller {
  traceCounter += 1;
  const suffix = traceCounter.toString(16).padStart(8, "0");
  const traceId = `4bf92f3577b34da6a3ce929d${suffix}`;
  const parentSpanId = `00f067aa${suffix}`;
  return { traceId, parentSpanId, traceparent: `00-${traceId}-${parentSpanId}-01` };
}

function send(
  target: ApiProcess,
  path: string,
  body: unknown,
  traceparent: string,
  raw?: string,
): Promise<HttpResult> {
  return request(target, path, {
    body: raw ?? JSON.stringify(body),
    headers: { traceparent },
  });
}

// ---------------------------------------------------------------------------
// Spans, logs and their correlation
// ---------------------------------------------------------------------------

function spansOf(observed: Observed, traceId: string): DecodedSpan[] {
  return observed.spans.filter((span) => span.traceId === traceId);
}

function serverSpan(observed: Observed, traceId: string): DecodedSpan {
  const servers = spansOf(observed, traceId).filter((span) => span.kind === "SERVER");
  expect(servers, `SERVER spans of ${traceId}`).toHaveLength(1);
  return servers[0] as DecodedSpan;
}

function logsOf(observed: Observed, traceId: string): LogRecord[] {
  return observed.records.filter((record) => record.trace_id === traceId);
}

/**
 * The caller's trace is continued: the one SERVER span has the inbound trace
 * id, the caller's span as a remote parent, every span of the request shares
 * the trace, and the request log carries that trace id and the SERVER span
 * id. The parent's remoteness is read from `Span.flags`, which is where the
 * OTLP wire format carries it.
 */
function expectCorrelated(observed: Observed, context: Caller, status: number): DecodedSpan {
  const server = serverSpan(observed, context.traceId);
  expect(server.parentSpanId).toBe(context.parentSpanId);
  expect(hasRemoteParent(server)).toBe(true);
  expect(server.attributes["http.response.status_code"]).toBe(status);

  const spanIds = new Set(spansOf(observed, context.traceId).map((span) => span.spanId));
  for (const span of spansOf(observed, context.traceId)) {
    if (span !== server) {
      expect(spanIds.has(span.parentSpanId), span.name).toBe(true);
    }
  }

  const records = logsOf(observed, context.traceId);
  const completed = records.filter((record) => record.msg === "request completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({
    trace_id: context.traceId,
    span_id: server.spanId,
    trace_flags: "01",
    "http.response.status_code": status,
  });
  for (const record of records) {
    expect(spanIds.has(String(record.span_id)), String(record.msg)).toBe(true);
  }
  return server;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** A data point's attributes as one comparable key. */
function attributeKey(attributes: Attributes): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort()
    .join(",");
}

/**
 * One point per attribute set: the one from the newest export.
 *
 * The reader is cumulative and exports periodically, so every export repeats
 * every instrument with a running total. Summing points across exports would
 * count the same request many times; the newest point is the final value.
 * `expectBoundedMetrics` asserts the temporality this relies on.
 */
function latest<Point extends { readonly attributes: Attributes; readonly timeUnixNano: bigint }>(
  points: readonly Point[],
): Point[] {
  const newest = new Map<string, Point>();
  for (const point of points) {
    const key = attributeKey(point.attributes);
    const seen = newest.get(key);
    if (seen === undefined || point.timeUnixNano > seen.timeUnixNano) {
      newest.set(key, point);
    }
  }
  return [...newest.values()];
}

function metricsNamed(observed: Observed, name: string): DecodedMetric[] {
  return observed.metrics.filter((metric) => metric.name === name);
}

function sumPoints(observed: Observed, name: string): DecodedNumberPoint[] {
  return metricsNamed(observed, name).flatMap((metric) => metric.sum?.dataPoints ?? []);
}

function histogramPoints(observed: Observed, name: string): DecodedHistogramPoint[] {
  return metricsNamed(observed, name).flatMap((metric) => metric.histogram?.dataPoints ?? []);
}

/** The submission counter's final totals, keyed by attribute set. */
function submissionCounts(observed: Observed): Record<string, number> {
  return Object.fromEntries(
    latest(sumPoints(observed, SUBMISSIONS)).map((point) => [
      attributeKey(point.attributes),
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
function expectBoundedMetrics(observed: Observed): void {
  for (const metric of metricsNamed(observed, SUBMISSIONS)) {
    // A cumulative, monotonic counter: what makes "the newest point wins" the
    // right way to read a total out of repeated exports.
    expect(metric.sum?.aggregationTemporality).toBe("CUMULATIVE");
    expect(metric.sum?.isMonotonic).toBe(true);
  }
  for (const point of sumPoints(observed, SUBMISSIONS)) {
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
  for (const metric of metricsNamed(observed, REQUEST_DURATION)) {
    expect(metric.histogram?.aggregationTemporality).toBe("CUMULATIVE");
  }
  for (const point of histogramPoints(observed, REQUEST_DURATION)) {
    for (const key of Object.keys(point.attributes)) {
      expect(DURATION_ATTRIBUTE_KEYS).toContain(key);
    }
    const route = point.attributes["http.route"];
    if (route !== undefined) {
      expect(ROUTES).toContain(route);
    }
  }
}

// ---------------------------------------------------------------------------
// Request data must not be recorded
// ---------------------------------------------------------------------------

/**
 * Where request data could leak: span names, attributes and events, metric
 * names and data-point attributes, and every log record. Timestamps and
 * measured durations are left out, since a number such as 0.0407128 would
 * falsely "contain" a coordinate.
 */
function recordedText(observed: Observed): string {
  const logs = observed.records.map((record) => {
    const { time: _time, "http.server.request.duration": _duration, ...rest } = record;
    return rest;
  });
  return JSON.stringify([
    observed.spans.map((span) => [
      span.name,
      span.attributes,
      span.events.map((event) => [event.name, event.attributes]),
    ]),
    observed.metrics.map((metric) => [
      metric.name,
      metric.description,
      metric.unit,
      [...(metric.sum?.dataPoints ?? []), ...(metric.histogram?.dataPoints ?? [])].map(
        (point) => point.attributes,
      ),
    ]),
    logs,
  ]);
}

/**
 * The exported bytes, exactly as posted. Protobuf stores strings literally,
 * so this catches a leak even in a field the decoder ignores; binary numbers
 * cannot spell a coordinate or an identifier by accident.
 */
function exportedBytes(observed: Observed): string {
  return Buffer.concat(observed.payloads.map((payload) => payload.body)).toString("utf8");
}

function expectNoRequestData(observed: Observed, secrets: readonly string[]): void {
  const recorded = recordedText(observed);
  const bytes = exportedBytes(observed);
  for (const secret of secrets) {
    expect(recorded, secret).not.toContain(secret);
    expect(bytes, `${secret} in the exported OTLP payloads`).not.toContain(secret);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("W3C trace context through the served API", () => {
  test("an inbound traceparent is continued by the SERVER span and carried by the request log", async () => {
    const telemetry = await startTelemetryApi(databaseUrl);
    const context = caller();
    const response = await send(
      telemetry.api,
      "/api/v1/orders/verify",
      { quantity: 3, ...AT_PARIS },
      context.traceparent,
    );
    expectJson(response, 200);
    // The response does not echo trace context.
    expect(response.headers.get("traceparent")).toBeNull();

    const observed = await observe(telemetry);
    const server = expectCorrelated(observed, context, 200);
    expect(server.name).toBe("POST /api/v1/orders/verify");
    expect(server.status.code).toBe("UNSET");
  });

  test("two overlapping requests with different traceparents never mix trace ids in spans or logs", async () => {
    const telemetry = await startTelemetryApi(databaseUrl);
    const first = caller();
    const second = caller();
    const locks = await holdWarehouseLocks(databaseUrl);
    let responses;
    try {
      const pending = [
        send(
          telemetry.api,
          "/api/v1/orders",
          { submissionId: "qa-tel-overlap-a", quantity: 2, ...AT_PARIS },
          first.traceparent,
        ),
        send(
          telemetry.api,
          "/api/v1/orders",
          { submissionId: "qa-tel-overlap-b", quantity: 3, ...AT_PARIS },
          second.traceparent,
        ),
      ];
      // Both requests are inside their transactions, waiting on the same locks.
      await waitForLockWaiters(pool, 2);
      await locks.release();
      responses = await Promise.all(pending);
    } finally {
      await locks.release();
    }
    for (const response of responses) {
      expectJson(response, 201);
    }

    const observed = await observe(telemetry);
    const names = (traceId: string) =>
      spansOf(observed, traceId)
        .map((span) => span.name)
        .sort();
    for (const context of [first, second]) {
      expectCorrelated(observed, context, 201);
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
    const traces = new Set(observed.spans.map((span) => span.traceId));
    expect([...traces].sort()).toStrictEqual([first.traceId, second.traceId].sort());
    const loggedTraces = new Set(
      observed.records
        .filter((record) => record.trace_id !== undefined)
        .map((record) => record.trace_id),
    );
    expect([...loggedTraces].sort()).toStrictEqual([first.traceId, second.traceId].sort());
  });
});

describe("submission outcomes, correlation and sanitizing through the served API", () => {
  test("201, 422, replay and 400: correlated, counted with bounded attributes, no request data", async () => {
    const telemetry = await startTelemetryApi(databaseUrl);
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
    const first = await send(telemetry.api, "/api/v1/orders", accepted, acceptContext.traceparent);
    const order = expectJson(first, 201) as { orderNumber: string };

    const rejectContext = caller();
    const rejection = await send(
      telemetry.api,
      "/api/v1/orders",
      rejected,
      rejectContext.traceparent,
    );
    expect((expectJson(rejection, 422) as { error: { code: string } }).error.code).toBe(
      "SHIPPING_EXCEEDS_LIMIT",
    );

    const replayContext = caller();
    const replay = await send(telemetry.api, "/api/v1/orders", accepted, replayContext.traceparent);
    expectJson(replay, 201);
    expect(replay.text).toBe(first.text);

    const malformedContext = caller();
    const malformed = await send(
      telemetry.api,
      "/api/v1/orders",
      undefined,
      malformedContext.traceparent,
      malformedText,
    );
    expectErrorEnvelope(malformed, 400, "INVALID_REQUEST");

    const invalidContext = caller();
    const validation = await send(
      telemetry.api,
      "/api/v1/orders",
      invalid,
      invalidContext.traceparent,
    );
    expectErrorEnvelope(validation, 400, "INVALID_REQUEST", { issues: "present" });

    const observed = await observe(telemetry);
    expect(expectCorrelated(observed, acceptContext, 201).status.code).toBe("UNSET");
    expect(expectCorrelated(observed, rejectContext, 422).status.code).toBe("UNSET");
    expectCorrelated(observed, replayContext, 201);
    expect(expectCorrelated(observed, malformedContext, 400).status.code).toBe("UNSET");
    expectCorrelated(observed, invalidContext, 400);

    // One increment per submission that reached the use case; 400s from HTTP
    // validation are not counted (docs/observability.md).
    expect(submissionCounts(observed)).toStrictEqual({
      "scos.submission.outcome=accepted,scos.submission.replayed=false": 1,
      "scos.submission.outcome=accepted,scos.submission.replayed=true": 1,
      "scos.submission.outcome=rejected,scos.submission.rejection_reason=SHIPPING_EXCEEDS_LIMIT,scos.submission.replayed=false": 1,
    });
    expectBoundedMetrics(observed);
    const durations = latest(histogramPoints(observed, REQUEST_DURATION));
    const byStatus = (status: number) =>
      durations
        .filter((point) => point.attributes["http.response.status_code"] === status)
        .reduce((sum, point) => sum + point.count, 0);
    expect([byStatus(201), byStatus(422), byStatus(400)]).toStrictEqual([2, 1, 2]);

    expectNoRequestData(observed, [
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
    ]);
  });
});

describe("an unexpected error through the served API", () => {
  const password = "qa-tel-secret-pw";
  const user = "qa_tel_user";
  // Port 1 is privileged and not listening: connections are refused at once.
  const unreachableUrl = `postgresql://${user}:${password}@127.0.0.1:1/scos_tel_unreachable`;

  test("database unreachable: 500 envelope, ERROR SERVER span, correlated sanitized error log, error outcome", async () => {
    // Its own process and its own collector: this server can serve nothing.
    const telemetry = await startTelemetryApi(unreachableUrl);

    const submitContext = caller();
    const submit = await send(
      telemetry.api,
      "/api/v1/orders",
      { submissionId: "qa-tel-down-5e8a", quantity: 5, ...MANHATTAN },
      submitContext.traceparent,
    );
    expectErrorEnvelope(submit, 500, "INTERNAL_ERROR", { issues: "absent" });

    const verifyContext = caller();
    const verify = await send(
      telemetry.api,
      "/api/v1/orders/verify",
      { quantity: 5, ...MANHATTAN },
      verifyContext.traceparent,
    );
    expectErrorEnvelope(verify, 500, "INTERNAL_ERROR", { issues: "absent" });

    const observed = await observe(telemetry);
    for (const context of [submitContext, verifyContext]) {
      const server = expectCorrelated(observed, context, 500);
      expect(server.status.code).toBe("ERROR");
      expect(server.attributes["error.type"]).toMatch(/^[A-Za-z_$][\w$]*$/);
      // The failure is logged at error level inside the request's trace.
      const errors = logsOf(observed, context.traceId).filter((record) => record.level === "error");
      expect(errors.length).toBeGreaterThanOrEqual(1);
      for (const record of errors) {
        expect(record.span_id).toBeTypeOf("string");
      }
    }

    const counts = submissionCounts(observed);
    expect(Object.keys(counts)).toHaveLength(1);
    const [key] = Object.keys(counts);
    expect(key).toMatch(
      /^error\.type=[A-Za-z_$][\w$]*,scos\.submission\.outcome=error,scos\.submission\.replayed=false$/,
    );
    expect(Object.values(counts)).toStrictEqual([1]);
    expectBoundedMetrics(observed);

    expectNoRequestData(observed, [
      password,
      user,
      "scos_tel_unreachable",
      "postgresql://",
      "127.0.0.1:1",
      "qa-tel-down-5e8a",
      "submissionId",
      String(MANHATTAN.latitude),
      String(MANHATTAN.longitude),
    ]);
  });
});
