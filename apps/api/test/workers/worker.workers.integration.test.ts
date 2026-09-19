/**
 * The Worker entrypoint inside workerd against real PostgreSQL through the
 * Hyperdrive binding: every endpoint, replay, rejection and conflict;
 * concurrent submissions in one isolate (each request with its own Prisma
 * client and pool); persistence spans, metric values and correlated logs
 * from the real composition; and an unreachable collector that changes no
 * response and holds no lock.
 */

import { env } from "cloudflare:workers";
import { SpanKind } from "@opentelemetry/api";
import type { ExecutionContext } from "hono";
import { describe, expect, test } from "vitest";

import {
  type WorkerRuntime,
  createWorkerHandler,
  workersRuntime,
} from "../../src/entrypoints/worker";
import { createWorkersTelemetry } from "../../src/telemetry/workers/sdk";
import { accumulateDeltas } from "../../src/testing/workers-telemetry.test-support";
import {
  InMemoryMetricExporter,
  AggregationTemporality,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";

const AT_PARIS = { latitude: 49.009722, longitude: 2.547778 } as const;
const FAR_AWAY = { latitude: -45, longitude: 170 } as const;
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil: (promise) => void pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  };
  return { ctx, settle: () => Promise.allSettled(pending) };
}

interface Harness {
  readonly lines: string[];
  readonly spans: InMemorySpanExporter;
  readonly metrics: InMemoryMetricExporter;
  send(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

function worker(variables: Record<string, string> = {}, useRealExporters = false): Harness {
  const lines: string[] = [];
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const runtime: WorkerRuntime = {
    ...workersRuntime,
    createTelemetry: (config) =>
      createWorkersTelemetry(config, {
        write: (line) => lines.push(line),
        ...(useRealExporters ? {} : { spanExporter: spans, metricExporter: metrics }),
      }),
  };
  const handler = createWorkerHandler(runtime);
  return {
    lines,
    spans,
    metrics,
    async send(path, body, headers = {}) {
      const { ctx, settle } = executionContext();
      const response = await handler.fetch(
        new Request(`http://worker.test${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        }),
        { ...env, ...variables },
        ctx,
      );
      // What the Workers runtime does after the response: the database
      // close and the telemetry flush, both under waitUntil.
      await settle();
      return response;
    },
  };
}

function records(lines: readonly string[]) {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function exported(metrics: InMemoryMetricExporter): MetricData[] {
  return accumulateDeltas(
    metrics
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)),
  );
}

describe("the Worker over Hyperdrive and PostgreSQL", () => {
  test("health, verification, acceptance, replay, rejection, conflict and invalid input", async () => {
    const harness = worker();
    const key = `worker-${crypto.randomUUID()}`;
    const order = { submissionId: key, quantity: 2, ...AT_PARIS };

    expect((await harness.send("/health")).status).toBe(200);

    const verify = await harness.send(
      "/api/v1/orders/verify",
      { quantity: 2, ...AT_PARIS },
      { traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` },
    );
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ valid: true, quantity: 2, orderTotal: "300.00" });

    const accepted = await harness.send("/api/v1/orders", order);
    expect(accepted.status).toBe(201);
    const acceptedBody = await accepted.text();
    expect(JSON.parse(acceptedBody)).toMatchObject({ submissionId: key, quantity: 2 });

    const replay = await harness.send("/api/v1/orders", order);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(acceptedBody);

    const rejected = await harness.send("/api/v1/orders", {
      submissionId: `${key}-far`,
      quantity: 1,
      ...FAR_AWAY,
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ error: { code: "SHIPPING_EXCEEDS_LIMIT" } });

    const conflict = await harness.send("/api/v1/orders", { ...order, quantity: 3 });
    expect(conflict.status).toBe(409);

    expect((await harness.send("/api/v1/orders", { quantity: "2" })).status).toBe(400);

    // Spans: the SERVER span per request and the persistence spans under it.
    const spans = harness.spans.getFinishedSpans();
    expect(
      spans.filter((span) => span.kind === SpanKind.SERVER).map((span) => span.name),
    ).toStrictEqual([
      "GET /health",
      "POST /api/v1/orders/verify",
      "POST /api/v1/orders",
      "POST /api/v1/orders",
      "POST /api/v1/orders",
      "POST /api/v1/orders",
      "POST /api/v1/orders",
    ]);
    const names = new Set(spans.map((span) => span.name));
    for (const name of [
      "VerifyOrder",
      "InventoryReader.readInventorySnapshot",
      "SubmitOrder",
      "SubmissionStore.findOrderBySubmissionKey",
      "SubmissionStore.runInTransaction",
      "SubmissionTransaction.lockInventory",
      "SubmissionTransaction.findOrderBySubmissionKey",
      "SubmissionTransaction.saveAcceptedOrder",
    ]) {
      expect(names, name).toContain(name);
    }
    const verifySpan = spans.find((span) => span.name === "POST /api/v1/orders/verify");
    expect(verifySpan?.spanContext().traceId).toBe(TRACE_ID);

    // Metrics: every request timed; completed submissions counted once each.
    const metrics = exported(harness.metrics);
    const submissions = metrics.find(
      (metric) => metric.descriptor.name === "scos.order.submissions",
    );
    expect(submissions?.dataPoints.map((point) => [point.attributes, point.value])).toStrictEqual([
      [{ "scos.submission.outcome": "accepted", "scos.submission.replayed": false }, 1],
      [{ "scos.submission.outcome": "accepted", "scos.submission.replayed": true }, 1],
      [
        {
          "scos.submission.outcome": "rejected",
          "scos.submission.replayed": false,
          "scos.submission.rejection_reason": "SHIPPING_EXCEEDS_LIMIT",
        },
        1,
      ],
      [{ "scos.submission.outcome": "conflict", "scos.submission.replayed": false }, 1],
    ]);
    const durations = metrics.find(
      (metric) => metric.descriptor.name === "http.server.request.duration",
    );
    const counted = durations?.dataPoints.reduce(
      (total, point) => total + (point.value as { count: number }).count,
      0,
    );
    expect(counted).toBe(7);

    // Logs: one correlated record per request; nothing sensitive anywhere.
    const logged = records(harness.lines).filter((record) => record.msg === "request completed");
    expect(logged).toHaveLength(7);
    expect(logged[1]).toMatchObject({ trace_id: TRACE_ID, "http.response.status_code": 200 });
    const everything = JSON.stringify([
      harness.lines,
      spans.map((span) => span.attributes),
      metrics,
    ]);
    expect(everything).not.toContain(key);
    expect(everything).not.toContain("49.009722");
    expect(everything).not.toMatch(/SO-[0-9A-Z]{12}/);
    expect(everything).not.toContain(env.HYPERDRIVE.connectionString);
  });

