/**
 * `GET /health` as a standalone Hono app: liveness only, no dependencies.
 *
 * @module
 */

import type { Hono } from "hono";

import { healthRoute } from "#endpoints/health/contract";
import { describeContract } from "#http/describe-route";
import { createEndpointApp } from "#http/endpoint-app";
import { type Logger, defaultLogger } from "#http/logger";
import { MESSAGES } from "#http/messages";

export interface HealthAppOptions {
  readonly logger?: Logger;
}

export function createHealthApp(options: HealthAppOptions = {}): Hono {
  const app = createEndpointApp(options.logger ?? defaultLogger, () => MESSAGES.internal);
  app.get(healthRoute.path, describeContract(healthRoute), (c) => c.json({ status: "ok" }));
  return app;
}
