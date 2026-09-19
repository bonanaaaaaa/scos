import { describe, expect, test } from "vitest";

import { captureLogs } from "../../testing/telemetry.test-support";
import { OTEL_SEVERITY_NUMBERS, REDACTION_CENSOR } from "../log-record";
import { type StructuredLogger, createConsoleJsonLogger } from "../../http/logger";
import { createPinoLogger } from "./pino-logger";

const base = {
  "service.name": "scos-api",
  "service.version": "0.0.0",
  "deployment.environment.name": "test",
};

function logger(level: "trace" | "info" = "trace") {
  const capture = captureLogs();
  return { capture, log: createPinoLogger({ level, base, destination: capture.destination }) };
}

describe("Pino JSON records", () => {
  test("fields map to the OTel LogRecord model: time, severity text/number, body, attributes, resource", () => {
    const { capture, log } = logger();
    const before = Date.now();

    log.info("order verified", { "http.route": "/api/v1/orders/verify", attempts: 2 });

    const [record] = capture.records();
    expect(record).toStrictEqual({
      level: "info",
      severity_number: 9,
      time: expect.any(String),
      ...base,
      "http.route": "/api/v1/orders/verify",
      attempts: 2,
      msg: "order verified",
    });
    // ISO 8601 UTC with milliseconds, within this test's run.
    const time = String(record?.time);
    expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(time)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(time)).toBeLessThanOrEqual(Date.now());
  });

  test("every Pino level maps to its OTel severity text and number", () => {
    const { capture, log } = logger();
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      log[level]("x");
    }
    expect(capture.records().map((record) => [record.level, record.severity_number])).toStrictEqual(
      [
        ["trace", 1],
        ["debug", 5],
        ["info", 9],
        ["warn", 13],
        ["error", 17],
        ["fatal", 21],
      ],
    );
    expect(OTEL_SEVERITY_NUMBERS).toStrictEqual({
      trace: 1,
      debug: 5,
      info: 9,
      warn: 13,
      error: 17,
      fatal: 21,
    });
  });

  test("below the configured level nothing is written", () => {
    const { capture, log } = logger("info");
    log.trace("dropped");
    log.debug("dropped");
    log.info("i");
    expect(capture.records().map((record) => record.msg)).toStrictEqual(["i"]);
  });

  test("exactly one output record (one newline-terminated write) per call", () => {
    const { capture, log } = logger();
    log.info("one", { nested: { a: 1, text: "line\nbreak" } });
    log.warn("two");
    log.child({ component: "x" }).error("three");

    expect(capture.writes).toHaveLength(3);
    for (const write of capture.writes) {
      expect(write.endsWith("\n")).toBe(true);
      expect(write.slice(0, -1)).not.toContain("\n");
    }
    expect(capture.records().map((record) => record.msg)).toStrictEqual(["one", "two", "three"]);
  });

  test("child loggers keep the base (resource) fields and add their bindings", () => {
    const { capture, log } = logger();
    const child = log.child({ component: "submit" });
    child.child({ step: "commit" }).warn("nested");
    expect(capture.records()).toStrictEqual([
      expect.objectContaining({ ...base, component: "submit", step: "commit", msg: "nested" }),
    ]);
  });

  test("sensitive keys are redacted at the top level, one level down and in headers", () => {
    const { capture, log } = logger();
    log.info("redaction", {
      databaseUrl: "postgresql://u:leaky-password@h/db",
      password: "leaky-password",
      body: { quantity: 1, latitude: 12.34, longitude: 56.78 },
      request: { latitude: 12.34, longitude: 56.78, destination: { latitude: 1 }, token: "leaky" },
      headers: { authorization: "Bearer leaky", cookie: "leaky" },
      safe: "kept",
    });
    const text = capture.writes.join("");
    expect(text).not.toMatch(/leaky|12\.34|56\.78/);
    expect(capture.records()[0]).toMatchObject({
      databaseUrl: REDACTION_CENSOR,
      password: REDACTION_CENSOR,
      body: REDACTION_CENSOR,
      request: {
        latitude: REDACTION_CENSOR,
        longitude: REDACTION_CENSOR,
        destination: REDACTION_CENSOR,
        token: REDACTION_CENSOR,
      },
      headers: { authorization: REDACTION_CENSOR, cookie: REDACTION_CENSOR },
      safe: "kept",
    });
  });

  test("errors are logged as class name, safe code and stack frames: never the message", () => {
    const { capture, log } = logger();
    const error = Object.assign(new Error('insert into "order" values ($1) leaky-sql'), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    log.error("failed", { error });
    const [record] = capture.records();
    expect(record?.error).toMatchObject({ type: "PrismaClientKnownRequestError", code: "P2002" });
    const frames = (record?.error as { stack: string[] } | undefined)?.stack ?? [];
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).toMatch(/^at /);
    }
    expect(capture.writes.join("")).not.toContain("leaky-sql");
  });

  test("records carry no trace fields when no span is active (instrumentation not registered)", () => {
    const { capture, log } = logger();
    log.info("uncorrelated");
    expect(capture.records()[0]).not.toHaveProperty("trace_id");
    expect(capture.records()[0]).not.toHaveProperty("span_id");
    expect(capture.records()[0]).not.toHaveProperty("trace_flags");
  });

  test("defaults: info level, no base fields beyond Pino's", () => {
    const capture = captureLogs();
    const log = createPinoLogger({ destination: capture.destination });
    log.debug("hidden");
    log.info("shown");
    expect(capture.records()).toStrictEqual([
      { level: "info", severity_number: 9, time: expect.any(String), msg: "shown" },
    ]);
  });
});

