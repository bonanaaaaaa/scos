/**
 * The process-wide bootstrap: PinoInstrumentation correlation on real Pino
 * output, resource consistency across signals, sampling, bounded flushing
 * and exporter failure. `startTelemetry` runs first in this file, before any
 * Pino logger exists, exactly as the entrypoint does.
 */

import {
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  TraceFlags,
  context,
  diag,
  trace,
} from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterAll, describe, expect, test, vi } from "vitest";

import { createVerifyOrderApp } from "../../endpoints/verify-order/app";
import { createConsoleJsonLogger } from "../../http/logger";
import { startBlackHole } from "../../testing/black-hole.test-support";
import { validEstimate, verifyBody } from "../../testing/fixtures.test-support";
import { captureLogs, parseTelemetryConfig } from "../../testing/telemetry.test-support";
import { traceVerifyOrder } from "../decorators";
import { instrumentApp } from "../http";
import {
  DEFAULT_FLUSH_TIMEOUT_MS,
  createTelemetryRuntime,
  startTelemetry,
  summarizeDiagnostic,
} from "./sdk";

const environment = {
  OTEL_SERVICE_NAME: "scos-api-test",
  SERVICE_VERSION: "9.9.9",
  DEPLOYMENT_ENVIRONMENT: "unit",
  LOG_LEVEL: "debug",
};
const resource = {
  "service.name": "scos-api-test",
  "service.version": "9.9.9",
  "deployment.environment.name": "unit",
};

const logs = captureLogs();
const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 3_600_000,
});
const runtime = startTelemetry(parseTelemetryConfig(environment), {
  spanExporter,
  metricReader,
  logDestination: logs.destination,
});

afterAll(async () => {
  await runtime.shutdown();
});

async function exportedSpans(): Promise<ReadableSpan[]> {
  await runtime.forceFlush();
  return spanExporter.getFinishedSpans();
}

function lastRecord(): Record<string, unknown> {
  const record = logs.records().at(-1);
  if (record === undefined) {
    throw new Error("no log record");
  }
  return record;
}

describe("startTelemetry", () => {
  test("is idempotent: a second call (warm reuse) returns the running runtime", () => {
    expect(startTelemetry(parseTelemetryConfig({}))).toBe(runtime);
  });

  test("registers the global tracer provider used by the runtime", () => {
    const span = trace.getTracer("probe").startSpan("probe");
    expect(span.isRecording()).toBe(true);
    span.end();
  });
});

