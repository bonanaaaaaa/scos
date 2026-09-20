/**
 * Workers telemetry specifics, inside workerd: OTLP export over `fetch` per
 * flush (never on the response path), DELTA metric values, exporter failure,
 * the bounded span buffer, sampling, the disabled SDK, and the `console.log`
 * logger's field mapping and redaction. The shared behaviour is in the
 * contract suites (telemetry-contract / logger-contract .workers.test.ts).
 */

import { ROOT_CONTEXT, SpanKind, context, trace } from "@opentelemetry/api";
import { type DataPoint, type Histogram, type MetricData } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createApp } from "#app";
import { composeHealthApplication } from "#endpoints/health/composition";
import { traceSubmitOrder } from "#telemetry/decorators/submit-order";
import { traceVerifyOrder } from "#telemetry/decorators/verify-order";
import { instrumentApp } from "#telemetry/http";
import { SUBMISSIONS_METRIC } from "#telemetry/telemetry";
import { failureReason, postOtlp } from "#telemetry/workers/otlp-exporter";
import {
  RequestFlushSpanProcessor,
  WORKERS_SPAN_LIMITS,
  createWorkersTelemetry,
} from "#telemetry/workers/sdk";
import {
  acceptedOrder,
  fakeLogger,
  post,
  submitBody,
  validEstimate,
} from "#testing/fixtures.test-support";
import {
  accumulateDeltas,
  workerTelemetryConfig,
  workersTestTelemetry,
} from "#testing/workers-telemetry.test-support";

const DURATION = "http.server.request.duration";
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const OTLP = {
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test:4318",
  OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20collector-secret,x-tenant=scos",
  OTEL_EXPORTER_OTLP_TIMEOUT: "200",
};

interface Posted {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/** A `fetch` that records OTLP requests and answers with `respond`. */
function recordingFetch(respond: () => Promise<Response> = async () => new Response(null)) {
  const posted: Posted[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: new Uint8Array(init?.body as ArrayBuffer),
    });
    return respond();
  });
  return { fetch: fake as unknown as typeof fetch, posted };
}

function pointsOf<Value = number>(metrics: readonly MetricData[], name: string) {
  return (metrics.find((metric) => metric.descriptor.name === name)?.dataPoints ??
    []) as DataPoint<Value>[];
}

function records(lines: readonly string[]) {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OTLP export over fetch", () => {
  test("one protobuf POST per signal per flush, with the secret headers, never on the response path", async () => {
    const recorder = recordingFetch();
    const runtime = createWorkersTelemetry(
      workerTelemetryConfig({ ...OTLP, LOG_LEVEL: "silent" }),
      {
        fetch: recorder.fetch,
      },
    );
    const { app } = composeHealthApplication({
      telemetry: runtime.telemetry,
      logger: fakeLogger(),
    });

    expect((await app.request("/health")).status).toBe(200);
    expect(recorder.posted, "nothing is exported while the request is answered").toHaveLength(0);

    await runtime.flush();
    expect(recorder.posted.map((request) => request.url)).toStrictEqual([
      "http://collector.test:4318/v1/traces",
      "http://collector.test:4318/v1/metrics",
    ]);
    for (const request of recorder.posted) {
      expect(request.headers.get("content-type")).toBe("application/x-protobuf");
      expect(request.headers.get("authorization")).toBe("Bearer collector-secret");
      expect(request.headers.get("x-tenant")).toBe("scos");
      expect(request.body.byteLength).toBeGreaterThan(0);
    }
    const [traces, metrics] = recorder.posted.map((request) =>
      new TextDecoder().decode(request.body),
    );
    expect(traces).toContain("GET /health");
    expect(traces).toContain("scos-api");
    expect(metrics).toContain(DURATION);

    await runtime.flush();
    expect(recorder.posted, "an idle flush sends nothing").toHaveLength(2);

    await app.request("/health");
    await runtime.flush();
    expect(recorder.posted).toHaveLength(4);
  });

  test("signal-specific endpoints are used as-is", async () => {
    const recorder = recordingFetch();
    const runtime = createWorkersTelemetry(
      workerTelemetryConfig({
        ...OTLP,
        LOG_LEVEL: "silent",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.test/custom",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.test/custom",
      }),
      { fetch: recorder.fetch },
    );
    await composeHealthApplication({ telemetry: runtime.telemetry }).app.request("/health");
    await runtime.flush();
    expect(recorder.posted.map((request) => request.url)).toStrictEqual([
      "https://traces.test/custom",
      "https://metrics.test/custom",
    ]);
  });

  test("the console exporters print instead of posting", async () => {
    const recorder = recordingFetch();
    const dir = vi.spyOn(console, "dir").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runtime = createWorkersTelemetry(
      workerTelemetryConfig({
        OTEL_TRACES_EXPORTER: "console",
        OTEL_METRICS_EXPORTER: "console",
        LOG_LEVEL: "silent",
      }),
      { fetch: recorder.fetch },
    );
    await composeHealthApplication({ telemetry: runtime.telemetry }).app.request("/health");
    await runtime.flush();
    expect(recorder.posted).toHaveLength(0);
    expect(dir.mock.calls.length + log.mock.calls.length).toBeGreaterThan(0);
  });

  test("postOtlp reports a missing body and never rejects", async () => {
    const onFailure = vi.fn();
    const recorder = recordingFetch();
    await expect(
      postOtlp("traces", undefined, {
        url: "http://collector.test/v1/traces",
        headers: {},
        timeoutMs: 100,
        onFailure,
        fetch: recorder.fetch,
      }),
    ).resolves.toStrictEqual({ code: 1 });
    expect(onFailure).toHaveBeenCalledWith("traces", "serialization failed");
    expect(recorder.posted).toHaveLength(0);
  });

  test("failure reasons are only error classes or statuses", () => {
    expect(failureReason(new DOMException("aborted", "TimeoutError"))).toBe("timeout");
    expect(failureReason(new DOMException("aborted", "AbortError"))).toBe("timeout");
    expect(failureReason(new TypeError("connect ECONNREFUSED 10.0.0.1:4318"))).toBe("TypeError");
    expect(failureReason("http://user:secret@collector")).toBe("unknown error");
  });
});

