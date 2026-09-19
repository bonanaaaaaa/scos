import { type SubmitOrder, type VerifyOrder } from "@scos/core";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createApp } from "../app";
import { composeApplication } from "../composition";
import { composeHealthApplication } from "../endpoints/health/composition";
import { createHealthApp } from "../endpoints/health/app";
import { createSubmitOrderApp } from "../endpoints/submit-order/app";
import { createVerifyOrderApp } from "../endpoints/verify-order/app";
import type { Logger } from "../http/logger";
import {
  acceptedOrder,
  fakeLogger,
  insufficientEstimate,
  post,
  submitBody,
  validEstimate,
  verifyBody,
} from "../testing/fixtures.test-support";
import { unreachableDatabaseUrl } from "../testing/persistence-spies.test-support";
import { captureLogs, testTelemetry } from "../testing/telemetry.test-support";
import { traceSubmitOrder, traceVerifyOrder } from "./decorators";
import { instrumentApp } from "./http";
import { createPinoLogger } from "./node/pino-logger";
import { HTTP_SERVER_DURATION_BUCKETS, SUBMISSIONS_METRIC } from "./telemetry";

const DURATION = "http.server.request.duration";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";

let harness = testTelemetry();

afterEach(async () => {
  await harness.shutdown();
  harness = testTelemetry();
});

function servers(): ReadableSpan[] {
  return harness.finished().filter((span) => span.kind === SpanKind.SERVER);
}

function server(): ReadableSpan {
  const found = servers();
  expect(found).toHaveLength(1);
  return found[0] as ReadableSpan;
}

interface Doubles {
  readonly verifyOrder?: VerifyOrder;
  readonly submitOrder?: SubmitOrder;
}

