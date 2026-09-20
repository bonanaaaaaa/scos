import { describe, expect, test } from "vitest";

import { DEFAULT_TELEMETRY_CONFIG } from "#testing/telemetry.test-support";
import { parseHealthConfig } from "#endpoints/health/config";

describe("parseHealthConfig", () => {
  test("health ignores every non-telemetry variable", () => {
    expect(parseHealthConfig({ DATABASE_URL: "garbage", PORT: "x" })).toStrictEqual({
      success: true,
      config: { telemetry: DEFAULT_TELEMETRY_CONFIG },
    });
  });

  test("health still validates the telemetry variables", () => {
    expect(parseHealthConfig({ OTEL_TRACES_EXPORTER: "zipkin" })).toStrictEqual({
      success: false,
      errors: ["OTEL_TRACES_EXPORTER: must be one of otlp, console, none"],
    });
  });
});