describe("metric values", () => {
  test("DELTA: each flush exports only what was recorded since the previous one", async () => {
    const harness = workersTestTelemetry({ LOG_LEVEL: "silent" });
    const { app } = composeHealthApplication({ telemetry: harness.runtime.telemetry });
    for (let index = 0; index < 3; index += 1) {
      expect((await app.request("/health")).status).toBe(200);
    }
    await harness.runtime.flush();
    await app.request("/health");
    await harness.runtime.flush();
    await harness.runtime.flush();

    const counts = harness
      .exports()
      .map((metrics) => pointsOf<Histogram>(metrics, DURATION).map((point) => point.value.count));
    expect(counts, "two exports; the idle flush sent nothing").toStrictEqual([[3], [1]]);
    const [total] = pointsOf<Histogram>(accumulateDeltas(harness.exports().flat()), DURATION);
    expect(total?.value.count).toBe(4);
    expect(total?.attributes).toStrictEqual({
      "http.request.method": "GET",
      "url.scheme": "http",
      "http.response.status_code": 200,
      "http.route": "/health",
    });
  });

  test("scos.order.submissions counts completed submissions, replays included", async () => {
    const harness = workersTestTelemetry({ LOG_LEVEL: "silent" });
    const { telemetry } = harness.runtime;
    const outcomes = [false, true, true];
    const logger = fakeLogger();
    const app = instrumentApp(
      createApp({
        verifyOrder: traceVerifyOrder(async () => validEstimate, telemetry),
        submitOrder: traceSubmitOrder(
          async () => ({
            kind: "accepted",
            order: acceptedOrder,
            replayed: outcomes.shift() ?? false,
          }),
          telemetry,
        ),
        logger,
      }),
      telemetry,
      logger,
    );
    for (let index = 0; index < 3; index += 1) {
      expect((await post(app, "/api/v1/orders", submitBody)).status).toBe(201);
    }
    expect((await post(app, "/api/v1/orders", { quantity: "x" })).status).toBe(400);

    const points = pointsOf(await harness.metrics(), SUBMISSIONS_METRIC);
    expect(points.map((point) => [point.attributes, point.value])).toStrictEqual([
      [{ "scos.submission.outcome": "accepted", "scos.submission.replayed": false }, 1],
      [{ "scos.submission.outcome": "accepted", "scos.submission.replayed": true }, 2],
    ]);
  });
});

