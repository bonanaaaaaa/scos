import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { orderRequestSchema } from "#domain/ordering/order-request";

/** The path and code of every issue, so assertions pin which field failed and why. */
const issuesOf = (result: z.ZodSafeParseResult<unknown>) =>
  result.error?.issues.map(({ path, code }) => ({ path, code })) ?? [];

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
