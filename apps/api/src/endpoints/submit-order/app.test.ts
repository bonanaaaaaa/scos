import { TransientSubmissionError, submissionKeySchema } from "@scos/core";
import { describe, expect, test } from "vitest";

import {
  orderResponseSchema,
  rejectedSubmissionResponseSchema,
  submitOrderRoute,
} from "#endpoints/submit-order/contract";
import { harness } from "#endpoints/submit-order/harness.test-support";
import { SUBMIT_ORDER_MESSAGES } from "#endpoints/submit-order/messages";
import { errorResponseSchema } from "#http/errors";
import { estimateBody } from "#http/estimate";
import { MESSAGES } from "#http/messages";
import {
  acceptedOrder,
  insufficientEstimate,
  inventory,
  json,
  post,
  shippingEstimate,
  submitBody,
  verifyBody,
} from "#testing/fixtures.test-support";

describe("POST /api/v1/orders", () => {
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
    const response = await post(app, "/api/v1/orders", submitBody);

    expect(response.status).toBe(201);
    const body = await json(response, orderResponseSchema.strict());
    expect(body).toStrictEqual(expectedOrder);
    expect(JSON.stringify(body)).not.toContain(acceptedOrder.id);
    expect(submitOrder).toHaveBeenCalledExactlyOnceWith(submitBody);
  });

  test("201 with a byte-identical body for a repeated submissionId", async () => {
    let replayed = false;
    const { app } = harness(async () => {
      const outcome = { kind: "accepted", order: acceptedOrder, replayed } as const;
      replayed = true;
      return outcome;
    });
    const first = await post(app, "/api/v1/orders", submitBody);
    const repeat = await post(app, "/api/v1/orders", submitBody);

    expect([first.status, repeat.status]).toStrictEqual([201, 201]);
    expect(await repeat.text()).toBe(await first.text());
  });

  test.each([
    ["INSUFFICIENT_STOCK", insufficientEstimate, SUBMIT_ORDER_MESSAGES.insufficientStock],
    ["SHIPPING_EXCEEDS_LIMIT", shippingEstimate, SUBMIT_ORDER_MESSAGES.shippingExceedsLimit],
  ] as const)("422 %s includes the estimate", async (reason, estimate, message) => {
    if (estimate.valid) {
      throw new Error("fixture must be a rejection");
    }
    const { app } = harness(async () => ({ kind: "rejected", reason, estimate }));
    const response = await post(app, "/api/v1/orders", submitBody);

    expect(response.status).toBe(422);
    const body = await json(response, rejectedSubmissionResponseSchema.strict());
    expect(body.error).toStrictEqual({ code: reason, message });
    // The shared estimate serializer; the root app test also compares it with
    // an actual verification response.
    expect(body.estimate).toStrictEqual(JSON.parse(JSON.stringify(estimateBody(estimate))));
  });

  test("409 for a conflicting submissionId reveals nothing about the existing Order", async () => {
    const { app } = harness(async () => ({
      kind: "conflict",
      submissionKey: submissionKeySchema.parse("order-1"),
    }));
    const response = await post(app, "/api/v1/orders", submitBody);

    expect(response.status).toBe(409);
    expect(await json(response, errorResponseSchema.strict())).toStrictEqual({
      error: { code: "SUBMISSION_ID_CONFLICT", message: SUBMIT_ORDER_MESSAGES.conflict },
    });
  });

  test("400 if the use case still reports invalid input", async () => {
    const { app } = harness(async () => ({
      kind: "invalid",
      issues: [{ code: "custom", path: ["quantity"], message: "Bad quantity", input: 1 }],
    }));
    const response = await post(app, "/api/v1/orders", submitBody);

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
    const { app } = harness(async () => ({ kind: "unavailable", attempts: 3 }));
    const response = await post(app, "/api/v1/orders", submitBody);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await json(response, errorResponseSchema)).toStrictEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: SUBMIT_ORDER_MESSAGES.unavailable },
    });
  });

  test("HTTP maps outcomes only: a thrown TransientSubmissionError is a 500", async () => {
    const { app } = harness(async () => {
      throw new TransientSubmissionError("connection timeout");
    });
    const response = await post(app, "/api/v1/orders", submitBody);
    expect(response.status).toBe(500);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test("500 when the use case throws; the message never implies acceptance", async () => {
    const { app, logger } = harness(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'orders')");
    });
    const response = await post(app, "/api/v1/orders", submitBody);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toMatch(/TypeError|undefined|orders'/);
    expect(JSON.parse(text)).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: SUBMIT_ORDER_MESSAGES.internal },
    });
    expect(SUBMIT_ORDER_MESSAGES.internal).toMatch(/could not be confirmed/);
    expect(SUBMIT_ORDER_MESSAGES.internal).toMatch(/same submissionId/);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("createSubmitOrderApp serves only its own route", () => {
  test("its route is served; every other route is a 404 NOT_FOUND envelope", async () => {
    expect(submitOrderRoute.servedBy).toBe("createSubmitOrderApp");
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
      if (path === submitOrderRoute.path) {
        expect(response.status).toBe(201);
      } else {
        expect(response.status).toBe(404);
        expect(errorResponseSchema.parse(await response.json()).error.code).toBe("NOT_FOUND");
      }
    }
  });
});
