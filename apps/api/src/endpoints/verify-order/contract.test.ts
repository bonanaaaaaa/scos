import { LATITUDE_LIMIT, LONGITUDE_LIMIT, MAX_QUANTITY } from "@scos/core";
import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { verifyOrderRequestSchema, verifyOrderRoute } from "./contract";

const verifyBody = { quantity: 10, latitude: 13.75, longitude: 100.5 };

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("verify request schema", () => {
  test("accepts a well-formed body", () => {
    expect(verifyOrderRequestSchema.parse(verifyBody)).toStrictEqual(verifyBody);
    expect(verifyOrderRoute.requestBody).toBe(verifyOrderRequestSchema);
  });

  test("quantity limits equal core's MAX_QUANTITY and require a positive integer", () => {
    const schema = verifyOrderRequestSchema;
    expect(accepts(schema, { ...verifyBody, quantity: 1 })).toBe(true);
    expect(accepts(schema, { ...verifyBody, quantity: MAX_QUANTITY })).toBe(true);
    for (const quantity of [0, -0, -1, 1.5, MAX_QUANTITY + 1, Number.NaN, Infinity, null]) {
      expect(accepts(schema, { ...verifyBody, quantity }), String(quantity)).toBe(false);
    }
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
  });

  test("numbers sent as strings are rejected, not coerced", () => {
    expect(accepts(verifyOrderRequestSchema, { ...verifyBody, quantity: "10" })).toBe(false);
    expect(accepts(verifyOrderRequestSchema, { ...verifyBody, latitude: "13.75" })).toBe(false);
  });

  test("unknown fields and missing fields are rejected", () => {
    const unknown = verifyOrderRequestSchema.safeParse({ ...verifyBody, submissionId: "x" });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues[0]?.code).toBe("unrecognized_keys");
    expect(accepts(verifyOrderRequestSchema, {})).toBe(false);
    expect(accepts(verifyOrderRequestSchema, null)).toBe(false);
    expect(accepts(verifyOrderRequestSchema, [verifyBody])).toBe(false);
  });
});
