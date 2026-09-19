import { createRequire } from "node:module";

import { describe, expect, test } from "vitest";

import { parseConfig, parseDatabaseConfig } from "../config";
import { parseHealthConfig } from "../endpoints/health/config";
import { DEFAULT_TELEMETRY_CONFIG } from "../testing/telemetry.test-support";
import { PACKAGE_VERSION, isOtlpEndpoint } from "./config";
import { SEMCONV_VERSION } from "./telemetry";

const databaseUrl = "postgresql://scos:secret-password@localhost:5432/scos";

/** Parses through the health runtime, which validates telemetry variables only. */
function parse(environment: Record<string, string>) {
  return parseHealthConfig(environment);
}

function telemetryOf(environment: Record<string, string>) {
  const result = parse(environment);
  if (!result.success) {
    throw new Error(result.errors.join("; "));
  }
  return result.config.telemetry;
}

describe("telemetry configuration defaults", () => {
  test("no variables: SDK enabled, nothing exported, full sampling, info logs", () => {
    expect(telemetryOf({})).toStrictEqual(DEFAULT_TELEMETRY_CONFIG);
  });

  test("every runtime parses the same telemetry variables", () => {
    const environment = { OTEL_TRACES_EXPORTER: "console", LOG_LEVEL: "debug" };
    const expected = telemetryOf(environment);
    expect(parseDatabaseConfig({ DATABASE_URL: databaseUrl, ...environment })).toMatchObject({
      success: true,
      config: { telemetry: expected },
    });
    expect(parseConfig({ DATABASE_URL: databaseUrl, ...environment })).toMatchObject({
      success: true,
      config: { telemetry: expected },
    });
  });

  test("PACKAGE_VERSION and SEMCONV_VERSION match the pinned packages", () => {
    const manifest = createRequire(import.meta.url)("../../package.json") as {
      version: string;
      dependencies: Record<string, string>;
    };
    expect(PACKAGE_VERSION).toBe(manifest.version);
    expect(SEMCONV_VERSION).toBe(manifest.dependencies["@opentelemetry/semantic-conventions"]);
  });
});

