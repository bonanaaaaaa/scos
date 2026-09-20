/**
 * The Workers telemetry composition (`createWorkersTelemetry`: SDK tracer and
 * meter providers, the per-request span buffer and DELTA metric reader, the
 * AsyncLocalStorage context manager, the W3C propagator) against the shared
 * telemetry port contract, inside workerd, with in-memory exporters in place
 * of the OTLP `fetch` exporters. Each `spans()`/`metrics()` call is a real
 * per-request flush; the harness adds up the DELTA metric exports.
 */

import { composeWorkerApplication } from "#composition/worker";
import { composeHealthApplication } from "#endpoints/health/composition";
import { fakeLogger } from "#testing/fixtures.test-support";
import { describeTelemetryContract } from "#testing/telemetry-contract.test-support";
import {
  UNREACHABLE_DATABASE_URL,
  workersTestTelemetry,
} from "#testing/workers-telemetry.test-support";

describeTelemetryContract("Cloudflare Workers SDK (telemetry/workers/sdk.ts)", () => {
  const test = workersTestTelemetry({ LOG_LEVEL: "silent" });
  return {
    telemetry: test.runtime.telemetry,
    flush: () => test.runtime.flush(),
    spans: () => test.spans(),
    metrics: () => test.metrics(),
    shutdown: () => test.runtime.flush(),
    compositions: {
      combined: (telemetry) =>
        composeWorkerApplication({
          databaseUrl: UNREACHABLE_DATABASE_URL,
          logger: fakeLogger(),
          telemetry,
        }),
      health: (telemetry) => composeHealthApplication({ telemetry, logger: fakeLogger() }),
    },
  };
});
