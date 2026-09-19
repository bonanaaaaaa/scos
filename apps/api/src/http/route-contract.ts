/**
 * The shape of a route contract and the responses every endpoint shares, so
 * each endpoint folder can declare its own route for offline OpenAPI
 * generation (#12).
 *
 * @module
 */

import type { z } from "zod";

import { errorResponseSchema } from "./errors";

/**
 * Prefix of the versioned order API. `GET /health` stays at the root: it is a
 * liveness probe outside the API surface. Each endpoint app serves its full
 * prefixed path itself, so it works deployed alone (#14).
 */
export const API_PREFIX = "/api/v1";

export interface ResponseContract {
  readonly description: string;
  readonly schema: z.ZodType;
  /** Response headers the client can rely on, by name. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The standalone app factory that serves a route. */
export type EndpointApp = "createHealthApp" | "createVerifyOrderApp" | "createSubmitOrderApp";

export interface RouteContract {
  /**
   * The standalone Hono app that serves this route and nothing else (one
   * deployable function per endpoint). `createApp` mounts all of them.
   */
  readonly servedBy: EndpointApp;
  readonly method: "get" | "post";
  readonly path: string;
  readonly summary: string;
  readonly requestBody?: z.ZodType;
  readonly responses: Readonly<Record<number, ResponseContract>>;
}

export const invalidRequestResponse: ResponseContract = {
  description:
    "Malformed request: invalid JSON, a missing or non-JSON Content-Type, unknown fields, or a value outside the documented limits. Nothing is stored and no submissionId is consumed.",
  schema: errorResponseSchema,
};

/** Body of a 404 for any path or method no endpoint serves. */
export const notFoundResponse: ResponseContract = {
  description: "No such route.",
  schema: errorResponseSchema,
};
