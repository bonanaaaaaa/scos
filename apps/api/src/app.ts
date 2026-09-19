/**
 * The combined app: every endpoint in one Hono app, plus the documentation
 * routes (`GET /openapi.json`, `GET /docs`), for the local server. Each
 * endpoint is also a complete app on its own (`endpoints/<name>/app.ts`),
 * deployable as its own Lambda function (#14); those do not serve the
 * documentation.
 *
 * @module
 */

import type { SubmitOrder, VerifyOrder } from "@scos/core";
import type { Hono } from "hono";

import { createHealthApp } from "./endpoints/health/app";
import { SUBMIT_ORDER_MESSAGES } from "./endpoints/submit-order/messages";
import { createSubmitOrderApp } from "./endpoints/submit-order/app";
import { createVerifyOrderApp } from "./endpoints/verify-order/app";
import { createEndpointApp } from "./http/endpoint-app";
import { type Logger, defaultLogger } from "./http/logger";
import { MESSAGES } from "./http/messages";
import { createDocsApp } from "./openapi/docs-app";
import { routes } from "./routes";

export interface AppDependencies {
  readonly verifyOrder: VerifyOrder;
  readonly submitOrder: SubmitOrder;
  readonly logger?: Logger;
}

/**
 * Mounts the three endpoint apps and the documentation routes. Hono applies each mounted app's own error
 * handler to its routes, and this app's 404 envelope to everything else, so
 * responses are identical to the standalone apps.
 */
export function createApp(dependencies: AppDependencies): Hono {
  const { verifyOrder, submitOrder, logger = defaultLogger } = dependencies;
  // Only reached by errors outside the mounted routes; same mapping by path.
  const app = createEndpointApp(logger, (c) =>
    c.req.path === routes.submitOrder.path ? SUBMIT_ORDER_MESSAGES.internal : MESSAGES.internal,
  );
  app.route("/", createHealthApp({ logger }));
  app.route("/", createVerifyOrderApp({ verifyOrder, logger }));
  app.route("/", createSubmitOrderApp({ submitOrder, logger }));
  app.route("/", createDocsApp(logger, app));
  return app;
}
