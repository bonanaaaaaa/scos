/**
 * The Hono inbound adapter: routes, request validation and the mapping from
 * use-case outcomes to HTTP responses.
 *
 * `createApp` is pure construction. It reads no environment and opens no
 * connection; the use cases are injected (see `composition.ts` for the real
 * wiring and the unit tests for fakes).
 *
 * @module
 */

import { sValidator } from "@hono/standard-validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type SubmitOrder,
  type SubmitOrderIssue,
  type VerifyOrder,
  orderRequestSchema,
} from "@scos/core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  type ErrorCode,
  type ErrorIssue,
  type ErrorResponse,
  RETRY_AFTER_SECONDS,
  type RejectedSubmissionResponse,
  routes,
  submitOrderRequestSchema,
  verifyOrderRequestSchema,
} from "./http/contracts";
import { estimateBody, orderBody, rejectedEstimateBody } from "./http/serializers";

/** Server-side sink for unexpected errors. Never sent to the client. */
export interface Logger {
  error(message: string, details: Readonly<Record<string, unknown>>): void;
}

export const consoleLogger: Logger = {
  error(message, details) {
    console.error(message, details);
  },
};

export interface AppDependencies {
  readonly verifyOrder: VerifyOrder;
  readonly submitOrder: SubmitOrder;
  readonly logger?: Logger;
}

export const MESSAGES = Object.freeze({
  invalidBody: "The request body is invalid.",
  malformedJson: "The request body is not valid JSON.",
  unsupportedContentType: "The request body must be JSON sent with Content-Type: application/json.",
  notFound: "No route matches this method and path.",
  conflict:
    "This submissionId was already used for an Order with a different quantity or destination. Use a new submissionId for a different order.",
  insufficientStock:
    "Available stock cannot fulfil the requested quantity. Nothing was stored; the same submissionId may be reused.",
  shippingExceedsLimit:
    "The shipping cost exceeds 15% of the discounted merchandise total. Nothing was stored; the same submissionId may be reused.",
  unavailable:
    "The order could not be processed right now and was not accepted. Retry with the same submissionId after the Retry-After delay.",
  submitInternal:
    "An unexpected error occurred and the order could not be confirmed. Retry with the same submissionId: an accepted Order is returned, never duplicated.",
  internal: "An unexpected error occurred. The request may be retried.",
});

/** Same test Hono's validator uses to decide whether it parses the body. */
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

function errorBody(code: ErrorCode, message: string, issues?: readonly ErrorIssue[]) {
  const body: ErrorResponse = { error: { code, message } };
  if (issues !== undefined) {
    body.error.issues = [...issues];
  }
  return body;
}

function pathSegment(segment: PropertyKey | StandardSchemaV1.PathSegment): string | number {
  const key = typeof segment === "object" ? segment.key : segment;
  return typeof key === "number" ? key : String(key);
}

function toIssues(
  issues: readonly (StandardSchemaV1.Issue | SubmitOrderIssue)[],
): readonly ErrorIssue[] {
  return issues.map((issue) => ({
    path: (issue.path ?? []).map(pathSegment),
    message: issue.message,
  }));
}

function invalidRequest(c: Context, message: string, issues?: readonly ErrorIssue[]) {
  return c.json(errorBody("INVALID_REQUEST", message, issues), 400);
}

/** Nothing was committed; the client may retry with the same submissionId. */
function unavailable(c: Context) {
  c.header("Retry-After", String(RETRY_AFTER_SECONDS));
  return c.json(errorBody("SERVICE_UNAVAILABLE", MESSAGES.unavailable), 503);
}

/**
 * Rejects bodies Hono would not parse as JSON. Without this, the validator
 * would validate `{}` and report missing fields, hiding the real problem.
 */
const requireJson: MiddlewareHandler = async (c, next) => {
  const contentType = c.req.header("Content-Type");
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
    return invalidRequest(c, MESSAGES.unsupportedContentType);
  }
  await next();
};

function jsonBody<Schema extends StandardSchemaV1>(schema: Schema) {
  return sValidator("json", schema, (result, c) => {
    if (!result.success) {
      return invalidRequest(c, MESSAGES.invalidBody, toIssues(result.error));
    }
    return undefined;
  });
}

export function createApp(dependencies: AppDependencies): Hono {
  const { verifyOrder, submitOrder, logger = consoleLogger } = dependencies;
  const app = new Hono();

  app.get(routes.health.path, (c) => c.json({ status: "ok" }));

  app.post(routes.verifyOrder.path, requireJson, jsonBody(verifyOrderRequestSchema), async (c) => {
    // Already validated with the same limits; this only builds the branded
    // OrderRequest. A failure here would be a bug and maps to 500.
    const request = orderRequestSchema.parse(c.req.valid("json"));
    const estimate = await verifyOrder(request);
    return c.json(estimateBody(estimate), 200);
  });

  app.post(routes.submitOrder.path, requireJson, jsonBody(submitOrderRequestSchema), async (c) => {
    const outcome = await submitOrder(c.req.valid("json"));
    switch (outcome.kind) {
      case "accepted":
        return c.json(orderBody(outcome.order), 201);
      case "rejected": {
        const message =
          outcome.reason === "INSUFFICIENT_STOCK"
            ? MESSAGES.insufficientStock
            : MESSAGES.shippingExceedsLimit;
        const body: RejectedSubmissionResponse = {
          error: { code: outcome.reason, message },
          estimate: rejectedEstimateBody(outcome.estimate),
        };
        return c.json(body, 422);
      }
      case "conflict":
        return c.json(errorBody("SUBMISSION_ID_CONFLICT", MESSAGES.conflict), 409);
      case "invalid":
        return invalidRequest(c, MESSAGES.invalidBody, toIssues(outcome.issues));
      case "unavailable":
        return unavailable(c);
    }
  });

  app.notFound((c) => c.json(errorBody("NOT_FOUND", MESSAGES.notFound), 404));

  app.onError((error, c) => {
    // Hono's JSON validator throws a 400 HTTPException for an unparsable body.
    if (error instanceof HTTPException && error.status === 400) {
      return invalidRequest(c, MESSAGES.malformedJson);
    }
    logger.error("Unhandled error while handling a request", {
      method: c.req.method,
      path: c.req.path,
      error,
    });
    const message =
      c.req.path === routes.submitOrder.path ? MESSAGES.submitInternal : MESSAGES.internal;
    return c.json(errorBody("INTERNAL_ERROR", message), 500);
  });

  return app;
}
