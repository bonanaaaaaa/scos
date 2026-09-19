/**
 * The Hono inbound adapter: routes, request validation and the mapping from
 * use-case outcomes to HTTP responses.
 *
 * Each endpoint is its own complete Hono app, so it can be deployed alone (one
 * Lambda function per endpoint, #14): `createHealthApp`,
 * `createVerifyOrderApp` and `createSubmitOrderApp`. Every one of them has the
 * same JSON handling, error envelope, 500 mapping and 404 envelope, shared
 * through {@link createEndpointApp}. `createApp` mounts all three for the local
 * server and for the documentation routes (#12).
 *
 * Construction is pure: it reads no environment and opens no connection; the
 * use cases are injected (see `composition.ts` for the real wiring and the
 * unit tests for fakes).
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

export interface VerifyOrderAppDependencies {
  readonly verifyOrder: VerifyOrder;
  readonly logger?: Logger;
}

export interface SubmitOrderAppDependencies {
  readonly submitOrder: SubmitOrder;
  readonly logger?: Logger;
}

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

function notFound(c: Context) {
  return c.json(errorBody("NOT_FOUND", MESSAGES.notFound), 404);
}

/**
 * The shared error mapping: an unparsable JSON body (Hono's validator throws a
 * 400 HTTPException) is `400 INVALID_REQUEST`; anything else is logged and
 * becomes `500 INTERNAL_ERROR` with `internalMessage`, exposing no internals.
 */
function errorHandler(logger: Logger, internalMessage: (c: Context) => string) {
  return (error: Error, c: Context) => {
    if (error instanceof HTTPException && error.status === 400) {
      return invalidRequest(c, MESSAGES.malformedJson);
    }
    logger.error("Unhandled error while handling a request", {
      method: c.req.method,
      path: c.req.path,
      error,
    });
    return c.json(errorBody("INTERNAL_ERROR", internalMessage(c)), 500);
  };
}

/**
 * A complete Hono app with the shared 404 envelope and error mapping. Every
 * standalone endpoint app and the combined app start from it, so they answer
 * unknown routes and failures identically.
 */
function createEndpointApp(logger: Logger, internalMessage: (c: Context) => string): Hono {
  const app = new Hono();
  app.notFound(notFound);
  app.onError(errorHandler(logger, internalMessage));
  return app;
}

const internalMessage = () => MESSAGES.internal;
const submitInternalMessage = () => MESSAGES.submitInternal;

export interface HealthAppOptions {
  readonly logger?: Logger;
}

/** `GET /health`: liveness only; needs no dependencies or database. */
export function createHealthApp(options: HealthAppOptions = {}): Hono {
  const app = createEndpointApp(options.logger ?? consoleLogger, internalMessage);
  app.get(routes.health.path, (c) => c.json({ status: "ok" }));
  return app;
}

/** `POST /orders/verify`: the advisory Order Estimate. */
export function createVerifyOrderApp(dependencies: VerifyOrderAppDependencies): Hono {
  const { verifyOrder, logger = consoleLogger } = dependencies;
  const app = createEndpointApp(logger, internalMessage);

  app.post(routes.verifyOrder.path, requireJson, jsonBody(verifyOrderRequestSchema), async (c) => {
    // Already validated with the same limits; this only builds the branded
    // OrderRequest. A failure here would be a bug and maps to 500.
    const request = orderRequestSchema.parse(c.req.valid("json"));
    const estimate = await verifyOrder(request);
    return c.json(estimateBody(estimate), 200);
  });

  return app;
}

/** `POST /orders`: submission, deduplicated by submissionId. */
export function createSubmitOrderApp(dependencies: SubmitOrderAppDependencies): Hono {
  const { submitOrder, logger = consoleLogger } = dependencies;
  const app = createEndpointApp(logger, submitInternalMessage);

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

  return app;
}

/**
 * All routes in one app, for the local server and the documentation routes.
 * It mounts the three endpoint apps: Hono applies each mounted app's own error
 * handler to its routes, and this app's 404 envelope to everything else, so
 * responses are identical to the standalone apps.
 */
export function createApp(dependencies: AppDependencies): Hono {
  const { verifyOrder, submitOrder, logger = consoleLogger } = dependencies;
  // Only reached by errors outside the mounted routes; same mapping by path.
  const app = createEndpointApp(logger, (c) =>
    c.req.path === routes.submitOrder.path ? MESSAGES.submitInternal : MESSAGES.internal,
  );
  app.route("/", createHealthApp({ logger }));
  app.route("/", createVerifyOrderApp({ verifyOrder, logger }));
  app.route("/", createSubmitOrderApp({ submitOrder, logger }));
  return app;
}
