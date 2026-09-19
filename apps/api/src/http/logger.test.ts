import { afterEach, describe, expect, test, vi } from "vitest";

import { describeLoggerContract } from "../testing/logger-contract.test-support";
import { ensureContextManager } from "../telemetry/node/sdk";
import { createConsoleJsonLogger, defaultLogger } from "./logger";

// The shared log record contract. Under Node the composition registers the
// AsyncLocalStorage context manager; the Workers run of this suite
// (telemetry/workers/logger-contract.workers.test.ts) registers its own.
describeLoggerContract("createConsoleJsonLogger (runtime-neutral)", () => {
  ensureContextManager();
  return {
    create: ({ level, base }) => {
      const lines: string[] = [];
      return {
        logger: createConsoleJsonLogger({ level, base, write: (line) => lines.push(line) }),
        writes: () => lines,
      };
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createConsoleJsonLogger specifics", () => {
  test("writes without a trailing newline and defaults to info with no base fields", () => {
    const lines: string[] = [];
    const log = createConsoleJsonLogger({ write: (line) => lines.push(line) });
    log.debug("hidden");
    log.info("shown");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(false);
    expect(JSON.parse(lines[0] ?? "")).toStrictEqual({
      level: "info",
      severity_number: 9,
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      msg: "shown",
    });
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