describe("exporter failure", () => {
  test.each([
    [
      "a refused connection",
      async () => Promise.reject(new TypeError("connect ECONNREFUSED")),
      "TypeError",
    ],
    ["a 503 from the collector", async () => new Response("down", { status: 503 }), "HTTP 503"],
    ["a collector that never answers", () => new Promise<Response>(() => undefined), "timeout"],
  ] as const)(
    "%s: responses unchanged, flush bounded, one sanitized warning per signal",
    async (_name, respond, reason) => {
      const lines: string[] = [];
      const hanging = recordingFetch(respond);
      const runtime = createWorkersTelemetry(workerTelemetryConfig({ ...OTLP }), {
        fetch: async (input, init) => {
          // Honour the abort signal the way the real fetch does.
          const signal = init?.signal;
          return Promise.race([
            hanging.fetch(input, init),
            new Promise<Response>((_resolve, reject) =>
              signal?.addEventListener("abort", () => reject(signal.reason)),
            ),
          ]);
        },
        write: (line) => lines.push(line),
      });
      const baseline = await composeHealthApplication().app.request("/health");
      const { app } = composeHealthApplication({
        telemetry: runtime.telemetry,
        logger: runtime.logger,
      });

      const response = await app.request("/health", { headers: { traceparent: TRACEPARENT } });
      expect(response.status).toBe(baseline.status);
      expect(await response.text()).toBe(await baseline.text());

      const started = Date.now();
      await runtime.flush();
      expect(Date.now() - started).toBeLessThan(200 + 250 + 1_000);

      const warnings = records(lines).filter(
        (record) => record.msg === "OpenTelemetry export failed",
      );
      expect(
        warnings.map((record) => [record["scos.telemetry.signal"], record.diagnostic]),
      ).toStrictEqual([
        ["traces", reason],
        ["metrics", reason],
      ]);
      for (const warning of warnings) {
        expect(warning.level).toBe("warn");
        expect(warning).not.toHaveProperty("trace_id");
      }
      expect(lines.join("\n")).not.toMatch(/collector\.test|collector-secret|x-tenant|down/);
    },
  );

  test("an unreachable collector on the real fetch: the flush still settles", async () => {
    const lines: string[] = [];
    const runtime = createWorkersTelemetry(
      workerTelemetryConfig({
        ...OTLP,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
        OTEL_EXPORTER_OTLP_TIMEOUT: "1000",
      }),
      { write: (line) => lines.push(line) },
    );
    const { app } = composeHealthApplication({
      telemetry: runtime.telemetry,
      logger: runtime.logger,
    });
    expect((await app.request("/health")).status).toBe(200);
    await runtime.flush();
    expect(
      records(lines).filter((record) => record.msg === "OpenTelemetry export failed"),
    ).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("127.0.0.1");
  });

  test("a failed export leaves no unhandled rejection", async () => {
    // workerd logs "Uncaught (in promise) Error: Network connection lost" for
    // every failed subrequest, even a handled one (docs/observability.md,
    // "Tests"); this listener is what proves nothing of ours is unhandled.
    const unhandled: unknown[] = [];
    const listener = (event: Event) => {
      unhandled.push((event as PromiseRejectionEvent).reason);
    };
    addEventListener("unhandledrejection", listener);
    try {
      const runtime = createWorkersTelemetry(
        workerTelemetryConfig({
          ...OTLP,
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
          OTEL_EXPORTER_OTLP_TIMEOUT: "1000",
          LOG_LEVEL: "silent",
        }),
      );
      const { app } = composeHealthApplication({ telemetry: runtime.telemetry });
      expect((await app.request("/health")).status).toBe(200);
      await runtime.flush();
      // Unhandled rejections are reported after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 50));
      // A genuinely unhandled rejection does reach this listener in workerd
      // (checked with a control rejection when this test was written); Vitest
      // also fails the whole run on one, so the control is not kept here.
      expect(unhandled).toStrictEqual([]);
    } finally {
      removeEventListener("unhandledrejection", listener);
    }
  });
});

describe("the span buffer", () => {
  test("is bounded: spans beyond the queue are dropped, and a flush exports one batch", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new RequestFlushSpanProcessor(exporter);
    const runtime = createWorkersTelemetry(workerTelemetryConfig({ LOG_LEVEL: "silent" }), {
      spanExporter: exporter,
    });
    const tracer = runtime.telemetry.tracer;
    for (let index = 0; index <= WORKERS_SPAN_LIMITS.maxQueueSize; index += 1) {
      const span = tracer.startSpan(`span-${index}`);
      span.end();
      processor.onEnd(span as never);
    }
    expect(processor.dropped()).toBe(1);
    exporter.reset();
    await processor.exportBatch();
    expect(exporter.getFinishedSpans()).toHaveLength(WORKERS_SPAN_LIMITS.maxExportBatchSize);
    await processor.forceFlush();
    await processor.shutdown();
    expect(exporter.getFinishedSpans()).toHaveLength(WORKERS_SPAN_LIMITS.maxExportBatchSize * 3);
  });

  test("the runtime drops beyond its queue too, and reports it", async () => {
    const harness = workersTestTelemetry({ LOG_LEVEL: "silent" });
    const { tracer } = harness.runtime.telemetry;
    for (let index = 0; index < WORKERS_SPAN_LIMITS.maxQueueSize + 5; index += 1) {
      tracer.startSpan("burst", { kind: SpanKind.INTERNAL }).end();
    }
    expect(harness.runtime.droppedSpans()).toBe(5);
  });
});

