/**
 * Composition of `GET /health` alone: no configuration and no database.
 *
 * @module
 */

import { type ComposedApplication, withHttpTelemetry } from "#composition/database";
import type { Logger } from "#http/logger";
import type { Telemetry } from "#telemetry/telemetry";

import { createHealthApp } from "./app";

export interface HealthCompositionOptions {
  readonly logger?: Logger;
  /** Traces and meters `GET /health`; omitted, nothing is instrumented. */
  readonly telemetry?: Telemetry;
}

/** `close()` is a no-op: nothing was opened. */
export function composeHealthApplication(
  options: HealthCompositionOptions = {},
): ComposedApplication {
  const app = createHealthApp(options.logger === undefined ? {} : { logger: options.logger });
  return { app: withHttpTelemetry(app, options), close: async () => undefined };
}