  test("concurrent submissions in one isolate each use their own database client", async () => {
    const harness = worker({ LOG_LEVEL: "silent" });
    const prefix = `worker-concurrent-${crypto.randomUUID()}`;
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        harness.send("/api/v1/orders", {
          submissionId: `${prefix}-${index}`,
          quantity: 1,
          ...AT_PARIS,
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toStrictEqual(Array(8).fill(201));
    const verify = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.send("/api/v1/orders/verify", { quantity: 1, ...AT_PARIS }),
      ),
    );
    expect(verify.map((response) => response.status)).toStrictEqual(Array(8).fill(200));
  });

  test("an unreachable collector changes no response and holds no lock", async () => {
    const harness = worker(
      {
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
        OTEL_EXPORTER_OTLP_TIMEOUT: "500",
      },
      true,
    );
    const unhandled: unknown[] = [];
    const listener = (event: Event) => {
      unhandled.push((event as PromiseRejectionEvent).reason);
    };
    addEventListener("unhandledrejection", listener);
    try {
      const prefix = `worker-collector-down-${crypto.randomUUID()}`;
      for (let index = 0; index < 5; index += 1) {
        const started = Date.now();
        const response = await harness.send("/api/v1/orders", {
          submissionId: `${prefix}-${index}`,
          quantity: 1,
          ...AT_PARIS,
        });
        expect(response.status).toBe(201);
        // Each submission locks every warehouse; a lock held by the previous
        // request (or its telemetry) would stall this one.
        expect(Date.now() - started).toBeLessThan(5_000);
      }
      const failures = records(harness.lines).filter(
        (record) => record.msg === "OpenTelemetry export failed",
      );
      expect(failures).toHaveLength(10);
      expect(harness.lines.join("\n")).not.toContain("127.0.0.1");
      // workerd still prints "Network connection lost" per failed export; none
      // of it is an unhandled rejection of ours (docs/observability.md, "Tests").
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      removeEventListener("unhandledrejection", listener);
    }
    expect(unhandled).toStrictEqual([]);
  });
});
