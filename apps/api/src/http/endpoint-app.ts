/**
 * The base every endpoint app (and the combined app) is built on, so all of
 * them answer unknown routes and failures identically.
 *
 * @module
 */

import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { errorBody, invalidRequest, notFound } from "./errors";
import type { Logger } from "./logger";
import { MESSAGES } from "./messages";

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

/** A complete Hono app with the shared 404 envelope and error mapping. */
export function createEndpointApp(logger: Logger, internalMessage: (c: Context) => string): Hono {
  const app = new Hono();
  app.notFound(notFound);
  app.onError(errorHandler(logger, internalMessage));
  return app;
}