describe("the log record contract is the same for every adapter", () => {
  test("Pino and the console JSON logger write the same fields for the same calls", () => {
    const pinoCapture = captureLogs();
    const pino = createPinoLogger({ level: "trace", base, destination: pinoCapture.destination });
    const lines: string[] = [];
    const console = createConsoleJsonLogger({
      level: "trace",
      base,
      write: (line) => lines.push(line),
    });
    const calls = (log: StructuredLogger) => {
      log.info("plain", { attempts: 2, "http.route": "/health" });
      log.error("failed", { error: new TypeError("leaky"), body: { quantity: 1 } });
      log
        .child({ component: "submit", headers: { cookie: "leaky" } })
        .warn("child", { token: "t" });
      log.fatal("fatal");
      log
        .child({ level: "trace" })
        .info("reserved", { trace_id: "sub-1", level: "debug", "service.version": "x" });
    };
    calls(pino);
    calls(console);

    const withoutTime = (record: Record<string, unknown>) => {
      const { time, ...rest } = record;
      expect(typeof time).toBe("string");
      return rest;
    };
    const fromPino = pinoCapture.records().map(withoutTime);
    const fromConsole = lines.map((line) =>
      withoutTime(JSON.parse(line) as Record<string, unknown>),
    );
    // Stack frames differ by call site; compare everything else.
    const strip = (records: Record<string, unknown>[]) =>
      records.map((record) =>
        typeof record.error === "object" && record.error !== null
          ? { ...record, error: { ...(record.error as object), stack: "frames" } }
          : record,
      );
    expect(strip(fromConsole)).toStrictEqual(strip(fromPino));
    expect(JSON.stringify([fromPino, fromConsole])).not.toContain("leaky");
    // Reserved keys from details and bindings are prefixed, never duplicated.
    expect(fromPino.at(-1)).toStrictEqual({
      level: "info",
      severity_number: 9,
      ...base,
      "detail.level": "debug",
      "detail.trace_id": "sub-1",
      "detail.service.version": "x",
      msg: "reserved",
    });
    expect(pinoCapture.writes.at(-1)?.split('"level":').length).toBe(2);
  });
});
