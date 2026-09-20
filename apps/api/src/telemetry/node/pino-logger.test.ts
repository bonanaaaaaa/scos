import { describe, expect, test } from "vitest";

import { type StructuredLogger, createConsoleJsonLogger } from "#http/logger";
import { describeLoggerContract } from "#testing/logger-contract.test-support";
import { captureLogs } from "#testing/telemetry.test-support";
import { createPinoLogger } from "#telemetry/node/pino-logger";
import { registerLogCorrelation } from "#telemetry/node/sdk";

const base = {
  "service.name": "scos-api",
  "service.version": "0.0.0",
  "deployment.environment.name": "test",
};

// The shared log record contract, with the real Node registration:
// the context manager and PinoInstrumentation, before Pino is first loaded.
describeLoggerContract("createPinoLogger (Node/Lambda)", () => {
  registerLogCorrelation();
  return {
    create: ({ level, base: fields }) => {
      const capture = captureLogs();
      return {
        logger: createPinoLogger({ level, base: fields, destination: capture.destination }),
        writes: () => capture.writes,
      };
    },
  };
});

describe("createPinoLogger specifics", () => {
  test("every record is one newline-terminated write", () => {
    const capture = captureLogs();
    const log = createPinoLogger({ level: "trace", base, destination: capture.destination });
    log.info("one", { nested: { a: 1, text: "line\nbreak" } });
    log.warn("two");
    log.child({ component: "x" }).error("three");

    expect(capture.writes).toHaveLength(3);
    for (const write of capture.writes) {
      expect(write.endsWith("\n")).toBe(true);
      expect(write.slice(0, -1)).not.toContain("\n");
    }
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
