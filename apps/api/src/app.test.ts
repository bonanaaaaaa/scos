import {
  type OrderEstimate,
  type OrderRequest,
  type SubmitOrder,
  type SubmitOrderOutcome,
  TransientSubmissionError,
  type VerifyOrder,
} from "@scos/core";
import { describe, expect, test, vi } from "vitest";

import { createApp } from "./app";
import { API_PREFIX } from "./http/route-contract";
import { routes } from "./routes";
import { createHealthApp } from "./endpoints/health/app";
import { createSubmitOrderApp } from "./endpoints/submit-order/app";
import { rejectedSubmissionResponseSchema } from "./endpoints/submit-order/contract";
import { SUBMIT_ORDER_MESSAGES } from "./endpoints/submit-order/messages";
import { createVerifyOrderApp } from "./endpoints/verify-order/app";
import { errorResponseSchema } from "./http/errors";
import { defaultLogger } from "./http/logger";
import { MESSAGES } from "./http/messages";
import {
  acceptedOrder,
  fakeLogger,
  insufficientEstimate,
  json,
  post,
  shippingEstimate,
  submitBody,
  validEstimate,
  verifyBody,
} from "./testing/fixtures.test-support";
import {
  type Case,
  combined,
  fail,
  healthCases,
  noSubmit,
  noVerify,
  send,
  silent,
  submitCases,
  unknownCases,
  verifyCases,
} from "./testing/requests.test-support";

/** The combined app over fake use cases, as the local server builds it. */
function harness(
  options: {
    verify?: (request: OrderRequest) => Promise<OrderEstimate>;
    submit?: (input: unknown) => Promise<SubmitOrderOutcome>;
  } = {},
) {
  const verifyOrder = vi.fn<VerifyOrder>(options.verify ?? (async () => validEstimate));
  const submitOrder = vi.fn<SubmitOrder>(
    options.submit ?? (async () => ({ kind: "accepted", order: acceptedOrder, replayed: false })),
  );
  const logger = fakeLogger();
  return { app: createApp({ verifyOrder, submitOrder, logger }), verifyOrder, submitOrder, logger };
}

describe("GET /health", () => {
  test("reports liveness without calling any use case", async () => {
    const { app, verifyOrder, submitOrder } = harness();
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toStrictEqual({ status: "ok" });
    expect(verifyOrder).not.toHaveBeenCalled();
    expect(submitOrder).not.toHaveBeenCalled();
  });
});

describe("the combined app across endpoints", () => {
  test.each([
    ["INSUFFICIENT_STOCK", insufficientEstimate, SUBMIT_ORDER_MESSAGES.insufficientStock],
    ["SHIPPING_EXCEEDS_LIMIT", shippingEstimate, SUBMIT_ORDER_MESSAGES.shippingExceedsLimit],
  ] as const)("422 %s includes the estimate", async (reason, estimate, message) => {
    if (estimate.valid) {
      throw new Error("fixture must be a rejection");
    }
    const { app } = harness({ submit: async () => ({ kind: "rejected", reason, estimate }) });
    const response = await post(app, "/api/v1/orders", submitBody);

    expect(response.status).toBe(422);
    const body = await json(response, rejectedSubmissionResponseSchema.strict());
    expect(body.error).toStrictEqual({ code: reason, message });
    // Same serialization as verification.
    const verified = await post(
      harness({ verify: async () => estimate }).app,
      "/api/v1/orders/verify",
      {
        quantity: estimate.quantity,
        latitude: estimate.destination.latitude,
        longitude: estimate.destination.longitude,
      },
    );
    expect(body.estimate).toStrictEqual(await verified.json());
  });

  test("HTTP maps outcomes only: a thrown TransientSubmissionError is a 500 on both routes", async () => {
    const thrown = async () => {
      throw new TransientSubmissionError("connection timeout");
    };
    const { app } = harness({ verify: thrown, submit: thrown });
    for (const [path, body] of [
      ["/api/v1/orders/verify", verifyBody],
      ["/api/v1/orders", submitBody],
    ] as const) {
      const response = await post(app, path, body);
      expect(response.status).toBe(500);
      expect(response.headers.get("retry-after")).toBeNull();
    }
  });
});

describe("unknown routes", () => {
  test.each([
    ["GET", "/api/v1/orders"],
    ["GET", "/nope"],
    ["DELETE", "/api/v1/orders/verify"],
    ["POST", "/health"],
  ])("%s %s is 404 NOT_FOUND in the error envelope", async (method, path) => {
    const { app } = harness();
    const response = await app.request(path, { method });

    expect(response.status).toBe(404);
    expect(await json(response, errorResponseSchema)).toStrictEqual({
      error: { code: "NOT_FOUND", message: MESSAGES.notFound },
    });
  });
});

/** Captures the default logger's `console.log` lines as parsed records. */
function captureConsole() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return {
    records: () =>
      spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>),
    restore: () => spy.mockRestore(),
  };
}