describe("sampling and enablement", () => {
  test("an unsampled request: correlated logs with 00, no exported span, metrics still recorded", async () => {
    const harness = workersTestTelemetry({ OTEL_TRACES_SAMPLER_ARG: "0" });
    const { app } = composeHealthApplication({
      telemetry: harness.runtime.telemetry,
      logger: harness.runtime.logger,
    });
    await app.request("/health");
    expect(await harness.spans()).toHaveLength(0);
    const [record] = records(harness.lines);
    expect(record).toMatchObject({ trace_flags: "00", msg: "request completed" });
    expect(record?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(pointsOf<Histogram>(await harness.metrics(), DURATION)[0]?.value.count).toBe(1);
  });

  test("a sampled caller is followed even at ratio 0", async () => {
    const harness = workersTestTelemetry({ OTEL_TRACES_SAMPLER_ARG: "0", LOG_LEVEL: "silent" });
    const { app } = composeHealthApplication({ telemetry: harness.runtime.telemetry });
    await app.request("/health", { headers: { traceparent: TRACEPARENT } });
    const spans = await harness.spans();
    expect(spans.map((span) => span.spanContext().traceId)).toStrictEqual([
      "4bf92f3577b34da6a3ce929d0e0e4736",
    ]);
  });

  test("OTEL_SDK_DISABLED: nothing traced or exported, no trace ID invented, flush is a no-op", async () => {
    const recorder = recordingFetch();
    const lines: string[] = [];
    const runtime = createWorkersTelemetry(
      workerTelemetryConfig({ ...OTLP, OTEL_SDK_DISABLED: "true" }),
      { fetch: recorder.fetch, write: (line) => lines.push(line) },
    );
    const { app } = composeHealthApplication({
      telemetry: runtime.telemetry,
      logger: runtime.logger,
    });
    await app.request("/health");
    await app.request("/health", { headers: { traceparent: TRACEPARENT } });
    await runtime.flush();
    expect(recorder.posted).toHaveLength(0);
    expect(runtime.droppedSpans()).toBe(0);
    const [plain, propagated] = records(lines);
    expect(plain).toMatchObject({ msg: "request completed", "http.route": "/health" });
    expect(plain).not.toHaveProperty("trace_id");
    // Only the caller's own context can appear (the no-op tracer propagates it
    // when another test in this isolate registered a context manager); an ID
    // is never generated.
    expect([undefined, "4bf92f3577b34da6a3ce929d0e0e4736"]).toContain(propagated?.trace_id);
  });
});

describe("the Workers logger", () => {
  test("one console.log call per record object, with the resource, severity, correlation and redaction", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runtime = createWorkersTelemetry(
      workerTelemetryConfig({
        OTEL_SERVICE_NAME: "scos-worker",
        SERVICE_VERSION: "1.2.3",
        DEPLOYMENT_ENVIRONMENT: "preview",
        LOG_LEVEL: "debug",
      }),
    );
    const span = runtime.telemetry.tracer.startSpan("work");
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      runtime.logger.debug("detail", {
        token: "t0ken",
        latitude: 49.0097,
        headers: { authorization: "Bearer x", accept: "application/json" },
        error: new TypeError("SELECT secret FROM users"),
      });
      runtime.logger.child({ component: "submit", password: "p" }).warn("child");
    });
    runtime.logger.trace("filtered");
    span.end();

    expect(log).toHaveBeenCalledTimes(2);
    // The record object itself, so Workers Logs indexes each field.
    const [first, second] = log.mock.calls.map(([record]) => {
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
      return record as Record<string, unknown>;
    });
    const { traceId, spanId } = span.spanContext();
    expect(first).toStrictEqual({
      level: "debug",
      severity_number: 5,
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      "service.name": "scos-worker",
      "service.version": "1.2.3",
      "deployment.environment.name": "preview",
      trace_id: traceId,
      span_id: spanId,
      trace_flags: "01",
      token: "[REDACTED]",
      latitude: "[REDACTED]",
      headers: { authorization: "[REDACTED]", accept: "application/json" },
      error: { type: "TypeError", stack: expect.any(Array) },
      msg: "detail",
    });
    expect(second).toMatchObject({
      level: "warn",
      severity_number: 13,
      component: "submit",
      password: "[REDACTED]",
      trace_id: traceId,
      msg: "child",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/t0ken|49\.0097|SELECT secret|Bearer x/);
  });
});
