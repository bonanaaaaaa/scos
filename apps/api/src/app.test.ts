import {
  type InventorySnapshot,
  type Order,
  type OrderEstimate,
  type OrderRequest,
  type SubmitOrder,
  type SubmitOrderOutcome,
  TransientSubmissionError,
  type VerifyOrder,
  createOrder,
  estimateOrder,
  orderRequestSchema,
  submissionKeySchema,
} from "@scos/core";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { type Logger, MESSAGES, consoleLogger, createApp } from "./app";
import {
  errorResponseSchema,
  orderResponseSchema,
  rejectedSubmissionResponseSchema,
  verifyOrderResponseSchema,
} from "./http/contracts";

// One warehouse at (0, 0) with 100 units: 30 units shipped 55.6 km is valid,
// 1 unit to the North Pole costs more than 15% of $150, and 1 000 is too many.
const inventory: InventorySnapshot = [
  {
    warehouseId: "01996000-0000-7000-8000-000000000001",
    latitude: 0,
    longitude: 0,
    available: 100,
  },
];

function estimateFor(quantity: number, latitude: number, longitude: number): OrderEstimate {
  return estimateOrder(orderRequestSchema.parse({ quantity, latitude, longitude }), inventory);
}

const validEstimate = estimateFor(30, 0, 0.5);
const shippingEstimate = estimateFor(1, 90, 0);
const insufficientEstimate = estimateFor(1_000, 0, 0);

const acceptedOrder: Order = {
  ...createOrder({
    orderNumber: "SO-0123456789AB",
    submissionKey: submissionKeySchema.parse("order-1"),
    estimate: validEstimate,
  }),
  id: "01996000-0000-7000-8000-00000000abcd",
};

const verifyBody = { quantity: 30, latitude: 0, longitude: 0.5 };
const submitBody = { submissionId: "order-1", ...verifyBody };

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly verifyOrder: ReturnType<typeof vi.fn<VerifyOrder>>;
  readonly submitOrder: ReturnType<typeof vi.fn<SubmitOrder>>;
  readonly logger: { error: ReturnType<typeof vi.fn<Logger["error"]>> };
}

function harness(
  options: {
    verify?: (request: OrderRequest) => Promise<OrderEstimate>;
    submit?: (input: unknown) => Promise<SubmitOrderOutcome>;
  } = {},
): Harness {
  const verifyOrder = vi.fn<VerifyOrder>(options.verify ?? (async () => validEstimate));
  const submitOrder = vi.fn<SubmitOrder>(
    options.submit ?? (async () => ({ kind: "accepted", order: acceptedOrder, replayed: false })),
  );
  const logger = { error: vi.fn<Logger["error"]>() };
  return { app: createApp({ verifyOrder, submitOrder, logger }), verifyOrder, submitOrder, logger };
}

