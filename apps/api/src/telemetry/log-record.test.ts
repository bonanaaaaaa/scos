import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import { describe, expect, test } from "vitest";

import {
  OTEL_SEVERITY_NUMBERS,
  REDACTED_KEYS,
  REDACTION_CENSOR,
  REDACT_PATHS,
  correlationFields,
  redact,
  resourceAttributes,
  sanitizeDetails,
  sanitizeError,
} from "#telemetry/log-record";

test("OTEL_SEVERITY_NUMBERS maps each Pino level to its OTel range start", () => {
  expect(OTEL_SEVERITY_NUMBERS).toStrictEqual({
    trace: 1,
    debug: 5,
    info: 9,
    warn: 13,
    error: 17,
    fatal: 21,
  });
});

describe("redaction", () => {
  test("REDACT_PATHS are every key at the top level and one level down", () => {
    expect(REDACT_PATHS).toStrictEqual(REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]));
  });

  test("redact censors listed keys at the top level and one level down only", () => {
    expect(
      redact({
        password: "p",
        body: { anything: 1 },
        headers: { authorization: "a", accept: "json" },
        nested: { deeper: { latitude: 1 }, longitude: 2 },
        list: [{ latitude: 1 }],
        kept: "k",
      }),
    ).toStrictEqual({
      password: REDACTION_CENSOR,
      body: REDACTION_CENSOR,
      headers: { authorization: REDACTION_CENSOR, accept: "json" },
      nested: { deeper: { latitude: 1 }, longitude: REDACTION_CENSOR },
      list: [{ latitude: 1 }],
      kept: "k",
    });
  });
});

describe("sanitizeDetails", () => {
  test("replaces top-level errors with type, code and frames; leaves other values", () => {
    const error = Object.assign(new Error("leaky message"), { code: "40001" });
    const safe = sanitizeDetails({ error, count: 1 });
    expect(safe).toMatchObject({ error: { type: "Error", code: "40001" }, count: 1 });
    expect(JSON.stringify(safe)).not.toContain("leaky");
    expect(sanitizeDetails(undefined)).toStrictEqual({});
  });
});

describe("correlationFields", () => {
  test("valid span context: ids and two-digit hex flags; otherwise nothing", () => {
    const spanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
    };
    expect(correlationFields(trace.setSpanContext(ROOT_CONTEXT, spanContext))).toStrictEqual({
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      trace_flags: "01",
    });
    expect(
      correlationFields(
        trace.setSpanContext(ROOT_CONTEXT, { ...spanContext, traceFlags: TraceFlags.NONE }),
      ).trace_flags,
    ).toBe("00");
    expect(correlationFields(ROOT_CONTEXT)).toStrictEqual({});
    expect(
      correlationFields(
        trace.setSpanContext(ROOT_CONTEXT, { ...spanContext, traceId: "0".repeat(32) }),
      ),
    ).toStrictEqual({});
    expect(correlationFields()).toStrictEqual(correlationFields(context.active()));
  });
});

test("resourceAttributes uses the semantic-convention keys", () => {
  expect(
    resourceAttributes({ serviceName: "s", serviceVersion: "v", deploymentEnvironment: "e" }),
  ).toStrictEqual({
    "service.name": "s",
    "service.version": "v",
    "deployment.environment.name": "e",
  });
});

describe("sanitizeError", () => {
  test.each([
    [new TypeError("secret"), { type: "TypeError" }],
    // A bare code is a safe code, never a SQLSTATE: it may be a Node errno.
    [Object.assign(new Error("x"), { code: "40001" }), { type: "Error", code: "40001" }],
    // A pg DatabaseError (it carries `severity`): its code is the SQLSTATE.
    [
      Object.assign(new Error("x"), { name: "DatabaseError", code: "40001", severity: "ERROR" }),
      { type: "DatabaseError", code: "40001", sqlState: "40001" },
    ],
    [
      Object.assign(new Error("x"), { code: "P0001", severity: "ERROR" }),
      { type: "Error", code: "P0001", sqlState: "P0001" },
    ],
    [Object.assign(new Error("x"), { code: "P2034" }), { type: "Error", code: "P2034" }],
    [Object.assign(new Error("x"), { code: "ECONNREFUSED 127.0.0.1:5432" }), { type: "Error" }],
    [Object.assign(new Error("x"), { code: 42 }), { type: "Error" }],
    [
      new Error("x", {
        cause: Object.assign(new Error("y"), { code: "55P03", severity: "ERROR" }),
      }),
      { type: "Error", code: "55P03", sqlState: "55P03" },
    ],
    [
      new Error("x", { cause: Object.assign(new Error("y"), { code: "55P03" }) }),
      { type: "Error", code: "55P03" },
    ],
    [
      Object.assign(new Error("x", { cause: { code: "57014", severity: "ERROR" } }), {
        code: "40001",
      }),
      { type: "Error", code: "57014", sqlState: "57014" },
    ],
    // PrismaPg: P2010 wrapping the driver's SQLSTATE, on the error or its cause.
    [
      Object.assign(new Error("raw query failed"), {
        code: "P2010",
        meta: {
          driverAdapterError: { cause: { originalCode: "55P03", originalMessage: "leaky" } },
        },
      }),
      { type: "Error", code: "55P03", sqlState: "55P03" },
    ],
    [
      new Error("wrapped", {
        cause: Object.assign(new Error("raw"), { code: "P2010", meta: { code: "57014" } }),
      }),
      { type: "Error", code: "57014", sqlState: "57014" },
    ],
    [
      Object.assign(new Error("raw"), { code: "P2010", meta: { code: "not; safe" } }),
      { type: "Error", code: "P2010" },
    ],
    [
      Object.assign(new Error("raw"), { code: "P2010", meta: { driverAdapterError: "x" } }),
      { type: "Error", code: "P2010" },
    ],
    [new Error("x", { cause: { code: "not safe; SQL" } }), { type: "Error" }],
    [new Error("x", { cause: "string cause" }), { type: "Error" }],
    [Object.assign(new Error("x"), { name: "has spaces; and SQL" }), { type: "Error" }],
    ["a string", { type: "string" }],
    [{ message: "plain object" }, { type: "Object" }],
    [null, { type: "object" }],
    [undefined, { type: "undefined" }],
  ])("%s", (error, expected) => {
    expect(sanitizeError(error)).toStrictEqual(expected);
  });

  test.each(["EPIPE", "EPERM"])(
    "a Node errno (%s) is a safe code but never a SQLSTATE",
    (errno) => {
      const error = Object.assign(new Error(`write ${errno}`), { code: errno, errno: -32 });
      expect(sanitizeError(error)).toStrictEqual({ type: "Error", code: errno });
      expect(sanitizeError(new Error("wrapped", { cause: error }))).toStrictEqual({
        type: "Error",
        code: errno,
      });
    },
  );
});
