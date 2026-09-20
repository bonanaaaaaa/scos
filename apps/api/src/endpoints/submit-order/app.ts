/**
 * `POST /api/v1/orders` as a standalone Hono app: submission deduplicated by
 * submissionId. Pure construction; the use case is injected. HTTP maps the
 * use-case outcomes only.
 *
 * @module
 */

import type { SubmitOrder } from "@scos/core";
import type { Context, Hono } from "hono";

import {
  RETRY_AFTER_SECONDS,
  type RejectedSubmissionResponse,
  submitOrderRequestSchema,
  submitOrderRoute,
} from "#endpoints/submit-order/contract";
import { SUBMIT_ORDER_MESSAGES } from "#endpoints/submit-order/messages";
import { orderBody, rejectedEstimateBody } from "#endpoints/submit-order/serializers";
import { describeContract } from "#http/describe-route";
import { createEndpointApp } from "#http/endpoint-app";
import { errorBody, invalidRequest, toIssues } from "#http/errors";
import { jsonBody, requireJson } from "#http/json";
import { type Logger, defaultLogger } from "#http/logger";
import { MESSAGES } from "#http/messages";

export interface SubmitOrderAppDependencies {
  readonly submitOrder: SubmitOrder;
  readonly logger?: Logger;
}

/** Nothing was committed; the client may retry with the same submissionId. */
function unavailable(c: Context) {
  c.header("Retry-After", String(RETRY_AFTER_SECONDS));
  return c.json(errorBody("SERVICE_UNAVAILABLE", SUBMIT_ORDER_MESSAGES.unavailable), 503);
}

export function createSubmitOrderApp(dependencies: SubmitOrderAppDependencies): Hono {
  const { submitOrder, logger = defaultLogger } = dependencies;
  const app = createEndpointApp(logger, () => SUBMIT_ORDER_MESSAGES.internal);

  app.post(
    submitOrderRoute.path,
    requireJson,
    jsonBody(submitOrderRequestSchema),
    describeContract(submitOrderRoute),
    async (c) => {
      const outcome = await submitOrder(c.req.valid("json"));
      switch (outcome.kind) {
        case "accepted":
          return c.json(orderBody(outcome.order), 201);
        case "rejected": {
          const message =
            outcome.reason === "INSUFFICIENT_STOCK"
              ? SUBMIT_ORDER_MESSAGES.insufficientStock
              : SUBMIT_ORDER_MESSAGES.shippingExceedsLimit;
          const body: RejectedSubmissionResponse = {
            error: { code: outcome.reason, message },
            estimate: rejectedEstimateBody(outcome.estimate),
          };
          return c.json(body, 422);
        }
        case "conflict":
          return c.json(errorBody("SUBMISSION_ID_CONFLICT", SUBMIT_ORDER_MESSAGES.conflict), 409);
        case "invalid":
          return invalidRequest(c, MESSAGES.invalidBody, toIssues(outcome.issues));
        case "unavailable":
          return unavailable(c);
      }
    },
  );

  return app;
}