function post(app: Harness["app"], path: string, body: unknown, contentType = "application/json") {
  return app.request(path, {
    method: "POST",
    headers: contentType === "" ? {} : { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  return schema.parse(await response.json());
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

describe("POST /orders/verify", () => {
  test("200 with a valid estimate, money as decimal strings", async () => {
    const { app, verifyOrder } = harness();
    const response = await post(app, "/orders/verify", verifyBody);

    expect(response.status).toBe(200);
    const body = await json(response, verifyOrderResponseSchema);
    expect(body).toStrictEqual({
      valid: true,
      reason: null,
      quantity: 30,
      destination: { latitude: 0, longitude: 0.5 },
      merchandiseSubtotal: "4500.00",
      discountRate: "0.05",
      discountAmount: "225.00",
      discountedMerchandiseTotal: "4275.00",
      shippingCost: validEstimate.shippingCost?.toString(),
      orderTotal: validEstimate.orderTotal?.toString(),
      allocations: [
        {
          warehouseId: inventory[0]?.warehouseId,
          quantity: 30,
          distanceKm: validEstimate.allocations[0]?.distanceKm,
        },
      ],
    });
    expect(verifyOrder).toHaveBeenCalledExactlyOnceWith(orderRequestSchema.parse(verifyBody));
  });

  test("200 with SHIPPING_EXCEEDS_LIMIT keeps every amount", async () => {
    const { app } = harness({ verify: async () => shippingEstimate });
    const response = await post(app, "/orders/verify", { quantity: 1, latitude: 90, longitude: 0 });

    expect(response.status).toBe(200);
    const body = await json(response, verifyOrderResponseSchema);
    expect(body).toMatchObject({
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      merchandiseSubtotal: "150.00",
      discountRate: "0.00",
      shippingCost: shippingEstimate.shippingCost?.toString(),
      orderTotal: shippingEstimate.orderTotal?.toString(),
    });
    expect(body.allocations).toHaveLength(1);
  });

  test("200 with INSUFFICIENT_STOCK has null shipping and total and no allocations", async () => {
    const { app } = harness({ verify: async () => insufficientEstimate });
    const response = await post(app, "/orders/verify", {
      quantity: 1_000,
      latitude: 0,
      longitude: 0,
    });

    expect(response.status).toBe(200);
    expect(await json(response, verifyOrderResponseSchema)).toStrictEqual({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      quantity: 1_000,
      destination: { latitude: 0, longitude: 0 },
      merchandiseSubtotal: "150000.00",
      discountRate: "0.20",
      discountAmount: "30000.00",
      discountedMerchandiseTotal: "120000.00",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });
  });

  test("400 for an invalid body lists each issue with its path and skips the use case", async () => {
    const { app, verifyOrder } = harness();
    const response = await post(app, "/orders/verify", {
      quantity: "10",
      latitude: 91,
      longitude: 0,
      extra: 1,
    });

    expect(response.status).toBe(400);
    const body = await json(response, errorResponseSchema);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toBe(MESSAGES.invalidBody);
    expect(body.error.issues?.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([["quantity"], ["latitude"], []]),
    );
    expect(verifyOrder).not.toHaveBeenCalled();
  });

  test("HTTP maps outcomes only: a thrown TransientSubmissionError is a 500 on both routes", async () => {
    const thrown = async () => {
      throw new TransientSubmissionError("connection timeout");
    };
    const { app } = harness({ verify: thrown, submit: thrown });
    for (const [path, body] of [
      ["/orders/verify", verifyBody],
      ["/orders", submitBody],
    ] as const) {
      const response = await post(app, path, body);
      expect(response.status).toBe(500);
      expect(response.headers.get("retry-after")).toBeNull();
    }
  });

  test("500 when the use case throws, without exposing internals", async () => {
    const { app, logger } = harness({
      verify: async () => {
        throw new Error("connect ECONNREFUSED postgresql://user:secret@db/scos");
      },
    });
    const response = await post(app, "/orders/verify", verifyBody);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toMatch(/ECONNREFUSED|secret|postgresql|stack/i);
    expect(errorResponseSchema.parse(JSON.parse(text))).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: MESSAGES.internal },
    });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      path: "/orders/verify",
      error: expect.any(Error),
    });
  });
});