describe("PinoInstrumentation correlation (correlation-only mode)", () => {
  test("a record inside an active span carries its trace_id, span_id and trace_flags", () => {
    const { tracer } = runtime.telemetry;
    const ids = tracer.startActiveSpan("work", (span) => {
      runtime.logger.info("inside");
      runtime.logger.child({ component: "child" }).warn("inside child");
      span.end();
      return span.spanContext();
    });

    const [inside, child] = logs.records().slice(-2);
    for (const record of [inside, child]) {
      expect(record).toMatchObject({
        trace_id: ids.traceId,
        span_id: ids.spanId,
        trace_flags: "01",
        ...resource,
      });
    }
    expect(child).toMatchObject({ component: "child", msg: "inside child" });
  });

  test("details and bindings can never override reserved fields, in either logger", () => {
    const lines: string[] = [];
    const consoleLogger = createConsoleJsonLogger({
      base: resource,
      write: (line) => lines.push(line),
    });
    const forged = {
      trace_id: "sub-123",
      span_id: "order-1",
      trace_flags: "ff",
      level: "debug",
      severity_number: 1,
      severity_text: "DEBUG",
      time: "1970-01-01T00:00:00.000Z",
      msg: "forged body",
      "service.name": "evil",
      "deployment.environment.name": "prod",
    };
    const before = logs.writes.length;
    const ids = runtime.telemetry.tracer.startActiveSpan("reserved", (span) => {
      for (const logger of [runtime.logger, consoleLogger]) {
        logger.info("real body", forged);
        logger.child(forged).warn("child body");
      }
      span.end();
      return span.spanContext();
    });

    const pinoWrites = logs.writes.slice(before);
    const raw = [...pinoWrites, ...lines];
    expect(raw).toHaveLength(4);
    for (const line of raw) {
      // Exactly one of each reserved key: no duplicate JSON keys.
      for (const key of ["level", "trace_id", "span_id", "msg", "time", "service.name"]) {
        expect(line.split(`"${key}":`).length - 1, `${key} in ${line}`).toBe(1);
      }
    }
    const records = raw.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const [index, record] of records.entries()) {
      const child = index % 2 === 1;
      expect(record).toMatchObject({
        level: child ? "warn" : "info",
        severity_number: child ? 13 : 9,
        msg: child ? "child body" : "real body",
        trace_id: ids.traceId,
        span_id: ids.spanId,
        trace_flags: "01",
        ...resource,
        "detail.trace_id": "sub-123",
        "detail.span_id": "order-1",
        "detail.level": "debug",
        "detail.msg": "forged body",
        "detail.service.name": "evil",
      });
      expect(record.time).not.toBe("1970-01-01T00:00:00.000Z");
    }
  });

  test("an unsampled but valid parent is still correlated, with trace_flags 00", () => {
    const parent = trace.wrapSpanContext({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.NONE,
    });
    context.with(trace.setSpan(ROOT_CONTEXT, parent), () => runtime.logger.info("unsampled"));
    expect(lastRecord()).toMatchObject({
      trace_id: "0af7651916cd43dd8448eb211c80319c",
      span_id: "b7ad6b7169203331",
      trace_flags: "00",
    });
  });

  test("no active span, or an invalid span context: no correlation fields at all", () => {
    runtime.logger.info("outside");
    const outside = lastRecord();
    context.with(trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(INVALID_SPAN_CONTEXT)), () =>
      runtime.logger.info("invalid"),
    );
    const invalid = lastRecord();
    for (const record of [outside, invalid]) {
      expect(record).not.toHaveProperty("trace_id");
      expect(record).not.toHaveProperty("span_id");
      expect(record).not.toHaveProperty("trace_flags");
    }
  });

  test("still one record per call, no log is sent anywhere but stdout", () => {
    const before = logs.writes.length;
    runtime.telemetry.tracer.startActiveSpan("one", (span) => {
      runtime.logger.info("single");
      span.end();
    });
    expect(logs.writes.length - before).toBe(1);
  });

  test("SDK diagnostics become summarized, uncorrelated warn records", () => {
    runtime.telemetry.tracer.startActiveSpan("request in flight", (span) => {
      diag.warn(
        JSON.stringify({
          stack:
            "Error: PeriodicExportingMetricReader: metrics export failed (error Error: connect ECONNREFUSED 127.0.0.1:4318)\n    at currentRun (file:///app/dist/server.js:1:2)",
        }),
      );
      span.end();
    });
    const record = lastRecord();
    expect(record).toMatchObject({
      level: "warn",
      msg: "OpenTelemetry SDK diagnostic",
      diagnostic:
        "Error: PeriodicExportingMetricReader: metrics export failed (error Error: connect ECONNREFUSED [address])",
    });
    expect(record).not.toHaveProperty("trace_id");
  });

  test.each([
    ["plain", "plain"],
    [
      '{"message":"export failed for https://user:pw@collector.example/v1/traces"}',
      "export failed for [url]",
    ],
    ["first line\nsecond line", "first line"],
    ["x".repeat(300), "x".repeat(200)],
    ["{not json", "{not json"],
    ['{"other":1}', '{"other":1}'],
  ])("summarizeDiagnostic(%s)", (input, expected) => {
    expect(summarizeDiagnostic(input)).toBe(expected);
  });

  test("summarizeDiagnostic ignores non-string input", () => {
    expect(summarizeDiagnostic({ secret: "x" })).toBe("");
  });
});

describe("one resource across signals", () => {
  test("spans, metrics and log records share service.name, service.version and deployment.environment.name", async () => {
    const app = instrumentApp(
      createVerifyOrderApp({
        verifyOrder: traceVerifyOrder(async () => validEstimate, runtime.telemetry),
      }),
      runtime.telemetry,
      runtime.logger,
    );
    const response = await app.request("/api/v1/orders/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyBody),
    });
    expect(response.status).toBe(200);

    const spans = await exportedSpans();
    const server = spans.find((span) => span.name === "POST /api/v1/orders/verify");
    expect(server?.resource.attributes).toMatchObject(resource);
    expect(server?.instrumentationScope).toMatchObject({
      name: "@scos/api",
      schemaUrl: "https://opentelemetry.io/schemas/1.43.0",
    });

    await metricReader.forceFlush();
    const metrics = metricExporter.getMetrics().at(-1);
    expect(metrics?.resource.attributes).toMatchObject(resource);

    const completed = logs.records().find((record) => record.msg === "request completed");
    expect(completed).toMatchObject({
      ...resource,
      trace_id: server?.spanContext().traceId,
      span_id: server?.spanContext().spanId,
    });
  });
});

