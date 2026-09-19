import { LONGITUDE_LIMIT, MAX_QUANTITY } from "@scos/core";
import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { submitOrderRequestSchema, submitOrderRoute } from "./contract";

const verifyBody = { quantity: 10, latitude: 13.75, longitude: 100.5 };
const submitBody = { submissionId: "order-1", ...verifyBody };

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("submit request schema", () => {
  test("accepts a well-formed body", () => {
    expect(submitOrderRequestSchema.parse(submitBody)).toStrictEqual(submitBody);
    expect(submitOrderRoute.requestBody).toBe(submitOrderRequestSchema);
  });

  test("quantity limits equal core's MAX_QUANTITY and require a positive integer", () => {
    const schema = submitOrderRequestSchema;
    expect(accepts(schema, { ...submitBody, quantity: 1 })).toBe(true);
    expect(accepts(schema, { ...submitBody, quantity: MAX_QUANTITY })).toBe(true);
    for (const quantity of [0, -0, -1, 1.5, MAX_QUANTITY + 1, Number.NaN, Infinity, null]) {
      expect(accepts(schema, { ...submitBody, quantity }), String(quantity)).toBe(false);
    }
  });

  test("longitude limits equal core's constant", () => {
    const nudge = 1e-9;
    for (const longitude of [-LONGITUDE_LIMIT - nudge, LONGITUDE_LIMIT + nudge, Number.NaN]) {
      expect(accepts(submitOrderRequestSchema, { ...submitBody, longitude })).toBe(false);
    }
  });

  test("numbers sent as strings are rejected, not coerced", () => {
    expect(accepts(submitOrderRequestSchema, { ...submitBody, longitude: "100.5" })).toBe(false);
    expect(accepts(submitOrderRequestSchema, { ...submitBody, submissionId: 42 })).toBe(false);
  });

  test("unknown fields and missing fields are rejected", () => {
    expect(accepts(submitOrderRequestSchema, { ...submitBody, extra: true })).toBe(false);
    expect(accepts(submitOrderRequestSchema, verifyBody)).toBe(false);
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
