/**
 * The telemetry port contract: what any runtime's `Telemetry` composition
 * must produce when driven through the real Hono apps, middleware and
 * decorators (docs/observability.md, "Port contract tests"). A runtime runs it
 * with one call:
 *
 * ```ts
 * describeTelemetryContract("my runtime", () => ({ telemetry, spans, metrics, flush, shutdown }));
 * ```
 *
 * Node/Lambda runs it over `telemetry/node/sdk.ts` with in-memory exporters
 * (telemetry/node/telemetry-contract.test.ts); the Cloudflare Workers
 * composition runs it inside workerd over `telemetry/workers/sdk.ts`
 * (telemetry/workers/telemetry-contract.workers.test.ts).
 *
 * Harness constraint: `spans()` and `metrics()` return the OpenTelemetry JS
 * SDK shapes (`ReadableSpan` from `@opentelemetry/sdk-trace`, `MetricData`
 * from `@opentelemetry/sdk-metrics`). Both runtimes record through the JS SDK
 * and hand over in-memory exporter output; the Workers harness adds up its
 * DELTA per-request exports into the cumulative view `metrics()` returns.
 */

import {
  type NewOrder,
  type Order,
  type SubmissionStore,
  type SubmitOrder,
  type VerifyOrder,
  createSubmitOrder,
  createVerifyOrder,
} from "@scos/core";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { DataPoint, Histogram, MetricData } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createApp } from "#app";
import type { ComposedApplication } from "#composition/composed-application";
import { createHealthApp } from "#endpoints/health/app";
import { createSubmitOrderApp } from "#endpoints/submit-order/app";
import { createVerifyOrderApp } from "#endpoints/verify-order/app";
import { traceInventoryReader } from "#telemetry/decorators/inventory-reader";
import { traceSubmissionStore } from "#telemetry/decorators/submission-store";
import { traceSubmitOrder } from "#telemetry/decorators/submit-order";
import { traceVerifyOrder } from "#telemetry/decorators/verify-order";
import type { Logger } from "#http/logger";
import { instrumentApp } from "#telemetry/http";
import type { Telemetry } from "#telemetry/telemetry";
import {
  acceptedOrder,
  fakeLogger,
  insufficientEstimate,
  inventory,
  post,
  submitBody,
  validEstimate,
  verifyBody,
} from "#testing/fixtures.test-support";

export interface TelemetryContractHarness {
  /** The runtime's Telemetry port, backed by test exporters. */
  readonly telemetry: Telemetry;
  /** Exports anything buffered and returns every span finished so far. */
  spans(): Promise<readonly ReadableSpan[]>;
  /** Collects now and returns every metric's current (cumulative) data. */
  metrics(): Promise<readonly MetricData[]>;
  /** Exports anything buffered. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  /**
   * The runtime's own compositions, built with this harness's telemetry.
   * They must add exactly one SERVER span per request. Required: every
   * runtime deploys through a composition, and that is where double
   * wrapping would happen.
   */
  readonly compositions: {
    readonly combined: (telemetry: Telemetry) => ComposedApplication;
    readonly health: (telemetry: Telemetry) => ComposedApplication;
  };
}

/** Called before every test for a fresh harness. */
export type TelemetryContractHarnessFactory = () =>
  | TelemetryContractHarness
  | Promise<TelemetryContractHarness>;

export const DURATION_METRIC = "http.server.request.duration";
export const SUBMISSIONS = "scos.order.submissions";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";

/** An in-memory SubmissionStore over the one-warehouse fixture inventory. */
export function memorySubmissionStore(): SubmissionStore {
  const orders = new Map<string, Order>();
  let stock = inventory;
  return {
    findOrderBySubmissionKey: async (key) => orders.get(key) ?? null,
    async runInTransaction(work) {
      return work({
        lockInventory: async () => stock,
        findOrderBySubmissionKey: async (key) => orders.get(key) ?? null,
        async saveAcceptedOrder(order: NewOrder) {
          const saved: Order = { ...order, id: "01996000-0000-7000-8000-00000000abcd" };
          orders.set(order.submissionKey, saved);
          stock = stock.map((warehouse) => ({
            ...warehouse,
            available: warehouse.available - order.quantity,
          }));
          return saved;
        },
      });
    },
  };
}