describe("sampling: parent-based trace-ID ratio", () => {
  test("ratio 0 drops new root traces but honours a sampled parent", async () => {
    const exporter = new InMemorySpanExporter();
    const sampled = createTelemetryRuntime(
      parseTelemetryConfig({ OTEL_TRACES_SAMPLER_ARG: "0", LOG_LEVEL: "silent" }),
      { spanExporter: exporter },
    );
    const app = instrumentApp(
      createVerifyOrderApp({ verifyOrder: async () => validEstimate }),
      sampled.telemetry,
      sampled.logger,
    );
    const send = (headers: Record<string, string> = {}) =>
      app.request("/api/v1/orders/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(verifyBody),
      });

    expect((await send()).status).toBe(200);
    expect(
      (
        await send({
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send({
          traceparent: "00-5bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
        })
      ).status,
    ).toBe(200);
    await sampled.forceFlush();

    expect(exporter.getFinishedSpans().map((span) => span.spanContext().traceId)).toStrictEqual([
      "4bf92f3577b34da6a3ce929d0e0e4736",
    ]);
    await sampled.shutdown();
  });
});

describe("export is asynchronous, bounded and failure-tolerant", () => {
  test("an unreachable or silent collector changes no HTTP result, and flush/shutdown stay bounded", async () => {
    const blackHole = await startBlackHole();
    try {
      // Traces go to a collector that never answers; metrics to a closed port.
      const failing = createTelemetryRuntime(
        parseTelemetryConfig({
          LOG_LEVEL: "silent",
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_METRICS_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${blackHole.port}/v1/traces`,
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics",
          OTEL_EXPORTER_OTLP_TIMEOUT: "10000",
          OTEL_METRIC_EXPORT_INTERVAL: "60000",
          OTEL_METRIC_EXPORT_TIMEOUT: "10000",
        }),
      );
      const withTelemetry = instrumentApp(
        createVerifyOrderApp({
          verifyOrder: traceVerifyOrder(async () => validEstimate, failing.telemetry),
        }),
        failing.telemetry,
        failing.logger,
      );
      const without = createVerifyOrderApp({ verifyOrder: async () => validEstimate });
      const send = (app: typeof without) =>
        app.request("/api/v1/orders/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(verifyBody),
        });

      const [instrumented, plain] = await Promise.all([send(withTelemetry), send(without)]);
      expect(instrumented.status).toBe(plain.status);
      expect(await instrumented.text()).toBe(await plain.text());

      // The export would take 10 s to time out; the flush gives up after 300 ms.
      let started = Date.now();
      await failing.forceFlush(300);
      expect(Date.now() - started).toBeLessThan(2_000);

      started = Date.now();
      const first = failing.shutdown(300);
      expect(failing.shutdown(300)).toBe(first);
      await first;
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await blackHole.close();
    }
  });

  test("console exporters write spans and metrics through the console", async () => {
    const dir = vi.spyOn(console, "dir").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const consoleRuntime = createTelemetryRuntime(
        parseTelemetryConfig({
          LOG_LEVEL: "silent",
          OTEL_TRACES_EXPORTER: "console",
          OTEL_METRICS_EXPORTER: "console",
        }),
      );
      consoleRuntime.telemetry.tracer.startSpan("console-span").end();
      consoleRuntime.telemetry.submissions.add(1, { "scos.submission.outcome": "accepted" });
      await consoleRuntime.forceFlush();
      await consoleRuntime.shutdown();
      const printed = JSON.stringify([...dir.mock.calls, ...log.mock.calls]);
      expect(printed).toContain("console-span");
      expect(printed).toContain("scos.order.submissions");
    } finally {
      dir.mockRestore();
      log.mockRestore();
    }
  });

  test("OTEL_SDK_DISABLED=true: no-op telemetry, logs still written, flush and shutdown are no-ops", async () => {
    const capture = captureLogs();
    const disabled = createTelemetryRuntime(parseTelemetryConfig({ OTEL_SDK_DISABLED: "true" }), {
      logDestination: capture.destination,
    });
    expect(disabled).not.toHaveProperty("providers");
    disabled.logger.info("still logging");
    expect(capture.records()).toMatchObject([{ msg: "still logging" }]);
    await expect(disabled.forceFlush()).resolves.toBeUndefined();
    await expect(disabled.shutdown()).resolves.toBeUndefined();
  });

  test("the default flush bound is five seconds", () => {
    expect(DEFAULT_FLUSH_TIMEOUT_MS).toBe(5_000);
  });
});