describe("POST /orders", () => {
  const expectedOrder = {
    orderNumber: "SO-0123456789AB",
    submissionId: "order-1",
    quantity: 30,
    destination: { latitude: 0, longitude: 0.5 },
    unitPrice: "150.00",
    merchandiseSubtotal: "4500.00",
    discountRate: "0.05",
    discountAmount: "225.00",
    discountedMerchandiseTotal: "4275.00",
    shippingCost: acceptedOrder.shippingCost.toString(),
    orderTotal: acceptedOrder.orderTotal.toString(),
    allocations: [{ warehouseId: inventory[0]?.warehouseId, quantity: 30 }],
  };

  test("201 with the new Order; the internal id is not exposed", async () => {
    const { app, submitOrder } = harness();
    const response = await post(app, "/orders", submitBody);

    expect(response.status).toBe(201);
    const body = await json(response, orderResponseSchema.strict());
    expect(body).toStrictEqual(expectedOrder);
    expect(JSON.stringify(body)).not.toContain(acceptedOrder.id);
    expect(submitOrder).toHaveBeenCalledExactlyOnceWith(submitBody);
  });

  test("201 with a byte-identical body for a repeated submissionId", async () => {
    let replayed = false;
    const { app } = harness({
      submit: async () => {
        const outcome = { kind: "accepted", order: acceptedOrder, replayed } as const;
        replayed = true;
        return outcome;
      },
    });
    const first = await post(app, "/orders", submitBody);
    const repeat = await post(app, "/orders", submitBody);

    expect([first.status, repeat.status]).toStrictEqual([201, 201]);
    expect(await repeat.text()).toBe(await first.text());
  });

  test.each([
    ["INSUFFICIENT_STOCK", insufficientEstimate, MESSAGES.insufficientStock],
    ["SHIPPING_EXCEEDS_LIMIT", shippingEstimate, MESSAGES.shippingExceedsLimit],
  ] as const)("422 %s includes the estimate", async (reason, estimate, message) => {
    if (estimate.valid) {
      throw new Error("fixture must be a rejection");
    }
    const { app } = harness({ submit: async () => ({ kind: "rejected", reason, estimate }) });
    const response = await post(app, "/orders", submitBody);

    expect(response.status).toBe(422);
    const body = await json(response, rejectedSubmissionResponseSchema.strict());
    expect(body.error).toStrictEqual({ code: reason, message });
    // Same serialization as verification.
    const verified = await post(harness({ verify: async () => estimate }).app, "/orders/verify", {
      quantity: estimate.quantity,
      latitude: estimate.destination.latitude,
      longitude: estimate.destination.longitude,
    });
    expect(body.estimate).toStrictEqual(await verified.json());
  });

  test("409 for a conflicting submissionId reveals nothing about the existing Order", async () => {
    const { app } = harness({
      submit: async () => ({
        kind: "conflict",
        submissionKey: submissionKeySchema.parse("order-1"),
      }),
    });
    const response = await post(app, "/orders", submitBody);

    expect(response.status).toBe(409);
    expect(await json(response, errorResponseSchema.strict())).toStrictEqual({
      error: { code: "SUBMISSION_ID_CONFLICT", message: MESSAGES.conflict },
    });
  });

  test("400 if the use case still reports invalid input", async () => {
    const { app } = harness({
      submit: async () => ({
        kind: "invalid",
        issues: [{ code: "custom", path: ["quantity"], message: "Bad quantity", input: 1 }],
      }),
    });
    const response = await post(app, "/orders", submitBody);

    expect(response.status).toBe(400);
    expect(await json(response, errorResponseSchema)).toStrictEqual({
      error: {
        code: "INVALID_REQUEST",
        message: MESSAGES.invalidBody,
        issues: [{ path: ["quantity"], message: "Bad quantity" }],
      },
    });
  });

  test("503 with Retry-After when every attempt failed transiently", async () => {
    const { app } = harness({ submit: async () => ({ kind: "unavailable", attempts: 3 }) });
    const response = await post(app, "/orders", submitBody);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await json(response, errorResponseSchema)).toStrictEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: MESSAGES.unavailable },
    });
  });

  test("500 when the use case throws; the message never implies acceptance", async () => {
    const { app, logger } = harness({
      submit: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'orders')");
      },
    });
    const response = await post(app, "/orders", submitBody);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toMatch(/TypeError|undefined|orders'/);
    expect(JSON.parse(text)).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: MESSAGES.submitInternal },
    });
    expect(MESSAGES.submitInternal).toMatch(/could not be confirmed/);
    expect(MESSAGES.submitInternal).toMatch(/same submissionId/);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("request validation before any use case", () => {
  const cases: readonly [string, unknown, string, string][] = [
    ["malformed JSON", "{ quantity: 1", "application/json", MESSAGES.malformedJson],
    ["an empty body", "", "application/json", MESSAGES.malformedJson],
    ["no Content-Type", JSON.stringify(submitBody), "", MESSAGES.unsupportedContentType],
    ["text/plain", JSON.stringify(submitBody), "text/plain", MESSAGES.unsupportedContentType],
    [
      "a form body",
      "quantity=1&latitude=0",
      "application/x-www-form-urlencoded",
      MESSAGES.unsupportedContentType,
    ],
    ["a JSON array", [submitBody], "application/json", MESSAGES.invalidBody],
    ["JSON null", "null", "application/json", MESSAGES.invalidBody],
    ["an empty object", {}, "application/json", MESSAGES.invalidBody],
    [
      "a string quantity",
      { ...submitBody, quantity: "30" },
      "application/json",
      MESSAGES.invalidBody,
    ],
    [
      "an unknown field",
      { ...submitBody, idempotencyKey: "x" },
      "application/json",
      MESSAGES.invalidBody,
    ],
    [
      "a blank submissionId",
      { ...submitBody, submissionId: " \t\n" },
      "application/json",
      MESSAGES.invalidBody,
    ],
    ["a missing submissionId", verifyBody, "application/json", MESSAGES.invalidBody],
    [
      "a 256-character submissionId",
      { ...submitBody, submissionId: "x".repeat(256) },
      "application/json",
      MESSAGES.invalidBody,
    ],
    ["a zero quantity", { ...submitBody, quantity: 0 }, "application/json", MESSAGES.invalidBody],
    [
      "a longitude above 180",
      { ...submitBody, longitude: 180.5 },
      "application/json",
      MESSAGES.invalidBody,
    ],
  ];

  test.each(cases)(
    "POST /orders with %s is 400 INVALID_REQUEST",
    async (_name, body, type, message) => {
      const { app, submitOrder, logger } = harness();
      const response = await post(app, "/orders", body, type);

      expect(response.status).toBe(400);
      const parsed = await json(response, errorResponseSchema);
      expect(parsed.error.code).toBe("INVALID_REQUEST");
      expect(parsed.error.message).toBe(message);
      expect(submitOrder).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  test("a JSON media type with parameters or a +json suffix is accepted", async () => {
    const { app } = harness();
    for (const type of ["application/json; charset=utf-8", "application/merge-patch+json"]) {
      expect((await post(app, "/orders/verify", verifyBody, type)).status).toBe(200);
    }
  });

  test("POST /orders/verify rejects malformed JSON and a missing Content-Type the same way", async () => {
    const { app, verifyOrder } = harness();
    for (const [body, type] of [
      ["{", "application/json"],
      [JSON.stringify(verifyBody), ""],
    ] as const) {
      const response = await post(app, "/orders/verify", body, type);
      expect(response.status).toBe(400);
      expect((await json(response, errorResponseSchema)).error.code).toBe("INVALID_REQUEST");
    }
    expect(verifyOrder).not.toHaveBeenCalled();
  });
});

describe("unknown routes", () => {
  test.each([
    ["GET", "/orders"],
    ["GET", "/nope"],
    ["DELETE", "/orders/verify"],
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

describe("default logger", () => {
  test("writes unexpected errors to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      consoleLogger.error("boom", { path: "/orders" });
      expect(spy).toHaveBeenCalledWith("boom", { path: "/orders" });
    } finally {
      spy.mockRestore();
    }
  });

  test("createApp falls back to it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = createApp({
        verifyOrder: async () => {
          throw new Error("down");
        },
        submitOrder: async () => ({ kind: "unavailable", attempts: 1 }),
      });
      expect((await post(app, "/orders/verify", verifyBody)).status).toBe(500);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});
