import { LATITUDE_LIMIT, LONGITUDE_LIMIT, MAX_QUANTITY } from "@scos/core";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  errorResponseSchema,
  orderResponseSchema,
  routes,
  submitOrderRequestSchema,
  verifyOrderRequestSchema,
} from "./contracts";

const verifyBody = { quantity: 10, latitude: 13.75, longitude: 100.5 };
const submitBody = { submissionId: "order-1", ...verifyBody };

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("request schemas", () => {
  test("accept a well-formed body", () => {
    expect(verifyOrderRequestSchema.parse(verifyBody)).toStrictEqual(verifyBody);
    expect(submitOrderRequestSchema.parse(submitBody)).toStrictEqual(submitBody);
  });

  test("quantity limits equal core's MAX_QUANTITY and require a positive integer", () => {
    for (const schema of [verifyOrderRequestSchema, submitOrderRequestSchema]) {
      const body = schema === verifyOrderRequestSchema ? verifyBody : submitBody;
      expect(accepts(schema, { ...body, quantity: 1 })).toBe(true);
      expect(accepts(schema, { ...body, quantity: MAX_QUANTITY })).toBe(true);
      for (const quantity of [0, -0, -1, 1.5, MAX_QUANTITY + 1, Number.NaN, Infinity, null]) {
        expect(accepts(schema, { ...body, quantity }), String(quantity)).toBe(false);
      }
    }
    expect(MAX_QUANTITY).toBe(66_666_666);
  });

  test("coordinate limits equal core's constants and are inclusive", () => {
    expect([LATITUDE_LIMIT, LONGITUDE_LIMIT]).toStrictEqual([90, 180]);
    for (const latitude of [-LATITUDE_LIMIT, LATITUDE_LIMIT, 0, -0]) {
      expect(accepts(verifyOrderRequestSchema, { ...verifyBody, latitude })).toBe(true);
    }
    for (const longitude of [-LONGITUDE_LIMIT, LONGITUDE_LIMIT]) {
      expect(accepts(verifyOrderRequestSchema, { ...verifyBody, longitude })).toBe(true);
    }
    const nudge = 1e-9;
    for (const latitude of [-LATITUDE_LIMIT - nudge, LATITUDE_LIMIT + nudge, Infinity]) {
      expect(accepts(verifyOrderRequestSchema, { ...verifyBody, latitude })).toBe(false);
    }
    for (const longitude of [-LONGITUDE_LIMIT - nudge, LONGITUDE_LIMIT + nudge, Number.NaN]) {
      expect(accepts(submitOrderRequestSchema, { ...submitBody, longitude })).toBe(false);
    }
  });

  test("numbers sent as strings are rejected, not coerced", () => {
    expect(accepts(verifyOrderRequestSchema, { ...verifyBody, quantity: "10" })).toBe(false);
    expect(accepts(verifyOrderRequestSchema, { ...verifyBody, latitude: "13.75" })).toBe(false);
    expect(accepts(submitOrderRequestSchema, { ...submitBody, longitude: "100.5" })).toBe(false);
    expect(accepts(submitOrderRequestSchema, { ...submitBody, submissionId: 42 })).toBe(false);
  });

  test("unknown fields and missing fields are rejected", () => {
    const unknown = verifyOrderRequestSchema.safeParse({ ...verifyBody, submissionId: "x" });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues[0]?.code).toBe("unrecognized_keys");
    expect(accepts(submitOrderRequestSchema, { ...submitBody, extra: true })).toBe(false);
    expect(accepts(submitOrderRequestSchema, verifyBody)).toBe(false);
    expect(accepts(verifyOrderRequestSchema, {})).toBe(false);
    expect(accepts(verifyOrderRequestSchema, null)).toBe(false);
    expect(accepts(verifyOrderRequestSchema, [verifyBody])).toBe(false);
  });

  test("submissionId accepts 1 to 255 characters without surrounding whitespace", () => {
    for (const submissionId of ["a", "x".repeat(255), "a b", "注文-1", "😀"]) {
      expect(accepts(submitOrderRequestSchema, { ...submitBody, submissionId }), submissionId).toBe(
        true,
      );
    }
  });

  test("submissionId rejects empty, too long, whitespace, NUL and lone surrogates", () => {
    const rejected = [
      "",
      "x".repeat(256),
      " ",
      "\t",
      "\n",
      " \t\r\n ",
      "\u00a0",
      " leading",
      "trailing ",
      "tab\t",
      "\nnewline",
      "nul\u0000byte",
      "lone\ud800surrogate",
      "\udc00",
    ];
    for (const submissionId of rejected) {
      expect(
        accepts(submitOrderRequestSchema, { ...submitBody, submissionId }),
        JSON.stringify(submissionId),
      ).toBe(false);
    }
  });
});

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
      ["post", "/orders/verify", [200, 400, 500]],
      ["post", "/orders", [201, 400, 409, 422, 500, 503]],
    ]);
    expect(routes.verifyOrder.requestBody).toBe(verifyOrderRequestSchema);
    expect(routes.submitOrder.requestBody).toBe(submitOrderRequestSchema);
  });

  test("schemas convert to draft-07 JSON Schema for offline OpenAPI generation", () => {
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
    const submit = z.toJSONSchema(submitOrderRequestSchema, { target: "draft-07" });
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
