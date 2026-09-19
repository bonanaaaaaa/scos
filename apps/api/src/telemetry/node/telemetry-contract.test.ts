/**
 * The Node/Lambda telemetry composition (`createTelemetryRuntime`: SDK
 * providers, batch span processor, AsyncLocalStorage context, W3C
 * propagator) against the shared telemetry port contract, with in-memory
 * exporters in place of OTLP.
 */

import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";

import { composeApplication } from "../../composition";
import { composeHealthApplication } from "../../endpoints/health/composition";
import { fakeLogger } from "../../testing/fixtures.test-support";
import { unreachableDatabaseUrl } from "../../testing/persistence-spies.test-support";
import { describeTelemetryContract } from "../../testing/telemetry-contract.test-support";
import { parseTelemetryConfig } from "../../testing/telemetry.test-support";
import { createTelemetryRuntime } from "./sdk";

describeTelemetryContract("Node/Lambda SDK (telemetry/node/sdk.ts)", () => {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000,
  });
  const runtime = createTelemetryRuntime(parseTelemetryConfig({ LOG_LEVEL: "silent" }), {
    spanExporter,
    metricReader,
  });
  return {
    telemetry: runtime.telemetry,
    flush: () => runtime.forceFlush(),
    async spans() {
      await runtime.forceFlush();
      return spanExporter.getFinishedSpans();
    },
    async metrics() {
      await metricReader.forceFlush();
      return (
        metricExporter
          .getMetrics()
          .at(-1)
          ?.scopeMetrics.flatMap((scope) => scope.metrics) ?? []
      );
    },
    shutdown: () => runtime.shutdown(),
    compositions: {
      combined: (telemetry) =>
        composeApplication({
          databaseUrl: unreachableDatabaseUrl,
          logger: fakeLogger(),
          telemetry,
        }),
      health: (telemetry) => composeHealthApplication({ telemetry, logger: fakeLogger() }),
    },
  };
});
