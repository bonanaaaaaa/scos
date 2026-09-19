/**
 * Both Lambda schemas pass through the #17 extension point: a variable it
 * adds is validated by the health and the database parsers alike.
 */
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

const merged = vi.hoisted(() => [] as unknown[]);

vi.mock("./telemetry", () => ({
  withLambdaTelemetryEnvironment: (schema: z.ZodObject) => {
    merged.push(schema);
    return schema.safeExtend({
      TEST_TELEMETRY_ENDPOINT: z.string({ error: "is required" }),
    });
  },
}));

const { parseLambdaDatabaseConfig, parseLambdaHealthConfig } = await import("./config");

describe("withLambdaTelemetryEnvironment", () => {
  test("wraps both Lambda schemas", () => {
    expect(merged).toHaveLength(2);
  });

  test("a variable it adds is required by the health parser", () => {
    expect(parseLambdaHealthConfig({})).toStrictEqual({
      success: false,
      errors: ["TEST_TELEMETRY_ENDPOINT: is required"],
    });
    expect(parseLambdaHealthConfig({ TEST_TELEMETRY_ENDPOINT: "x" }).success).toBe(true);
  });

  test("a variable it adds is required by the database parser, keeping its own rules", () => {
    expect(parseLambdaDatabaseConfig({ DATABASE_AUTH_MODE: "iam" })).toStrictEqual({
      success: false,
      errors: [
        "DATABASE_URL: is required",
        "TEST_TELEMETRY_ENDPOINT: is required",
        "AWS_REGION: is required when DATABASE_AUTH_MODE is iam",
      ],
    });
    expect(
      parseLambdaDatabaseConfig({
        DATABASE_URL: "postgresql://scos@db.internal/scos",
        TEST_TELEMETRY_ENDPOINT: "x",
      }).success,
    ).toBe(true);
  });
});
