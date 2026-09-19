import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { REDACTION_CENSOR } from "../telemetry/log-record";
import { createConsoleJsonLogger, defaultLogger } from "./logger";

function capture(level?: "trace" | "info" | "silent") {
  const lines: string[] = [];
  const log = createConsoleJsonLogger({
    ...(level === undefined ? {} : { level }),
    base: { "service.name": "scos-api" },
    write: (line) => lines.push(line),
  });
  return {
    log,
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createConsoleJsonLogger (runtime-neutral adapter)", () => {
  test("one JSON line per call with the contract's fields", () => {
    const { log, lines, records } = capture("trace");
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      log[level](`m-${level}`, { "http.route": "/health", text: "a\nb" });
    }
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).not.toContain("\n");
    }
    expect(records().map((record) => [record.level, record.severity_number])).toStrictEqual([
      ["trace", 1],
      ["debug", 5],
      ["info", 9],
      ["warn", 13],
      ["error", 17],
      ["fatal", 21],
    ]);
    expect(records()[2]).toStrictEqual({
      level: "info",
      severity_number: 9,
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      "service.name": "scos-api",
      "http.route": "/health",
      text: "a\nb",
      msg: "m-info",
    });
  });

  test("filters by level (info by default; silent writes nothing)", () => {
    const info = capture();
    info.log.debug("hidden");
    info.log.info("shown");
    expect(info.records().map((record) => record.msg)).toStrictEqual(["shown"]);
    const silent = capture("silent");
    silent.log.fatal("hidden");
    expect(silent.lines).toHaveLength(0);
  });

  test("redacts, sanitizes errors and keeps child bindings", () => {
    const { log, lines, records } = capture();
    log.child({ component: "c", password: "leaky" }).error("failed", {
      error: new Error("leaky SQL"),
      body: { latitude: 1 },
      headers: { authorization: "leaky" },
    });
    expect(lines.join("")).not.toContain("leaky");
    expect(records()[0]).toMatchObject({
      component: "c",
      password: REDACTION_CENSOR,
      body: REDACTION_CENSOR,
      headers: { authorization: REDACTION_CENSOR },
      error: { type: "Error" },
    });
  });

  test("correlates with a valid active span only", () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    try {
      const { log, records } = capture();
      const spanContext = {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: TraceFlags.SAMPLED,
      };
      context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), () => log.info("inside"));
      log.info("outside");
      expect(records()[0]).toMatchObject({
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: "01",
      });
      expect(records()[1]).not.toHaveProperty("trace_id");
    } finally {
      context.disable();
    }
  });

  test("defaultLogger writes through console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    defaultLogger.error("boom", { path: "/api/v1/orders" });
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({
      level: "error",
      severity_number: 17,
      msg: "boom",
      path: "/api/v1/orders",
    });
  });
});
