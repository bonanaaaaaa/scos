import { type SubmitOrder, type VerifyOrder } from "@scos/core";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";

import { createApp } from "../app";
import { composeHealthApplication } from "../endpoints/health/composition";
import { createHealthApp } from "../endpoints/health/app";
import { createVerifyOrderApp } from "../endpoints/verify-order/app";
import type { Logger } from "../http/logger";
import {
  acceptedOrder,
  fakeLogger,
  post,
  validEstimate,
  verifyBody,
} from "../testing/fixtures.test-support";
import { captureLogs, testTelemetry } from "../testing/telemetry.test-support";
import { traceSubmitOrder, traceVerifyOrder } from "./decorators";
import { instrumentApp } from "./http";
import { createPinoLogger } from "./node/pino-logger";

const DURATION = "http.server.request.duration";

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

describe("request duration under Node", () => {
  test("measures real elapsed time in seconds", async () => {
    const app = combined({
      verifyOrder: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return validEstimate;
      },
    });
    expect((await post(app, "/api/v1/orders/verify", verifyBody)).status).toBe(200);
    const [point] = await harness.histogram(DURATION);
    expect(point?.value.sum).toBeGreaterThanOrEqual(0.015);
    expect(point?.value.sum).toBeLessThan(5);
  });
});

describe("compositions without telemetry", () => {
  test("are not wrapped: no SERVER span", async () => {
    const composed = composeHealthApplication();
    expect((await composed.app.request("/health")).status).toBe(200);
    expect(servers()).toHaveLength(0);
  });
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