function pointsOf<Value = number>(
  metrics: readonly MetricData[],
  name: string,
): DataPoint<Value>[] {
  const metric = metrics.find((candidate) => candidate.descriptor.name === name);
  return (metric?.dataPoints ?? []) as DataPoint<Value>[];
}

export function describeTelemetryContract(
  name: string,
  createHarness: TelemetryContractHarnessFactory,
): void {
  describe(`telemetry port contract: ${name}`, () => {
    let harness: TelemetryContractHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.shutdown();
    });

    const servers = async () =>
      (await harness.spans()).filter((span) => span.kind === SpanKind.SERVER);

    async function server(): Promise<ReadableSpan> {
      const found = await servers();
      expect(found, "exactly one SERVER span").toHaveLength(1);
      return found[0] as ReadableSpan;
    }

    async function span(spanName: string): Promise<ReadableSpan> {
      const found = (await harness.spans()).filter((candidate) => candidate.name === spanName);
      expect(found, `exactly one ${spanName} span`).toHaveLength(1);
      return found[0] as ReadableSpan;
    }

    interface Doubles {
      readonly verifyOrder?: VerifyOrder;
      readonly submitOrder?: SubmitOrder;
    }

    /** The combined app, traced use cases, wrapped once as the compositions do. */
    function combined(doubles: Doubles = {}, logger: Logger = fakeLogger()): Hono {
      const { telemetry } = harness;
      return instrumentApp(
        createApp({
          verifyOrder: traceVerifyOrder(
            doubles.verifyOrder ?? (async () => validEstimate),
            telemetry,
          ),
          submitOrder: traceSubmitOrder(
            doubles.submitOrder ??
              (async () => ({ kind: "accepted", order: acceptedOrder, replayed: false })),
            telemetry,
          ),
          logger,
        }),
        telemetry,
        logger,
      );
    }

    /** The combined app over real use cases and traced in-memory ports. */
    function overPorts(store: SubmissionStore = memorySubmissionStore()): Hono {
      const { telemetry } = harness;
      const logger = fakeLogger();
      const inventoryReader = traceInventoryReader(
        { readInventorySnapshot: async () => inventory },
        telemetry,
      );
      return instrumentApp(
        createApp({
          verifyOrder: traceVerifyOrder(createVerifyOrder({ inventoryReader }), telemetry),
          submitOrder: traceSubmitOrder(
            createSubmitOrder({ store: traceSubmissionStore(store, telemetry) }),
            telemetry,
          ),
          logger,
        }),
        telemetry,
        logger,
      );
    }

    describe("one SERVER span per request", () => {
      test("the combined app: one SERVER span per request, named METHOD /route", async () => {
        const app = combined();
        expect((await app.request("/health")).status).toBe(200);
        expect((await post(app, "/api/v1/orders/verify", verifyBody)).status).toBe(200);
        expect((await post(app, "/api/v1/orders", submitBody)).status).toBe(201);
        expect((await app.request("/nope")).status).toBe(404);
        expect((await servers()).map((candidate) => candidate.name)).toStrictEqual([
          "GET /health",
          "POST /api/v1/orders/verify",
          "POST /api/v1/orders",
          "GET",
        ]);
      });

      test.each([
        [
          "health",
          () => createHealthApp({ logger: fakeLogger() }),
          "/health",
          undefined,
          "GET /health",
        ],
        [
          "verify",
          () =>
            createVerifyOrderApp({ verifyOrder: async () => validEstimate, logger: fakeLogger() }),
          "/api/v1/orders/verify",
          verifyBody,
          "POST /api/v1/orders/verify",
        ],
        [
          "submit",
          () =>
            createSubmitOrderApp({
              submitOrder: async () => ({ kind: "accepted", order: acceptedOrder, replayed: true }),
              logger: fakeLogger(),
            }),
          "/api/v1/orders",
          submitBody,
          "POST /api/v1/orders",
        ],
      ] as const)(
        "the standalone %s app: one SERVER span per request, responses unchanged",
        async (_name, build, path, body, spanName) => {
          const send = (app: Hono, target: string) =>
            body === undefined ? app.request(target) : post(app, target, body);
          for (const target of [path, "/nope"]) {
            const plain = await send(build(), target);
            const instrumented = await send(
              instrumentApp(build(), harness.telemetry, fakeLogger()),
              target,
            );
            expect(instrumented.status).toBe(plain.status);
            expect(await instrumented.text()).toBe(await plain.text());
            expect([...instrumented.headers]).toStrictEqual([...plain.headers]);
          }
          expect((await servers()).map((candidate) => candidate.name)).toStrictEqual([
            spanName,
            body === undefined ? "GET" : "POST",
          ]);
        },
      );

      test("the runtime's compositions add exactly one SERVER span per request", async () => {
        const whole = harness.compositions.combined(harness.telemetry);
        const health = harness.compositions.health(harness.telemetry);
        try {
          expect((await whole.app.request("/health")).status).toBe(200);
          expect((await whole.app.request("/api/v1/orders", { method: "POST" })).status).toBe(400);
          expect((await health.app.request("/health")).status).toBe(200);
          expect((await servers()).map((candidate) => candidate.name)).toStrictEqual([
            "GET /health",
            "POST /api/v1/orders",
            "GET /health",
          ]);
          const counts = pointsOf<Histogram>(await harness.metrics(), DURATION_METRIC).map(
            (point) => point.value.count,
          );
          expect(counts).toStrictEqual([2, 1]);
        } finally {
          await Promise.all([whole.close(), health.close()]);
        }
      });
    });

    describe("server span name and HTTP semantic-convention attributes", () => {
      test("a matched route: METHOD /route, stable HTTP attributes, no query string", async () => {
        expect((await post(combined(), "/api/v1/orders/verify?debug=1", verifyBody)).status).toBe(
          200,
        );
        const found = await server();
        expect(found.name).toBe("POST /api/v1/orders/verify");
        expect(found.parentSpanContext).toBeUndefined();
        expect(found.attributes).toStrictEqual({
          "http.request.method": "POST",
          "url.scheme": "http",
          "url.path": "/api/v1/orders/verify",
          "http.route": "/api/v1/orders/verify",
          "http.response.status_code": 200,
        });
      });

      test("no matched route: named by method only, no http.route", async () => {
        expect((await combined().request("/api/v1/nope?id=secret-query")).status).toBe(404);
        const found = await server();
        expect(found.name).toBe("GET");
        expect(found.attributes).toStrictEqual({
          "http.request.method": "GET",
          "url.scheme": "http",
          "url.path": "/api/v1/nope",
          "http.response.status_code": 404,
        });
        expect(found.status.code).toBe(SpanStatusCode.UNSET);
      });

      test("an unknown method: _OTHER with the original method, named HTTP", async () => {
        expect((await combined().request("/health", { method: "PURGE" })).status).toBe(404);
        const found = await server();
        expect(found.name).toBe("HTTP");
        expect(found.attributes).toMatchObject({
          "http.request.method": "_OTHER",
          "http.request.method_original": "PURGE",
        });
      });
    });

    describe("span status", () => {
      test.each([
        [
          "200 verify",
          () => post(combined(), "/api/v1/orders/verify", verifyBody),
          200,
          "/api/v1/orders/verify",
        ],
        [
          "201 accepted",
          () => post(combined(), "/api/v1/orders", submitBody),
          201,
          "/api/v1/orders",
        ],
        [
          "400 malformed JSON",
          () => post(combined(), "/api/v1/orders", "{not json"),
          400,
          "/api/v1/orders",
        ],
        [
          "400 schema failure",
          () => post(combined(), "/api/v1/orders/verify", { quantity: "1" }),
          400,
          "/api/v1/orders/verify",
        ],
        [
          "409 conflict",
          () =>
            post(
              combined({
                submitOrder: async () => ({ kind: "conflict", submissionKey: "k" as never }),
              }),
              "/api/v1/orders",
              submitBody,
            ),
          409,
          "/api/v1/orders",
        ],
        [
          "422 business rejection",
          () =>
            post(
              combined({
                submitOrder: async () => ({
                  kind: "rejected",
                  reason: "INSUFFICIENT_STOCK",
                  estimate: insufficientEstimate as never,
                }),
              }),
              "/api/v1/orders",
              submitBody,
            ),
          422,
          "/api/v1/orders",
        ],
      ] as const)("%s: unset, no error.type", async (_name, send, status, route) => {
        expect((await send()).status).toBe(status);
        const found = await server();
        expect(found.status.code).toBe(SpanStatusCode.UNSET);
        expect(found.attributes).toMatchObject({
          "http.response.status_code": status,
          "http.route": route,
        });
        expect(found.attributes).not.toHaveProperty("error.type");
      });

      test("503 unavailable: ERROR with error.type 503", async () => {
        const response = await post(
          combined({ submitOrder: async () => ({ kind: "unavailable", attempts: 3 }) }),
          "/api/v1/orders",
          submitBody,
        );
        expect(response.status).toBe(503);
        const found = await server();
        expect(found.status.code).toBe(SpanStatusCode.ERROR);
        expect(found.attributes).toMatchObject({
          "http.response.status_code": 503,
          "error.type": "503",
        });
      });

      test("500 unexpected exception: ERROR, sanitized exception type, response unchanged", async () => {
        const failure = new TypeError("connect ECONNREFUSED postgresql://u:leaky@db lat=12.34");
        const throwing: VerifyOrder = async () => {
          throw failure;
        };
        const logger = fakeLogger();
        const response = await post(
          combined({ verifyOrder: throwing }, logger),
          "/api/v1/orders/verify",
          verifyBody,
        );
        const plain = await post(
          createVerifyOrderApp({ verifyOrder: throwing, logger: fakeLogger() }),
          "/api/v1/orders/verify",
          verifyBody,
        );
        expect(response.status).toBe(500);
        expect(await response.text()).toBe(await plain.text());
        // Logged once: by the endpoint's handler, not again by the wrapper.
        expect(logger.error).toHaveBeenCalledOnce();
        const found = await server();
        expect(found.status.code).toBe(SpanStatusCode.ERROR);
        expect(found.attributes).toMatchObject({
          "http.response.status_code": 500,
          "error.type": "TypeError",
        });
        expect(found.events.map((event) => event.attributes)).toStrictEqual([
          { "exception.type": "TypeError" },
        ]);
        expect(
          JSON.stringify((await harness.spans()).map((s) => [s.attributes, s.events, s.status])),
        ).not.toMatch(/leaky|12\.34|ECONNREFUSED/);
      });
    });

    describe("W3C trace context", () => {
      test("a valid traceparent and tracestate continue the caller's trace", async () => {
        const response = await combined().request("/health", {
          headers: {
            traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
            tracestate: "vendor=opaque,other=1",
          },
        });
        expect(response.status).toBe(200);
        const found = await server();
        expect(found.spanContext().traceId).toBe(TRACE_ID);
        expect(found.parentSpanContext).toMatchObject({ spanId: PARENT_ID, isRemote: true });
        expect(found.spanContext().traceState?.serialize()).toBe("vendor=opaque,other=1");
      });

      test.each([
        ["garbage", "not-a-traceparent"],
        ["all-zero trace id", `00-00000000000000000000000000000000-${PARENT_ID}-01`],
        ["all-zero span id", `00-${TRACE_ID}-0000000000000000-01`],
        ["version ff", `ff-${TRACE_ID}-${PARENT_ID}-01`],
        ["short trace id", `00-4bf92f35-${PARENT_ID}-01`],
      ])("an invalid traceparent (%s) is ignored: a new root trace", async (_name, value) => {
        const response = await combined().request("/health", { headers: { traceparent: value } });
        expect(response.status).toBe(200);
        expect(await response.json()).toStrictEqual({ status: "ok" });
        const found = await server();
        expect(found.parentSpanContext).toBeUndefined();
        expect(found.spanContext().traceId).not.toBe(TRACE_ID);
        expect(found.spanContext().traceId).toMatch(/^(?!0{32})[0-9a-f]{32}$/);
      });

      test("concurrent requests never share context", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const seen: Record<string, string | undefined> = {};
        const verifyOrder: VerifyOrder = async (request) => {
          const key = String(request.quantity);
          const before = trace.getActiveSpan()?.spanContext().traceId;
          await gate; // every request is in flight here at once
          await new Promise((resolve) => setTimeout(resolve, Number(key) % 7));
          const after = trace.getActiveSpan()?.spanContext().traceId;
          expect(after).toBe(before);
          seen[key] = after;
          return validEstimate;
        };
        const app = combined({ verifyOrder });
        const traceIds = Array.from(
          { length: 10 },
          (_, index) => `${String(index + 1).padStart(2, "0")}${"a".repeat(30)}`,
        );
        const requests = traceIds.map((traceId, index) =>
          app.request("/api/v1/orders/verify", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              traceparent: `00-${traceId}-${PARENT_ID}-01`,
            },
            body: JSON.stringify({ ...verifyBody, quantity: index + 1 }),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        release();
        const responses = await Promise.all(requests);

        expect(responses.map((response) => response.status)).toStrictEqual(traceIds.map(() => 200));
        traceIds.forEach((traceId, index) => {
          expect(seen[String(index + 1)]).toBe(traceId);
        });
        const all = await harness.spans();
        const serverByTrace = new Map(
          all.filter((s) => s.kind === SpanKind.SERVER).map((s) => [s.spanContext().traceId, s]),
        );
        expect(serverByTrace.size).toBe(10);
        for (const s of all.filter((candidate) => candidate.name === "VerifyOrder")) {
          expect(s.parentSpanContext?.spanId).toBe(
            serverByTrace.get(s.spanContext().traceId)?.spanContext().spanId,
          );
        }
        expect(trace.getActiveSpan()).toBeUndefined();
      });
    });

    describe("INTERNAL spans for the use cases and ports", () => {
      /** name -> parent name, within one trace. */
      function tree(spans: readonly ReadableSpan[]): Record<string, string | undefined> {
        const byId = new Map(spans.map((s) => [s.spanContext().spanId, s.name]));
        return Object.fromEntries(
          spans.map((s) => [
            s.name,
            s.parentSpanContext === undefined ? undefined : byId.get(s.parentSpanContext.spanId),
          ]),
        );
      }

      test("verification: SERVER > VerifyOrder > InventoryReader.readInventorySnapshot", async () => {
        expect((await post(overPorts(), "/api/v1/orders/verify", verifyBody)).status).toBe(200);
        const spans = await harness.spans();
        expect(tree(spans)).toStrictEqual({
          "POST /api/v1/orders/verify": undefined,
          VerifyOrder: "POST /api/v1/orders/verify",
          "InventoryReader.readInventorySnapshot": "VerifyOrder",
        });
        const verify = await span("VerifyOrder");
        const read = await span("InventoryReader.readInventorySnapshot");
        for (const s of [verify, read]) {
          expect(s.kind).toBe(SpanKind.INTERNAL);
          expect(s.status.code).toBe(SpanStatusCode.UNSET);
          expect(s.spanContext().traceId).toBe((await server()).spanContext().traceId);
          expect(s.ended).toBe(true);
          expect(s.duration[0] * 1e9 + s.duration[1]).toBeGreaterThanOrEqual(0);
        }
        expect(verify.attributes).toStrictEqual({ "scos.estimate.valid": true });
        expect(read.attributes).toStrictEqual({ "scos.inventory.warehouse_count": 1 });
      });

      test("a new submission: every store and transaction port span under SubmitOrder", async () => {
        expect((await post(overPorts(), "/api/v1/orders", submitBody)).status).toBe(201);
        const spans = await harness.spans();
        expect(spans.map((s) => s.name)).toStrictEqual([
          "SubmissionStore.findOrderBySubmissionKey",
          "SubmissionTransaction.lockInventory",
          "SubmissionTransaction.findOrderBySubmissionKey",
          "SubmissionTransaction.saveAcceptedOrder",
          "SubmissionStore.runInTransaction",
          "SubmitOrder",
          "POST /api/v1/orders",
        ]);
        expect(tree(spans)).toStrictEqual({
          "POST /api/v1/orders": undefined,
          SubmitOrder: "POST /api/v1/orders",
          "SubmissionStore.findOrderBySubmissionKey": "SubmitOrder",
          "SubmissionStore.runInTransaction": "SubmitOrder",
          "SubmissionTransaction.lockInventory": "SubmissionStore.runInTransaction",
          "SubmissionTransaction.findOrderBySubmissionKey": "SubmissionStore.runInTransaction",
          "SubmissionTransaction.saveAcceptedOrder": "SubmissionStore.runInTransaction",
        });
        for (const s of spans.filter((candidate) => candidate.kind !== SpanKind.SERVER)) {
          expect(s.kind, s.name).toBe(SpanKind.INTERNAL);
        }
        for (const s of spans) {
          expect(s.status.code, s.name).toBe(SpanStatusCode.UNSET);
        }
        expect((await span("SubmitOrder")).attributes).toStrictEqual({
          "scos.submission.outcome": "accepted",
          "scos.submission.replayed": false,
        });
        expect((await span("SubmissionStore.findOrderBySubmissionKey")).attributes).toStrictEqual({
          "scos.submission.order_found": false,
        });
      });

      test("a replay: only the unlocked lookup, which finds the Order", async () => {
        const app = overPorts();
        await post(app, "/api/v1/orders", submitBody);
        const first = new Set((await harness.spans()).map((s) => s.spanContext().spanId));
        expect((await post(app, "/api/v1/orders", submitBody)).status).toBe(201);
        const replay = (await harness.spans()).filter((s) => !first.has(s.spanContext().spanId));
        expect(replay.map((s) => [s.name, s.attributes])).toStrictEqual([
          ["SubmissionStore.findOrderBySubmissionKey", { "scos.submission.order_found": true }],
          [
            "SubmitOrder",
            { "scos.submission.outcome": "accepted", "scos.submission.replayed": true },
          ],
          [
            "POST /api/v1/orders",
            {
              "http.request.method": "POST",
              "url.scheme": "http",
              "url.path": "/api/v1/orders",
              "http.response.status_code": 201,
              "http.route": "/api/v1/orders",
            },
          ],
        ]);
      });
    });

    describe("http.server.request.duration", () => {
      test("a histogram in seconds with semconv buckets, attributes and one count per request", async () => {
        const app = combined();
        await post(app, "/api/v1/orders/verify", verifyBody);
        await post(app, "/api/v1/orders/verify", verifyBody);
        await post(app, "/api/v1/orders/verify", { quantity: 0 });
        await app.request("/unknown/123?x=1");
        await post(
          combined({ submitOrder: async () => ({ kind: "unavailable", attempts: 1 }) }),
          "/api/v1/orders",
          submitBody,
        );

        const metrics = await harness.metrics();
        const descriptor = metrics.find((m) => m.descriptor.name === DURATION_METRIC)?.descriptor;
        expect(descriptor).toMatchObject({
          name: DURATION_METRIC,
          unit: "s",
          description: "Duration of HTTP server requests.",
        });
        const points = pointsOf<Histogram>(metrics, DURATION_METRIC);
        expect(points.map((point) => [point.attributes, point.value.count])).toStrictEqual([
          [
            {
              "http.request.method": "POST",
              "url.scheme": "http",
              "http.response.status_code": 200,
              "http.route": "/api/v1/orders/verify",
            },
            2,
          ],
          [
            {
              "http.request.method": "POST",
              "url.scheme": "http",
              "http.response.status_code": 400,
              "http.route": "/api/v1/orders/verify",
            },
            1,
          ],
          [
            {
              "http.request.method": "GET",
              "url.scheme": "http",
              "http.response.status_code": 404,
            },
            1,
          ],
          [
            {
              "http.request.method": "POST",
              "url.scheme": "http",
              "http.response.status_code": 503,
              "http.route": "/api/v1/orders",
              "error.type": "503",
            },
            1,
          ],
        ]);
        const ok = points[0];
        expect(ok?.value.buckets.boundaries).toStrictEqual([
          0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
        ]);
        // Not > 0: some runtimes (workerd) only advance timers after I/O.
        expect(ok?.value.sum).toBeGreaterThanOrEqual(0);
        expect(ok?.value.sum).toBeLessThan(5); // seconds, not milliseconds
      });
    });

    describe("scos.order.submissions", () => {
      test("one increment per completed submission, replays included; 400s are not counted", async () => {
        const app = overPorts();
        const send = (body: unknown) => post(app, "/api/v1/orders", body);
        expect((await send(submitBody)).status).toBe(201); // accepted
        expect((await send(submitBody)).status).toBe(201); // replay
        expect((await send(submitBody)).status).toBe(201); // replay
        expect((await send({ ...submitBody, quantity: 31 })).status).toBe(409); // conflict
        expect((await send({ ...submitBody, submissionId: "big", quantity: 1_000 })).status).toBe(
          422,
        );
        expect(
          (await send({ ...submitBody, submissionId: "far", quantity: 1, latitude: 90 })).status,
        ).toBe(422);
        expect((await send({ submissionId: "" })).status).toBe(400); // never reaches the use case

        const points = pointsOf(await harness.metrics(), SUBMISSIONS);
        expect(
          Object.fromEntries(
            points.map((point) => [JSON.stringify(point.attributes), point.value]),
          ),
        ).toStrictEqual({
          [JSON.stringify({
            "scos.submission.outcome": "accepted",
            "scos.submission.replayed": false,
          })]: 1,
          [JSON.stringify({
            "scos.submission.outcome": "accepted",
            "scos.submission.replayed": true,
          })]: 2,
          [JSON.stringify({
            "scos.submission.outcome": "conflict",
            "scos.submission.replayed": false,
          })]: 1,
          [JSON.stringify({
            "scos.submission.outcome": "rejected",
            "scos.submission.replayed": false,
            "scos.submission.rejection_reason": "INSUFFICIENT_STOCK",
          })]: 1,
          [JSON.stringify({
            "scos.submission.outcome": "rejected",
            "scos.submission.replayed": false,
            "scos.submission.rejection_reason": "SHIPPING_EXCEEDS_LIMIT",
          })]: 1,
        });
        // Rejections and conflicts are business outcomes: no error status anywhere.
        for (const s of await harness.spans()) {
          expect(s.status.code, s.name).toBe(SpanStatusCode.UNSET);
        }
      });

      test("the use case's own invalid, unavailable and error outcomes each count once", async () => {
        const submit = traceSubmitOrder(
          createSubmitOrder({
            store: traceSubmissionStore(memorySubmissionStore(), harness.telemetry),
          }),
          harness.telemetry,
        );
        await submit({ submissionId: "x" }); // invalid: only reachable below the HTTP validator
        await post(
          combined({ submitOrder: async () => ({ kind: "unavailable", attempts: 3 }) }),
          "/api/v1/orders",
          submitBody,
        );
        await post(
          combined({
            submitOrder: async () => {
              throw new RangeError("leaky");
            },
          }),
          "/api/v1/orders",
          submitBody,
        );
        const points = pointsOf(await harness.metrics(), SUBMISSIONS);
        expect(points.map((point) => [point.attributes, point.value])).toStrictEqual([
          [{ "scos.submission.outcome": "invalid", "scos.submission.replayed": false }, 1],
          [{ "scos.submission.outcome": "unavailable", "scos.submission.replayed": false }, 1],
          [
            {
              "scos.submission.outcome": "error",
              "scos.submission.replayed": false,
              "error.type": "RangeError",
            },
            1,
          ],
        ]);
      });
    });

    describe("no forbidden values in any span or metric", () => {
      test("submission IDs, coordinates, order numbers, raw URLs, queries and bodies never appear", async () => {
        const secretKey = "customer-secret-key-7f3a";
        const coordinates = { latitude: 0.123456, longitude: 0.654321 };
        const app = overPorts();
        const body = { submissionId: secretKey, quantity: 30, ...coordinates };
        const accepted = await post(app, "/api/v1/orders?token=secret-query-value", body);
        expect(accepted.status).toBe(201);
        const order = (await accepted.json()) as { orderNumber: string };
        expect((await post(app, "/api/v1/orders", body)).status).toBe(201);
        await post(app, "/api/v1/orders/verify?debug=secret-query-value", {
          quantity: 30,
          ...coordinates,
        });
        await app.request("/unknown/secret-path-segment?q=secret-query-value");

        const spans = await harness.spans();
        const metrics = await harness.metrics();
        const recorded = JSON.stringify([
          spans.map((s) => [s.name, s.attributes, s.events, s.links, s.status]),
          metrics.map((m) => [m.descriptor.name, m.dataPoints.map((point) => point.attributes)]),
        ]);
        for (const secret of [
          secretKey,
          "submissionId",
          order.orderNumber,
          acceptedOrder.id,
          "0.123456",
          "0.654321",
          "secret-query-value",
          "token=",
          "?",
          "http://",
          JSON.stringify(body),
          '"quantity"',
        ]) {
          expect(recorded, secret).not.toContain(secret);
        }
        // The unmatched raw path may be on the span, never in a metric.
        const metricText = JSON.stringify(
          metrics.map((m) => m.dataPoints.map((p) => p.attributes)),
        );
        expect(metricText).not.toContain("secret-path-segment");
        expect(metricText).not.toContain("url.path");

        const keys = new Set(spans.flatMap((s) => Object.keys(s.attributes)));
        expect(keys).toStrictEqual(
          new Set([
            "http.request.method",
            "url.scheme",
            "url.path",
            "http.route",
            "http.response.status_code",
            "scos.estimate.valid",
            "scos.inventory.warehouse_count",
            "scos.submission.order_found",
            "scos.submission.outcome",
            "scos.submission.replayed",
          ]),
        );
      });
    });
  });
}