describe("valid telemetry configuration", () => {
  test("OTLP export for both signals from one base endpoint", () => {
    expect(
      telemetryOf({
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.internal:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_EXPORTER_OTLP_TIMEOUT: "2500",
        OTEL_METRIC_EXPORT_INTERVAL: "15000",
        OTEL_METRIC_EXPORT_TIMEOUT: "5000",
        OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "0.25",
        OTEL_SERVICE_NAME: "scos-api-submit",
        SERVICE_VERSION: "1.2.3-abc123",
        DEPLOYMENT_ENVIRONMENT: "staging",
        LOG_LEVEL: "warn",
      }),
    ).toStrictEqual({
      enabled: true,
      resource: {
        serviceName: "scos-api-submit",
        serviceVersion: "1.2.3-abc123",
        deploymentEnvironment: "staging",
      },
      logLevel: "warn",
      otlp: { protocol: "http/protobuf", timeoutMs: 2500 },
      traces: {
        exporter: "otlp",
        endpoint: "https://collector.internal:4318/v1/traces",
        samplerRatio: 0.25,
      },
      metrics: {
        exporter: "otlp",
        endpoint: "https://collector.internal:4318/v1/metrics",
        exportIntervalMs: 15_000,
        exportTimeoutMs: 5000,
      },
    });
  });

  test("signal-specific endpoints are used as-is and override the base", () => {
    const telemetry = telemetryOf({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://base:4318/prefix/",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:9999/custom",
    });
    expect(telemetry.traces.endpoint).toBe("http://traces:9999/custom");
    expect(telemetry.metrics.endpoint).toBe("http://base:4318/prefix/v1/metrics");
  });

  test("OTLP without any endpoint uses the local collector default", () => {
    const telemetry = telemetryOf({ OTEL_TRACES_EXPORTER: "otlp" });
    expect(telemetry.traces.endpoint).toBe("http://localhost:4318/v1/traces");
    expect(telemetry.metrics).not.toHaveProperty("endpoint");
  });

  test("sampler ratio boundaries", () => {
    for (const [value, ratio] of [
      ["0", 0],
      ["0.0", 0],
      ["1", 1],
      ["1.000000", 1],
      ["0.000001", 0.000_001],
    ] as const) {
      expect(telemetryOf({ OTEL_TRACES_SAMPLER_ARG: value }).traces.samplerRatio, value).toBe(
        ratio,
      );
    }
  });

  test("OTEL_SDK_DISABLED=true disables the SDK and skips conditional checks", () => {
    const telemetry = telemetryOf({
      OTEL_SDK_DISABLED: "true",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "not a url",
    });
    expect(telemetry.enabled).toBe(false);
  });

  test("endpoints are not validated when no OTLP exporter uses them", () => {
    expect(
      parse({ OTEL_TRACES_EXPORTER: "console", OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" }).success,
    ).toBe(true);
    // Metrics OTLP uses only its own endpoint, so an unused bad base is ignored.
    expect(
      parse({
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics",
        OTEL_EXPORTER_OTLP_ENDPOINT: "not a url",
      }).success,
    ).toBe(true);
  });

  test("a metric export timeout above the interval is fine when metrics are not exported", () => {
    expect(
      parse({ OTEL_METRIC_EXPORT_INTERVAL: "1000", OTEL_METRIC_EXPORT_TIMEOUT: "5000" }).success,
    ).toBe(true);
  });
});

describe("invalid telemetry configuration fails with sanitized messages", () => {
  test.each([
    [{ OTEL_SDK_DISABLED: "yes" }, "OTEL_SDK_DISABLED: must be one of true, false"],
    [
      { OTEL_TRACES_EXPORTER: "jaeger" },
      "OTEL_TRACES_EXPORTER: must be one of otlp, console, none",
    ],
    [{ OTEL_METRICS_EXPORTER: "" }, "OTEL_METRICS_EXPORTER: must be one of otlp, console, none"],
    [
      { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
      "OTEL_EXPORTER_OTLP_PROTOCOL: must be one of http/protobuf",
    ],
    [
      { OTEL_TRACES_SAMPLER: "always_on" },
      "OTEL_TRACES_SAMPLER: must be one of parentbased_traceidratio",
    ],
    [
      { LOG_LEVEL: "verbose" },
      "LOG_LEVEL: must be one of trace, debug, info, warn, error, fatal, silent",
    ],
  ])("%o", (environment, message) => {
    expect(parse(environment)).toStrictEqual({ success: false, errors: [message] });
  });

  test("sampler ratios outside [0, 1] or malformed are rejected", () => {
    for (const value of ["", "-0.1", "1.1", "2", "0.5x", ".5", "1e-3", "NaN", "0.1234567"]) {
      expect(parse({ OTEL_TRACES_SAMPLER_ARG: value }), value).toStrictEqual({
        success: false,
        errors: ["OTEL_TRACES_SAMPLER_ARG: must be a decimal number between 0 and 1"],
      });
    }
  });

  test("timeouts and intervals must be bounded positive integers", () => {
    for (const value of ["", "0", "-1", "1.5", "3600001", "99999999", "1e3", "abc"]) {
      for (const name of [
        "OTEL_EXPORTER_OTLP_TIMEOUT",
        "OTEL_METRIC_EXPORT_INTERVAL",
        "OTEL_METRIC_EXPORT_TIMEOUT",
      ]) {
        expect(parse({ [name]: value }), `${name}=${value}`).toStrictEqual({
          success: false,
          errors: [`${name}: must be an integer number of milliseconds between 1 and 3600000`],
        });
      }
    }
  });

  test("service identifiers are bounded and safe", () => {
    for (const value of ["", "has space", "-leading", "x".repeat(129), "semi;colon"]) {
      const result = parse({
        OTEL_SERVICE_NAME: value,
        SERVICE_VERSION: value,
        DEPLOYMENT_ENVIRONMENT: value,
      });
      expect(result.success, value).toBe(false);
      expect(result.success ? [] : result.errors.map((error) => error.split(":")[0])).toStrictEqual(
        ["OTEL_SERVICE_NAME", "SERVICE_VERSION", "DEPLOYMENT_ENVIRONMENT"],
      );
    }
  });

  test("an enabled OTLP exporter requires a valid endpoint, reported without the value", () => {
    const secret = "https://user:leaky-token@collector.example:4318";
    const result = parse({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: secret,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "ftp://leaky-host/v1/metrics",
    });
    expect(result).toStrictEqual({
      success: false,
      errors: [
        "OTEL_EXPORTER_OTLP_ENDPOINT: must be an http:// or https:// URL with a host and no credentials",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: must be an http:// or https:// URL with a host and no credentials",
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/leaky/);
  });

  test("a traces endpoint override is checked when traces use OTLP", () => {
    expect(
      parse({ OTEL_TRACES_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "collector:4318" }),
    ).toStrictEqual({
      success: false,
      errors: [
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: must be an http:// or https:// URL with a host and no credentials",
      ],
    });
  });

  test("an exported metric timeout may not exceed the export interval", () => {
    expect(
      parse({
        OTEL_METRICS_EXPORTER: "console",
        OTEL_METRIC_EXPORT_INTERVAL: "1000",
        OTEL_METRIC_EXPORT_TIMEOUT: "5000",
      }),
    ).toStrictEqual({
      success: false,
      errors: ["OTEL_METRIC_EXPORT_TIMEOUT: must not exceed OTEL_METRIC_EXPORT_INTERVAL"],
    });
  });

  test("every problem is reported at once, alongside database errors", () => {
    const result = parseConfig({
      DATABASE_URL: "mysql://u:secret-password@h/d",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "nope",
      LOG_LEVEL: "loud",
    });
    expect(result.success ? [] : result.errors.map((error) => error.split(":")[0])).toStrictEqual([
      "DATABASE_URL",
      "LOG_LEVEL",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret-password|nope|loud/);
  });
});

describe("isOtlpEndpoint", () => {
  test.each([
    ["http://localhost:4318", true],
    ["https://collector.example/otlp/v1/traces", true],
    ["http://user@collector:4318", false],
    ["http://:pass@collector:4318", false],
    ["grpc://collector:4317", false],
    ["localhost:4318", false],
    ["", false],
  ])("%s -> %s", (value, expected) => {
    expect(isOtlpEndpoint(value)).toBe(expected);
  });
});
