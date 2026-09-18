import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { destinationSchema } from "./destination";
import { MONEY_MAX } from "./money";
import { orderRequestSchema } from "./order-request";
import { UNIT_PRICE } from "./product";
import { MAX_QUANTITY, quantitySchema } from "./quantity";

/** The path and code of every issue, so assertions pin which field failed and why. */
const issuesOf = (result: z.ZodSafeParseResult<unknown>) =>
  result.error?.issues.map(({ path, code }) => ({ path, code })) ?? [];

describe("quantitySchema", () => {
  test("derives MAX_QUANTITY from NUMERIC(12, 2) and the unit price", () => {
    expect(MAX_QUANTITY).toBe(66_666_666);
    expect(Number.isSafeInteger(MAX_QUANTITY)).toBe(true);
    expect(UNIT_PRICE.times(MAX_QUANTITY).lessThanOrEqualTo(MONEY_MAX)).toBe(true);
    expect(UNIT_PRICE.times(MAX_QUANTITY + 1).greaterThan(MONEY_MAX)).toBe(true);
  });

  test.each([1, 24, 25, MAX_QUANTITY])("accepts %s", (value) => {
    expect(quantitySchema.safeParse(value)).toEqual({ success: true, data: value });
  });

  test.each([
    [0, "too_small"],
    [-0, "too_small"],
    [-1, "too_small"],
    [1.5, "invalid_type"],
    [Number.NaN, "invalid_type"],
    [Number.POSITIVE_INFINITY, "invalid_type"],
    [Number.NEGATIVE_INFINITY, "invalid_type"],
    [MAX_QUANTITY + 1, "too_big"],
    [Number.MAX_SAFE_INTEGER + 1, "too_big"],
    [1e21, "too_big"],
    ["5", "invalid_type"],
    [null, "invalid_type"],
    [undefined, "invalid_type"],
  ] as const)("rejects %s with %s", (value, code) => {
    const result = quantitySchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(issuesOf(result)[0]).toEqual({ path: [], code });
  });
});

describe("destinationSchema", () => {
  test.each([
    [90, 180],
    [-90, -180],
    [90, -180],
    [-90, 180],
    [0, 0],
    [13.123456789, -100.987654321],
  ])("accepts (%s, %s) and preserves precision", (latitude, longitude) => {
    const result = destinationSchema.safeParse({ latitude, longitude });
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({ latitude, longitude });
    expect(Object.isFrozen(result.data)).toBe(true);
  });

  test("keeps -0 coordinates as supplied and strips unknown keys", () => {
    const result = destinationSchema.safeParse({ latitude: -0, longitude: -0, extra: 1 });
    expect(result.success).toBe(true);
    expect(Object.is(result.data?.latitude, -0)).toBe(true);
    expect(Object.keys(result.data ?? {})).toEqual(["latitude", "longitude"]);
  });

  test.each([
    [90.000001, 0, "latitude", "too_big"],
    [-90.000001, 0, "latitude", "too_small"],
    [0, 180.000001, "longitude", "too_big"],
    [0, -180.000001, "longitude", "too_small"],
    [Number.NaN, 0, "latitude", "invalid_type"],
    [0, Number.POSITIVE_INFINITY, "longitude", "invalid_type"],
    ["1", 0, "latitude", "invalid_type"],
  ] as const)("rejects (%s, %s) on %s with %s", (latitude, longitude, field, code) => {
    const result = destinationSchema.safeParse({ latitude, longitude });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([{ path: [field], code }]);
  });

  test("reports both coordinates when both are invalid", () => {
    const result = destinationSchema.safeParse({ latitude: 91, longitude: -181 });
    expect(issuesOf(result)).toEqual([
      { path: ["latitude"], code: "too_big" },
      { path: ["longitude"], code: "too_small" },
    ]);
  });
});

describe("orderRequestSchema", () => {
  test("returns a frozen request with a frozen destination for valid input", () => {
    const result = orderRequestSchema.safeParse({ quantity: 3, latitude: 1, longitude: 2 });
    expect(result).toStrictEqual({
      success: true,
      data: { quantity: 3, destination: { latitude: 1, longitude: 2 } },
    });
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(result.data?.destination)).toBe(true);
  });

  test("collects every field error", () => {
    const result = orderRequestSchema.safeParse({ quantity: 0, latitude: 100, longitude: 200 });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([
      { path: ["quantity"], code: "too_small" },
      { path: ["latitude"], code: "too_big" },
      { path: ["longitude"], code: "too_big" },
    ]);
    expect(
      issuesOf(orderRequestSchema.safeParse({ quantity: 1, latitude: 100, longitude: 0 })),
    ).toEqual([{ path: ["latitude"], code: "too_big" }]);
    expect(
      issuesOf(orderRequestSchema.safeParse({ quantity: 0.5, latitude: 0, longitude: 0 })),
    ).toEqual([{ path: ["quantity"], code: "invalid_type" }]);
  });

  test("reports missing fields and rejects non-object input", () => {
    expect(issuesOf(orderRequestSchema.safeParse({}))).toEqual([
      { path: ["quantity"], code: "invalid_type" },
      { path: ["latitude"], code: "invalid_type" },
      { path: ["longitude"], code: "invalid_type" },
    ]);
    expect(issuesOf(orderRequestSchema.safeParse(null))).toEqual([
      { path: [], code: "invalid_type" },
    ]);
  });
});
