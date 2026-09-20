import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { destinationSchema } from "./destination";

/** The path and code of every issue, so assertions pin which field failed and why. */
const issuesOf = (result: z.ZodSafeParseResult<unknown>) =>
  result.error?.issues.map(({ path, code }) => ({ path, code })) ?? [];

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