/** The combined app with traced use cases, wrapped like `composeApplication` does. */
function combined(doubles: Doubles = {}, logger: Logger = fakeLogger()): Hono {
  const { telemetry } = harness;
  return instrumentApp(
    createApp({
      verifyOrder: traceVerifyOrder(doubles.verifyOrder ?? (async () => validEstimate), telemetry),
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

describe("server span per request", () => {
  test("a new trace: SERVER span named METHOD /route with stable HTTP attributes", async () => {
    const response = await post(combined(), "/api/v1/orders/verify?debug=1", verifyBody);
    expect(response.status).toBe(200);

    const span = server();
    expect(span.name).toBe("POST /api/v1/orders/verify");
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.attributes).toStrictEqual({
      "http.request.method": "POST",
      "url.scheme": "http",
      "url.path": "/api/v1/orders/verify",
      "http.route": "/api/v1/orders/verify",
      "http.response.status_code": 200,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    // The use case span is a child of the server span in the same trace.
    const verify = harness.span("VerifyOrder");
    expect(verify.parentSpanContext?.spanId).toBe(span.spanContext().spanId);
    expect(verify.spanContext().traceId).toBe(span.spanContext().traceId);
  });

  test("a valid W3C traceparent/tracestate continues the caller's trace", async () => {
    const app = combined();
    const response = await app.request("/health", {
      headers: {
        traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
        tracestate: "vendor=opaque,other=1",
      },
    });
    expect(response.status).toBe(200);

    const span = server();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext).toMatchObject({ spanId: PARENT_ID, isRemote: true });
    expect(span.spanContext().traceState?.serialize()).toBe("vendor=opaque,other=1");
    expect(span.name).toBe("GET /health");
  });

  test.each([
    ["garbage", "not-a-traceparent"],
    ["all-zero trace id", `00-00000000000000000000000000000000-${PARENT_ID}-01`],
    ["all-zero span id", `00-${TRACE_ID}-0000000000000000-01`],
    ["version ff", `ff-${TRACE_ID}-${PARENT_ID}-01`],
    ["short trace id", `00-4bf92f35-${PARENT_ID}-01`],
  ])(
    "an invalid traceparent (%s) is ignored: a new root trace, same response",
    async (_name, value) => {
      const response = await combined().request("/health", { headers: { traceparent: value } });
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({ status: "ok" });
      const span = server();
      expect(span.parentSpanContext).toBeUndefined();
      expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    },
  );

  test("concurrent requests keep their own context: no leakage between them", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: Record<string, string | undefined> = {};
    const verifyOrder: VerifyOrder = async (request) => {
      const key = String(request.quantity);
      const before = trace.getActiveSpan()?.spanContext().traceId;
      await gate; // both requests are in flight here at once
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
    // Each use-case span is the child of its own request's server span.
    const serverByTrace = new Map(servers().map((span) => [span.spanContext().traceId, span]));
    for (const span of harness.finished().filter((candidate) => candidate.name === "VerifyOrder")) {
      expect(span.parentSpanContext?.spanId).toBe(
        serverByTrace.get(span.spanContext().traceId)?.spanContext().spanId,
      );
    }
    expect(servers()).toHaveLength(10);
    // Outside any request there is no active span.
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});

describe("span status follows the HTTP semantic conventions for server spans", () => {
  test.each([
    [
      "200 verify",
      () => post(combined(), "/api/v1/orders/verify", verifyBody),
      200,
      "/api/v1/orders/verify",
    ],
    ["201 accepted", () => post(combined(), "/api/v1/orders", submitBody), 201, "/api/v1/orders"],
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
  ] as const)("%s: status unset, no error.type", async (_name, send, status, route) => {
    const response = await send();
    expect(response.status).toBe(status);
    const span = server();
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toMatchObject({
      "http.response.status_code": status,
      "http.route": route,
    });
    expect(span.attributes).not.toHaveProperty("error.type");
  });

  test("404: no http.route, span named by method only, status unset", async () => {
    const response = await combined().request("/api/v1/nope?id=secret-query");
    expect(response.status).toBe(404);
    const span = server();
    expect(span.name).toBe("GET");
    expect(span.attributes).toStrictEqual({
      "http.request.method": "GET",
      "url.scheme": "http",
      "url.path": "/api/v1/nope",
      "http.response.status_code": 404,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("an unknown method is recorded as _OTHER with the original method", async () => {
    const response = await combined().request("/health", { method: "PURGE" });
    expect(response.status).toBe(404);
    const span = server();
    expect(span.name).toBe("HTTP");
    expect(span.attributes).toMatchObject({
      "http.request.method": "_OTHER",
      "http.request.method_original": "PURGE",
    });
  });

  test("503 unavailable: ERROR with error.type 503", async () => {
    const response = await post(
      combined({ submitOrder: async () => ({ kind: "unavailable", attempts: 3 }) }),
      "/api/v1/orders",
      submitBody,
    );
    expect(response.status).toBe(503);
    const span = server();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      "http.response.status_code": 503,
      "error.type": "503",
    });
  });

  test("500 unexpected exception: ERROR with the sanitized exception type, response unchanged", async () => {
    const failure = new TypeError("connect ECONNREFUSED postgresql://u:leaky@db lat=12.34");
    const logger = fakeLogger();
    const app = combined(
      {
        verifyOrder: async () => {
          throw failure;
        },
      },
      logger,
    );
    const uninstrumented = createVerifyOrderApp({
      verifyOrder: async () => {
        throw failure;
      },
      logger: fakeLogger(),
    });

    const response = await post(app, "/api/v1/orders/verify", verifyBody);
    const plain = await post(uninstrumented, "/api/v1/orders/verify", verifyBody);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe(await plain.text());
    expect(logger.error).toHaveBeenCalledOnce();
    const span = server();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      "http.response.status_code": 500,
      "error.type": "TypeError",
    });
    expect(span.events.map((event) => event.attributes)).toStrictEqual([
      { "exception.type": "TypeError" },
    ]);
    expect(JSON.stringify(harness.finished().map((s) => [s.attributes, s.events]))).not.toMatch(
      /leaky|12\.34|ECONNREFUSED/,
    );
  });
});

describe("http.server.request.duration", () => {
  test("a histogram in seconds with the semconv buckets and bounded attributes", async () => {
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

    const points = await harness.histogram(DURATION);
    const byAttributes = Object.fromEntries(
      points.map((point) => [JSON.stringify(point.attributes), point.value]),
    );
    expect(Object.keys(byAttributes).map((key) => JSON.parse(key) as unknown)).toStrictEqual([
      {
        "http.request.method": "POST",
        "url.scheme": "http",
        "http.response.status_code": 200,
        "http.route": "/api/v1/orders/verify",
      },
      {
        "http.request.method": "POST",
        "url.scheme": "http",
        "http.response.status_code": 400,
        "http.route": "/api/v1/orders/verify",
      },
      { "http.request.method": "GET", "url.scheme": "http", "http.response.status_code": 404 },
      {
        "http.request.method": "POST",
        "url.scheme": "http",
        "http.response.status_code": 503,
        "http.route": "/api/v1/orders",
        "error.type": "503",
      },
    ]);
    const ok = points[0];
    expect(ok?.value.count).toBe(2);
    expect(ok?.value.buckets.boundaries).toStrictEqual([...HTTP_SERVER_DURATION_BUCKETS]);
    expect(ok?.value.sum).toBeGreaterThan(0);
    expect(ok?.value.sum).toBeLessThan(5); // seconds, not milliseconds

    await harness.points(DURATION);
    const exported = (await harness.metrics()).find(
      (metric) => metric.descriptor.name === DURATION,
    );
    expect(exported?.descriptor).toMatchObject({
      unit: "s",
      description: "Duration of HTTP server requests.",
    });
  });

  test("advised bucket boundaries match the stable HTTP semantic conventions", () => {
    expect(HTTP_SERVER_DURATION_BUCKETS).toStrictEqual([
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
    ]);
  });
});

describe("one server span per request in every deployment shape", () => {
  test("the combined composition (all routes, one wrapper) records exactly one SERVER span", async () => {
    const composed = composeApplication({
      databaseUrl: unreachableDatabaseUrl,
      logger: fakeLogger(),
      telemetry: harness.telemetry,
    });
    try {
      expect((await composed.app.request("/health")).status).toBe(200);
      expect((await composed.app.request("/api/v1/orders", { method: "POST" })).status).toBe(400);
      expect(servers().map((span) => span.name)).toStrictEqual([
        "GET /health",
        "POST /api/v1/orders",
      ]);
      expect((await harness.histogram(DURATION)).map((point) => point.value.count)).toStrictEqual([
        1, 1,
      ]);
    } finally {
      await composed.close();
    }
  });

  test("the standalone health composition records one SERVER span", async () => {
    const composed = composeHealthApplication({
      telemetry: harness.telemetry,
      logger: fakeLogger(),
    });
    expect((await composed.app.request("/health")).status).toBe(200);
    expect(servers().map((span) => span.name)).toStrictEqual(["GET /health"]);
  });

  test("without telemetry the compositions are not wrapped", async () => {
    const composed = composeHealthApplication();
    expect((await composed.app.request("/health")).status).toBe(200);
    expect(servers()).toHaveLength(0);
  });

  test.each([
    ["health", () => createHealthApp({ logger: fakeLogger() }), "/health", undefined],
    [
      "verify",
      () => createVerifyOrderApp({ verifyOrder: async () => validEstimate, logger: fakeLogger() }),
      "/api/v1/orders/verify",
      verifyBody,
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
    ],
  ] as const)(
    "instrumenting the standalone %s app changes no response",
    async (_name, build, path, body) => {
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
      expect(servers()).toHaveLength(2);
    },
  );
});

describe("request logs and sensitive data", () => {
  test("one correlated 'request completed' record per request; no body, IDs or coordinates in any signal", async () => {
    const capture = captureLogs();
    const logger = createPinoLogger({ destination: capture.destination });
    const secretKey = "customer-secret-key-9c1d";
    const coordinates = { latitude: 12.345678, longitude: 98.765432 };
    const app = combined(
      {
        submitOrder: async () => ({ kind: "accepted", order: acceptedOrder, replayed: false }),
      },
      logger,
    );

    const response = await post(app, "/api/v1/orders", {
      submissionId: secretKey,
      quantity: 30,
      ...coordinates,
    });
    expect(response.status).toBe(201);

    const span = server();
    expect(capture.records()).toStrictEqual([
      {
        level: "info",
        severity_number: 9,
        time: expect.any(String),
        "http.request.method": "POST",
        "url.scheme": "http",
        "http.response.status_code": 201,
        "http.route": "/api/v1/orders",
        "url.path": "/api/v1/orders",
        "http.server.request.duration": expect.any(Number),
        msg: "request completed",
      },
    ]);

    const recorded = JSON.stringify([
      harness.finished().map((s) => [s.name, s.attributes, s.events, s.links]),
      await harness.metrics(),
      capture.writes,
    ]);
    for (const secret of [
      secretKey,
      acceptedOrder.orderNumber,
      acceptedOrder.id,
      "12.345678",
      "98.765432",
      "submissionId",
    ]) {
      expect(recorded, secret).not.toContain(secret);
    }
    expect(span.attributes).not.toHaveProperty("url.query");
    expect(attributeKeys()).toStrictEqual(
      new Set([
        "http.request.method",
        "url.scheme",
        "url.path",
        "http.route",
        "http.response.status_code",
        "scos.submission.outcome",
        "scos.submission.replayed",
      ]),
    );
  });

  test("the counter is recorded through the HTTP path once per submission request", async () => {
    const app = combined({
      submitOrder: vi
        .fn<SubmitOrder>()
        .mockResolvedValueOnce({ kind: "accepted", order: acceptedOrder, replayed: false })
        .mockResolvedValueOnce({ kind: "accepted", order: acceptedOrder, replayed: true }),
    });
    await post(app, "/api/v1/orders", submitBody);
    await post(app, "/api/v1/orders", submitBody);
    await post(app, "/api/v1/orders", { submissionId: "" }); // 400: never reaches the use case
    const points = await harness.points(SUBMISSIONS_METRIC);
    expect(points.map((point) => [point.attributes, point.value])).toStrictEqual([
      [{ "scos.submission.outcome": "accepted", "scos.submission.replayed": false }, 1],
      [{ "scos.submission.outcome": "accepted", "scos.submission.replayed": true }, 1],
    ]);
  });
});

/** Every attribute key on every finished span. */
function attributeKeys(): Set<string> {
  return new Set(harness.finished().flatMap((span) => Object.keys(span.attributes)));
}

describe("telemetry failures never change the response", () => {
  test("a throwing request logger: original status and body, span ended, duration recorded", async () => {
    const throwing = {
      ...createPinoLogger({ destination: captureLogs().destination }),
      info: () => {
        throw new Error("log sink failed");
      },
    };
    const app = combined({}, throwing);
    const plain = createVerifyOrderApp({
      verifyOrder: async () => validEstimate,
      logger: fakeLogger(),
    });

    const response = await post(app, "/api/v1/orders/verify", verifyBody);
    const expected = await post(plain, "/api/v1/orders/verify", verifyBody);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(await expected.text());
    const span = server();
    expect(span.ended).toBe(true);
    expect(span.attributes["http.response.status_code"]).toBe(200);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect((await harness.histogram(DURATION)).map((point) => point.value.count)).toStrictEqual([
      1,
    ]);
  });

  test("a tracer that throws when starting the span: the request runs uninstrumented", async () => {
    const broken = {
      ...harness.telemetry,
      tracer: {
        ...harness.telemetry.tracer,
        startSpan: () => {
          throw new Error("tracer failed");
        },
      },
    } as typeof harness.telemetry;
    const app = instrumentApp(
      createVerifyOrderApp({ verifyOrder: async () => validEstimate, logger: fakeLogger() }),
      broken,
      fakeLogger(),
    );
    const response = await post(app, "/api/v1/orders/verify", verifyBody);
    expect(response.status).toBe(200);
    expect(servers()).toHaveLength(0);
  });

  test("a histogram that throws: the span still ends and the status is unchanged", async () => {
    const broken = {
      ...harness.telemetry,
      httpServerDuration: {
        record: () => {
          throw new Error("meter failed");
        },
      },
    } as typeof harness.telemetry;
    const app = instrumentApp(createHealthApp({ logger: fakeLogger() }), broken, fakeLogger());
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(server().ended).toBe(true);
  });
});
