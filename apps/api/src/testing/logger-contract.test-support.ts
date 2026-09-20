/**
 * The logger port contract: the log record contract of docs/observability.md
 * ("Log record contract") as a reusable test suite. Every `StructuredLogger`
 * adapter must pass it with one call:
 *
 * ```ts
 * describeLoggerContract("my adapter", () => {
 *   registerMyRuntimeContextManager();
 *   return { create: ({ level, base }) => ({ logger: ..., writes: () => ... }) };
 * });
 * ```
 *
 * Node/Lambda runs it for `createPinoLogger` (telemetry/node/pino-logger.test.ts)
 * and the runtime-neutral `createConsoleJsonLogger` (http/logger.test.ts);
 * the Workers runtime runs it inside workerd for the same console JSON logger
 * with its own context manager (telemetry/workers/logger-contract.workers.test.ts).
 */

import {
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  type SpanContext,
  TraceFlags,
  context,
  trace,
} from "@opentelemetry/api";
import { describe, expect, test } from "vitest";

import type { LogDetails, StructuredLogger } from "#http/logger";
import { type LogLevelName, REDACTION_CENSOR } from "#telemetry/log-record";

export interface LoggerUnderTest {
  readonly logger: StructuredLogger;
  /** Every write the adapter made so far, unmodified: one per record. */
  writes(): readonly string[];
}

export interface LoggerContractHarness {
  /** A fresh logger at `level` with `base` (resource) fields on every record. */
  create(options: {
    readonly level: LogLevelName | "silent";
    readonly base: LogDetails;
  }): LoggerUnderTest;
}

/**
 * Called once, while the suite is collected and before any test runs. It
 * must register what the runtime's composition registers for logging: the
 * context manager that `context.with` uses, plus any log-correlation hook
 * (for Pino, `PinoInstrumentation` before Pino is first loaded).
 */
export type LoggerContractHarnessFactory = () => LoggerContractHarness;

export const CONTRACT_BASE = Object.freeze({
  "service.name": "scos-api-contract",
  "service.version": "1.2.3",
  "deployment.environment.name": "contract",
});

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SAMPLED: SpanContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
};

/** One record per write: a single JSON line, optionally newline-terminated. */
function parse(write: string): Record<string, unknown> {
  const line = write.endsWith("\n") ? write.slice(0, -1) : write;
  expect(line, "one record is one line").not.toContain("\n");
  return JSON.parse(line) as Record<string, unknown>;
}

function inSpan(spanContext: SpanContext, work: () => void): void {
  context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), work);
}

