import { MAX_QUANTITY } from "@scos/core";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { orderResponseSchema } from "#endpoints/submit-order/contract";
import { submitOrderRequestSchema } from "#endpoints/submit-order/contract";
import { verifyOrderRequestSchema } from "#endpoints/verify-order/contract";
import { errorResponseSchema } from "#http/errors";

import { routes } from "./routes";

describe("response contract", () => {
  test("the route table lists every endpoint with its statuses", () => {
    expect(
      Object.values(routes).map((route) => [
        route.method,
        route.path,
        Object.keys(route.responses).map(Number),
      ]),
    ).toStrictEqual([
      ["get", "/health", [200]],
      ["post", "/api/v1/orders/verify", [200, 400, 500]],
      ["post", "/api/v1/orders", [201, 400, 409, 422, 500, 503]],
    ]);
    expect(routes.verifyOrder.requestBody).toBe(verifyOrderRequestSchema);
    expect(routes.submitOrder.requestBody).toBe(submitOrderRequestSchema);
  });

  test("schemas convert to draft-07 JSON Schema for OpenAPI generation", () => {
    for (const schema of [
      verifyOrderRequestSchema,
      submitOrderRequestSchema,
      orderResponseSchema,
      errorResponseSchema,
      ...Object.values(routes).flatMap((route) =>
        Object.values(route.responses).map((response) => response.schema),
      ),
    ]) {
      expect(() => z.toJSONSchema(schema, { target: "draft-07", io: "input" })).not.toThrow();
    }
    // An empty metadata registry inlines the named components (`.meta({ id })`).
    const submit = z.toJSONSchema(submitOrderRequestSchema, {
      target: "draft-07",
      metadata: z.registry(),
    });
    expect(submit).toMatchObject({
      additionalProperties: false,
      required: ["submissionId", "quantity", "latitude", "longitude"],
      properties: {
        submissionId: { type: "string", minLength: 1, maxLength: 255 },
        quantity: { type: "integer", exclusiveMinimum: 0, maximum: MAX_QUANTITY },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
      },
    });
  });
});
