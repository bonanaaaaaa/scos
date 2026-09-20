import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { MONEY_MAX } from "#domain/shared/money";
import { UNIT_PRICE } from "#domain/shared/product";
import { MAX_QUANTITY, quantitySchema } from "#domain/shared/quantity";

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