export function describeLoggerContract(
  name: string,
  createHarness: LoggerContractHarnessFactory,
): void {
  describe(`logger port contract: ${name}`, () => {
    const harness = createHarness();

    function open(level: LogLevelName | "silent" = "trace") {
      const under = harness.create({ level, base: CONTRACT_BASE });
      return { ...under, records: () => under.writes().map(parse) };
    }

    test("one record per call, each a single JSON line", () => {
      const { logger, writes, records } = open();
      logger.info("one", { nested: { a: 1, text: "line\nbreak" }, text: "a\nb" });
      logger.warn("two");
      logger.child({ component: "x" }).error("three");

      expect(writes()).toHaveLength(3);
      expect(records().map((record) => record.msg)).toStrictEqual(["one", "two", "three"]);
      expect(records()[0]).toMatchObject({ text: "a\nb", nested: { text: "line\nbreak" } });
    });

    test("exact fields: time, severity text and number, resource, attributes, body", () => {
      const { logger, records } = open();
      const before = Date.now();
      logger.info("order verified", { "http.route": "/api/v1/orders/verify", attempts: 2 });

      const [record] = records();
      expect(record).toStrictEqual({
        level: "info",
        severity_number: 9,
        time: expect.stringMatching(ISO_TIME),
        ...CONTRACT_BASE,
        "http.route": "/api/v1/orders/verify",
        attempts: 2,
        msg: "order verified",
      });
      const time = Date.parse(String(record?.time));
      expect(time).toBeGreaterThanOrEqual(before - 1);
      expect(time).toBeLessThanOrEqual(Date.now());
    });

    test("every level maps to its OTel severity text and number", () => {
      const { logger, records } = open();
      for (const level of LEVELS) {
        logger[level](`m-${level}`);
      }
      expect(
        records().map((record) => [record.level, record.severity_number, record.msg]),
      ).toStrictEqual([
        ["trace", 1, "m-trace"],
        ["debug", 5, "m-debug"],
        ["info", 9, "m-info"],
        ["warn", 13, "m-warn"],
        ["error", 17, "m-error"],
        ["fatal", 21, "m-fatal"],
      ]);
    });

    test("records below the configured level are not written; silent writes nothing", () => {
      const info = open("info");
      info.logger.trace("dropped");
      info.logger.debug("dropped");
      info.logger.info("i");
      info.logger.child({ component: "c" }).debug("dropped");
      expect(info.records().map((record) => record.msg)).toStrictEqual(["i"]);

      const warn = open("warn");
      warn.logger.info("dropped");
      warn.logger.warn("w");
      expect(warn.records().map((record) => record.level)).toStrictEqual(["warn"]);

      const silent = open("silent");
      for (const level of LEVELS) {
        silent.logger[level]("hidden");
      }
      silent.logger.child({ component: "c" }).fatal("hidden");
      expect(silent.writes()).toHaveLength(0);
    });

    test("the resource fields are on every record, children included", () => {
      const { logger, records } = open();
      logger.info("root");
      logger.child({ component: "a" }).child({ step: "b" }).warn("grandchild");
      for (const record of records()) {
        expect(record).toMatchObject(CONTRACT_BASE);
      }
    });

    test("child bindings are kept, nested children accumulate, the parent is unchanged", () => {
      const { logger, records } = open();
      const child = logger.child({ component: "submit" });
      child.child({ step: "commit" }).warn("nested", { attempt: 1 });
      child.info("child");
      logger.info("parent");
      expect(records()).toStrictEqual([
        {
          level: "warn",
          severity_number: 13,
          time: expect.stringMatching(ISO_TIME),
          ...CONTRACT_BASE,
          component: "submit",
          step: "commit",
          attempt: 1,
          msg: "nested",
        },
        expect.objectContaining({ component: "submit", msg: "child" }),
        expect.not.objectContaining({ component: "submit" }),
      ]);
    });

    test("sensitive keys are redacted at the top level and one level down, in details and bindings", () => {
      const { logger, writes, records } = open();
      logger.child({ password: "leaky-binding", component: "c" }).info("redaction", {
        databaseUrl: "postgresql://u:leaky-password@h/db",
        DATABASE_URL: "postgresql://u:leaky-password@h/db",
        connectionString: "leaky",
        password: "leaky-password",
        token: "leaky",
        secret: "leaky",
        body: { quantity: 1, latitude: 12.34, longitude: 56.78 },
        request: {
          latitude: 12.34,
          longitude: 56.78,
          destination: { latitude: 1 },
          token: "leaky",
        },
        headers: { authorization: "Bearer leaky", cookie: "leaky", accept: "json" },
        deeper: { nested: { latitude: 3.21 } },
        safe: "kept",
      });
      expect(writes().join("")).not.toMatch(/leaky|12\.34|56\.78/);
      expect(records()[0]).toMatchObject({
        component: "c",
        databaseUrl: REDACTION_CENSOR,
        DATABASE_URL: REDACTION_CENSOR,
        connectionString: REDACTION_CENSOR,
        password: REDACTION_CENSOR,
        token: REDACTION_CENSOR,
        secret: REDACTION_CENSOR,
        body: REDACTION_CENSOR,
        request: {
          latitude: REDACTION_CENSOR,
          longitude: REDACTION_CENSOR,
          destination: REDACTION_CENSOR,
          token: REDACTION_CENSOR,
        },
        headers: { authorization: REDACTION_CENSOR, cookie: REDACTION_CENSOR, accept: "json" },
        // Only the top level and one level down are redacted.
        deeper: { nested: { latitude: 3.21 } },
        safe: "kept",
      });
    });

    test("errors become type, safe code and stack frames: never the message", () => {
      const { logger, writes, records } = open();
      const prisma = Object.assign(new Error('insert into "order" values ($1) leaky-sql'), {
        name: "PrismaClientKnownRequestError",
        code: "P2002",
      });
      const postgres = Object.assign(new Error("leaky lock timeout on warehouse"), {
        name: "DatabaseError",
        code: "55P03",
        severity: "ERROR",
      });
      logger.error("failed", { error: prisma });
      logger.child({ cause: postgres }).error("child failed", { plain: new TypeError("leaky") });

      const [first, second] = records();
      expect(first?.error).toStrictEqual({
        type: "PrismaClientKnownRequestError",
        code: "P2002",
        stack: expect.any(Array),
      });
      expect(second?.cause).toStrictEqual({
        type: "DatabaseError",
        code: "55P03",
        sqlState: "55P03",
        stack: expect.any(Array),
      });
      expect(second?.plain).toStrictEqual({ type: "TypeError", stack: expect.any(Array) });
      const frames = (first?.error as { stack?: string[] } | undefined)?.stack ?? [];
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame).toMatch(/^at /);
      }
      expect(writes().join("")).not.toMatch(/leaky|insert into/);
    });

    test("reserved keys in details and bindings move to detail.* and never override", () => {
      const { logger, writes, records } = open();
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
        "service.version": "0",
        "deployment.environment.name": "prod",
      };
      logger.info("real body", forged);
      logger.child(forged).warn("child body");
      inSpan(SAMPLED, () => logger.error("in span", forged));

      for (const write of writes()) {
        for (const key of ["level", "trace_id", "span_id", "msg", "time", "service.name"]) {
          expect(
            write.split(`"${key}":`).length - 1,
            `one "${key}" in ${write}`,
          ).toBeLessThanOrEqual(1);
        }
      }
      const prefixed = Object.fromEntries(
        Object.entries(forged).map(([key, value]) => [`detail.${key}`, value]),
      );
      const [plain, child, correlated] = records();
      expect(plain).toStrictEqual({
        level: "info",
        severity_number: 9,
        time: expect.stringMatching(ISO_TIME),
        ...CONTRACT_BASE,
        ...prefixed,
        msg: "real body",
      });
      expect(child).toMatchObject({
        level: "warn",
        msg: "child body",
        ...CONTRACT_BASE,
        ...prefixed,
      });
      expect(child).not.toHaveProperty("trace_id");
      expect(correlated).toMatchObject({
        level: "error",
        severity_number: 17,
        msg: "in span",
        ...CONTRACT_BASE,
        trace_id: SAMPLED.traceId,
        span_id: SAMPLED.spanId,
        trace_flags: "01",
        ...prefixed,
      });
      for (const record of records()) {
        expect(record.time).not.toBe(forged.time);
      }
    });

    test("trace fields match a valid active span, for ordinary and child loggers", () => {
      const { logger, records } = open();
      const child = logger.child({ component: "c" }).child({ step: "s" });
      inSpan(SAMPLED, () => {
        logger.info("root");
        child.warn("grandchild");
      });
      for (const record of records()) {
        expect(record).toMatchObject({
          trace_id: SAMPLED.traceId,
          span_id: SAMPLED.spanId,
          trace_flags: "01",
        });
      }
    });

    test("an unsampled but valid span is correlated with trace_flags 00", () => {
      const { logger, records } = open();
      inSpan({ ...SAMPLED, traceFlags: TraceFlags.NONE }, () => logger.info("unsampled"));
      expect(records()[0]).toMatchObject({
        trace_id: SAMPLED.traceId,
        span_id: SAMPLED.spanId,
        trace_flags: "00",
      });
    });

    test("no trace fields without an active span or with an invalid span context", () => {
      const { logger, records } = open();
      logger.info("no span");
      inSpan(INVALID_SPAN_CONTEXT, () => logger.info("invalid"));
      inSpan({ ...SAMPLED, traceId: "0".repeat(32) }, () => logger.info("zero trace id"));
      inSpan({ ...SAMPLED, spanId: "0".repeat(16) }, () =>
        logger.child({ c: 1 }).info("zero span"),
      );
      expect(records()).toHaveLength(4);
      for (const record of records()) {
        expect(record).not.toHaveProperty("trace_id");
        expect(record).not.toHaveProperty("span_id");
        expect(record).not.toHaveProperty("trace_flags");
      }
    });
  });
}
