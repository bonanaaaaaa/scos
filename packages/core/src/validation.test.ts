import { describe, expect, test } from "vitest";

import { parseDestination } from "./destination.js";
import { MONEY_MAX } from "./money.js";
import { parseOrderRequest } from "./order-request.js";
import { UNIT_PRICE } from "./product.js";
import { MAX_QUANTITY, parseQuantity } from "./quantity.js";

describe("parseQuantity", () => {
  test("derives MAX_QUANTITY from NUMERIC(12, 2) and the unit price", () => {
    expect(MAX_QUANTITY).toBe(66_666_666);
    expect(UNIT_PRICE.times(MAX_QUANTITY).lessThanOrEqualTo(MONEY_MAX)).toBe(true);
    expect(UNIT_PRICE.times(MAX_QUANTITY + 1).greaterThan(MONEY_MAX)).toBe(true);
  });

  test.each([1, 24, 25, MAX_QUANTITY])("accepts %s", (value) => {
    expect(parseQuantity(value)).toEqual({ ok: true, value });
  });

  test.each([
    [0, "NOT_POSITIVE"],
    [-0, "NOT_POSITIVE"],
    [-1, "NOT_POSITIVE"],
    [1.5, "NOT_INTEGER"],
    [Number.NaN, "NOT_FINITE"],
    [Number.POSITIVE_INFINITY, "NOT_FINITE"],
    [Number.NEGATIVE_INFINITY, "NOT_FINITE"],
    [MAX_QUANTITY + 1, "OUT_OF_RANGE"],
    [Number.MAX_SAFE_INTEGER + 1, "OUT_OF_RANGE"],
    [1e21, "OUT_OF_RANGE"],
    ["5", "NOT_A_NUMBER"],
    [null, "NOT_A_NUMBER"],
    [undefined, "NOT_A_NUMBER"],
  ] as const)("rejects %s with %s", (value, code) => {
    const result = parseQuantity(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ field: "quantity", code });
    }
  });
});

describe("parseDestination", () => {
  test.each([
    [90, 180],
    [-90, -180],
    [90, -180],
    [-90, 180],
    [0, 0],
    [13.123456789, -100.987654321],
  ])("accepts (%s, %s) and preserves precision", (latitude, longitude) => {
    const result = parseDestination(latitude, longitude);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ latitude, longitude });
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  test.each([
    [90.000001, 0, "latitude", "OUT_OF_RANGE"],
    [-90.000001, 0, "latitude", "OUT_OF_RANGE"],
    [0, 180.000001, "longitude", "OUT_OF_RANGE"],
    [0, -180.000001, "longitude", "OUT_OF_RANGE"],
    [Number.NaN, 0, "latitude", "NOT_FINITE"],
    [0, Number.POSITIVE_INFINITY, "longitude", "NOT_FINITE"],
    ["1", 0, "latitude", "NOT_A_NUMBER"],
  ] as const)("rejects (%s, %s) on %s with %s", (latitude, longitude, field, code) => {
    const result = parseDestination(latitude, longitude);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual([expect.objectContaining({ field, code })]);
    }
  });

  test("reports both coordinates when both are invalid", () => {
    const result = parseDestination(91, -181);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.map((error) => error.field)).toEqual(["latitude", "longitude"]);
    }
  });
});

describe("parseOrderRequest", () => {
  test("returns a request for valid input", () => {
    expect(parseOrderRequest({ quantity: 3, latitude: 1, longitude: 2 })).toEqual({
      ok: true,
      value: { quantity: 3, destination: { latitude: 1, longitude: 2 } },
    });
  });

  test("collects every field error", () => {
    const result = parseOrderRequest({ quantity: 0, latitude: 100, longitude: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.map((error) => error.field)).toEqual([
        "quantity",
        "latitude",
        "longitude",
      ]);
    }
    const quantityOnly = parseOrderRequest({ quantity: 1, latitude: 100, longitude: 0 });
    expect(quantityOnly.ok).toBe(false);
    const destinationOnly = parseOrderRequest({ quantity: 0.5, latitude: 0, longitude: 0 });
    expect(destinationOnly).toMatchObject({ ok: false, error: [{ field: "quantity" }] });
  });
});