describe("default logger", () => {
  test("writes unexpected errors as one JSON record through console.log", () => {
    const stdout = captureConsole();
    try {
      defaultLogger.error("boom", { path: "/api/v1/orders" });
      expect(stdout.records()).toMatchObject([
        { level: "error", severity_number: 17, msg: "boom", path: "/api/v1/orders" },
      ]);
    } finally {
      stdout.restore();
    }
  });

  test("each level and child loggers write through the same console sink", () => {
    const stdout = captureConsole();
    try {
      defaultLogger.trace("hidden at the default info level");
      defaultLogger.debug("hidden at the default info level");
      defaultLogger.info("i");
      defaultLogger.warn("w");
      defaultLogger.fatal("f");
      defaultLogger.child({ component: "c" }).info("from child");
      expect(stdout.records()).toMatchObject([
        { level: "info", msg: "i" },
        { level: "warn", msg: "w" },
        { level: "fatal", msg: "f" },
        { level: "info", msg: "from child", component: "c" },
      ]);
    } finally {
      stdout.restore();
    }
  });

  test("createApp falls back to it", async () => {
    const stdout = captureConsole();
    try {
      const app = createApp({
        verifyOrder: async () => {
          throw new Error("down");
        },
        submitOrder: async () => ({ kind: "unavailable", attempts: 1 }),
      });
      expect((await post(app, "/api/v1/orders/verify", verifyBody)).status).toBe(500);
      expect(stdout.records()).toMatchObject([
        {
          level: "error",
          msg: "Unhandled error while handling a request",
          error: { type: "Error" },
        },
      ]);
    } finally {
      stdout.restore();
    }
  });
});

describe("each standalone endpoint app responds byte-identically to the combined app", () => {
  test.each(verifyCases)("createVerifyOrderApp: $name", async (request) => {
    const standalone = createVerifyOrderApp({
      verifyOrder: request.verify ?? noVerify,
      logger: silent(),
    });
    expect(await send(standalone, request)).toStrictEqual(await send(combined(request), request));
  });

  test.each(submitCases)("createSubmitOrderApp: $name", async (request) => {
    const standalone = createSubmitOrderApp({
      submitOrder: request.submit ?? noSubmit,
      logger: silent(),
    });
    expect(await send(standalone, request)).toStrictEqual(await send(combined(request), request));
  });

  test.each(healthCases)("createHealthApp: $name", async (request) => {
    expect(await send(createHealthApp(), request)).toStrictEqual(
      await send(combined(request), request),
    );
  });

  test.each(unknownCases)("404 envelope for $name on every app", async (request) => {
    const expected = await send(combined(request), request);
    expect(expected.status).toBe(404);
    for (const app of [
      createHealthApp(),
      createVerifyOrderApp({ verifyOrder: noVerify }),
      createSubmitOrderApp({ submitOrder: noSubmit }),
    ]) {
      expect(await send(app, request)).toStrictEqual(expected);
    }
  });
});

describe("mounting keeps each endpoint's error handling", () => {
  test("a failure is handled once, by the mounted app, with its route's message", async () => {
    const logger = silent();
    const app = createApp({ verifyOrder: fail, submitOrder: fail, logger });

    const verify = await send(app, verifyCases.at(-1) as Case);
    const submit = await send(app, submitCases.at(-1) as Case);

    expect(JSON.parse(verify.body)).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: MESSAGES.internal },
    });
    expect(JSON.parse(submit.body)).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: SUBMIT_ORDER_MESSAGES.internal },
    });
    expect(verify.body + submit.body).not.toContain("secret");
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(
      logger.error.mock.calls.map(([, details]) => [
        (details as Record<string, unknown>)["url.path"],
        (details as Record<string, unknown>)["http.route"],
      ]),
    ).toStrictEqual([
      ["/api/v1/orders/verify", "/api/v1/orders/verify"],
      ["/api/v1/orders", "/api/v1/orders"],
    ]);
  });
});

describe("the order endpoints live under API_PREFIX only", () => {
  test("the prefix is /api/v1 and health stays at the root", () => {
    expect(API_PREFIX).toBe("/api/v1");
    expect(routes.verifyOrder.path).toBe("/api/v1/orders/verify");
    expect(routes.submitOrder.path).toBe("/api/v1/orders");
    expect(routes.health.path).toBe("/health");
  });

  test.each([
    ["/orders/verify", verifyBody],
    ["/orders", submitBody],
    ["/api/orders/verify", verifyBody],
    ["/api/orders", submitBody],
    ["/api/v1/health", undefined],
  ])(
    "POST or GET %s is the standard 404 on every app, with no redirect or alias",
    async (path, body) => {
      const verifyOrder = vi.fn<VerifyOrder>(async () => validEstimate);
      const submitOrder = vi.fn<SubmitOrder>(async () => ({ kind: "unavailable", attempts: 1 }));
      const apps = [
        createApp({ verifyOrder, submitOrder, logger: fakeLogger() }),
        createHealthApp(),
        createVerifyOrderApp({ verifyOrder }),
        createSubmitOrderApp({ submitOrder }),
      ];
      for (const app of apps) {
        const response = body === undefined ? await app.request(path) : await post(app, path, body);
        expect(response.status).toBe(404);
        expect(response.headers.get("location")).toBeNull();
        expect(await json(response, errorResponseSchema)).toStrictEqual({
          error: { code: "NOT_FOUND", message: MESSAGES.notFound },
        });
      }
      expect(verifyOrder).not.toHaveBeenCalled();
      expect(submitOrder).not.toHaveBeenCalled();
    },
  );
});
