/**
 * `POST /api/v1/orders/verify` as a standalone Hono app: the advisory Order
 * Estimate. Pure construction; the use case is injected.
 *
 * @module
 */

import { type VerifyOrder, orderRequestSchema } from "@scos/core";
import type { Hono } from "hono";

import { verifyOrderRequestSchema, verifyOrderRoute } from "#endpoints/verify-order/contract";
import { describeContract } from "#http/describe-route";
import { createEndpointApp } from "#http/endpoint-app";
import { estimateBody } from "#http/estimate";
import { jsonBody, requireJson } from "#http/json";
import { type Logger, defaultLogger } from "#http/logger";
import { MESSAGES } from "#http/messages";

export interface VerifyOrderAppDependencies {
  readonly verifyOrder: VerifyOrder;
  readonly logger?: Logger;
}

export function createVerifyOrderApp(dependencies: VerifyOrderAppDependencies): Hono {
  const { verifyOrder, logger = defaultLogger } = dependencies;
  const app = createEndpointApp(logger, () => MESSAGES.internal);

  app.post(
    verifyOrderRoute.path,
    requireJson,
    jsonBody(verifyOrderRequestSchema),
    describeContract(verifyOrderRoute),
    async (c) => {
      // Already validated with the same limits; this only builds the branded
      // OrderRequest. A failure here would be a bug and maps to 500.
      const request = orderRequestSchema.parse(c.req.valid("json"));
      const estimate = await verifyOrder(request);
      return c.json(estimateBody(estimate), 200);
    },
  );

  return app;
}
