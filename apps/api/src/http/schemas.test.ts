import { LATITUDE_LIMIT, LONGITUDE_LIMIT, MAX_QUANTITY } from "@scos/core";
import { describe, expect, test } from "vitest";

import { latitudeFieldSchema, longitudeFieldSchema, quantityFieldSchema } from "#http/schemas";

describe("shared request field schemas", () => {
  test("limits equal core's constants", () => {
    expect(MAX_QUANTITY).toBe(66_666_666);
    expect(quantityFieldSchema.safeParse(MAX_QUANTITY).success).toBe(true);
    expect(quantityFieldSchema.safeParse(MAX_QUANTITY + 1).success).toBe(false);
    for (const [schema, limit] of [
      [latitudeFieldSchema, LATITUDE_LIMIT],
      [longitudeFieldSchema, LONGITUDE_LIMIT],
    ] as const) {
      expect(schema.safeParse(limit).success).toBe(true);
      expect(schema.safeParse(-limit).success).toBe(true);
      expect(schema.safeParse(limit + 1e-9).success).toBe(false);
      expect(schema.safeParse(-limit - 1e-9).success).toBe(false);
    }
  });
});
