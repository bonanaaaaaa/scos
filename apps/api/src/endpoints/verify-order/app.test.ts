import {
  type OrderEstimate,
  type OrderRequest,
  TransientSubmissionError,
  type VerifyOrder,
  orderRequestSchema,
} from "@scos/core";
import { describe, expect, test, vi } from "vitest";

import { errorResponseSchema } from "#http/errors";
import { MESSAGES } from "#http/messages";
import {
  fakeLogger,
  insufficientEstimate,
  inventory,
  json,
  post,
  shippingEstimate,
  submitBody,
  validEstimate,
  verifyBody,
} from "#testing/fixtures.test-support";
import { createVerifyOrderApp } from "#endpoints/verify-order/app";
import { verifyOrderResponseSchema, verifyOrderRoute } from "#endpoints/verify-order/contract";

function harness(
  verify: (request: OrderRequest) => Promise<OrderEstimate> = async () => validEstimate,
) {
  const verifyOrder = vi.fn<VerifyOrder>(verify);
  const logger = fakeLogger();
  return { app: createVerifyOrderApp({ verifyOrder, logger }), verifyOrder, logger };
}

describe("POST /api/v1/orders/verify", () => {
  test("200 with a valid estimate, money as decimal strings", async () => {
    const { app, verifyOrder } = harness();
    const response = await post(app, "/api/v1/orders/verify", verifyBody);

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
    const { app } = harness(async () => shippingEstimate);
    const response = await post(app, "/api/v1/orders/verify", {
      quantity: 1,
      latitude: 90,
      longitude: 0,
    });

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
    const { app } = harness(async () => insufficientEstimate);
    const response = await post(app, "/api/v1/orders/verify", {
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
    const response = await post(app, "/api/v1/orders/verify", {
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

  test("HTTP maps outcomes only: a thrown TransientSubmissionError is a 500", async () => {
    const { app } = harness(async () => {
      throw new TransientSubmissionError("connection timeout");
    });
    const response = await post(app, "/api/v1/orders/verify", verifyBody);
    expect(response.status).toBe(500);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test("500 when the use case throws, without exposing internals", async () => {
    const { app, logger } = harness(async () => {
      throw new Error("connect ECONNREFUSED postgresql://user:secret@db/scos");
    });
    const response = await post(app, "/api/v1/orders/verify", verifyBody);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toMatch(/ECONNREFUSED|secret|postgresql|stack/i);
    expect(errorResponseSchema.parse(JSON.parse(text))).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: MESSAGES.internal },
    });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[1]).toStrictEqual({
      "http.request.method": "POST",
      "url.path": "/api/v1/orders/verify",
      "http.route": "/api/v1/orders/verify",
      error: expect.any(Error),
    });
  });
});

describe("request validation before the use case", () => {
  test("a JSON media type with parameters or a +json suffix is accepted", async () => {
    const { app } = harness();
    for (const type of ["application/json; charset=utf-8", "application/merge-patch+json"]) {
      expect((await post(app, "/api/v1/orders/verify", verifyBody, type)).status).toBe(200);
    }
  });

  test("POST /api/v1/orders/verify rejects malformed JSON and a missing Content-Type the same way", async () => {
    const { app, verifyOrder } = harness();
    for (const [body, type] of [
      ["{", "application/json"],
      [JSON.stringify(verifyBody), ""],
    ] as const) {
      const response = await post(app, "/api/v1/orders/verify", body, type);
      expect(response.status).toBe(400);
      expect((await json(response, errorResponseSchema)).error.code).toBe("INVALID_REQUEST");
    }
    expect(verifyOrder).not.toHaveBeenCalled();
  });
});

describe("createVerifyOrderApp serves only its own route", () => {
  test("its route is served; every other route is a 404 NOT_FOUND envelope", async () => {
    expect(verifyOrderRoute.servedBy).toBe("createVerifyOrderApp");
    const { app } = harness();
    const requests = [
      ["GET", "/health", undefined],
      ["POST", "/api/v1/orders/verify", verifyBody],
      ["POST", "/api/v1/orders", submitBody],
    ] as const;
    for (const [method, path, body] of requests) {
      const response = await app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (path === verifyOrderRoute.path) {
        expect(response.status).toBe(200);
      } else {
        expect(response.status).toBe(404);
        expect(errorResponseSchema.parse(await response.json()).error.code).toBe("NOT_FOUND");
      }
    }
  });
});
