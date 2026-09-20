/**
 * The shape of a route contract and the responses every endpoint shares, so
 * each endpoint folder can declare its own route, with its documentation and
 * examples. Each endpoint app attaches its contract to its Hono route
 * (`http/describe-route.ts`), and hono-openapi generates the document from
 * the app (`src/openapi/`).
 *
 * @module
 */

import type { z } from "zod";

import { errorBody, errorResponseSchema } from "#http/errors";
import { MESSAGES } from "#http/messages";

/**
 * Prefix of the versioned order API. `GET /health` stays at the root: it is a
 * liveness probe outside the API surface. Each endpoint app serves its full
 * prefixed path itself, so it works deployed alone (#14).
 */
export const API_PREFIX = "/api/v1";

/** ADR 0004: how submissionId deduplicates accepted Orders. */
export const SUBMISSION_ADR_URL =
  "https://github.com/bonanaaaaaa/scos/blob/main/docs/adr/0004-deduplicate-accepted-orders.md";

/** A named OpenAPI example: a request or response body. */
export interface ExampleContract {
  readonly summary: string;
  readonly description?: string;
  readonly value: unknown;
}

export type ExampleMap = Readonly<Record<string, ExampleContract>>;

export interface HeaderContract {
  readonly description: string;
  readonly schema: z.ZodType;
  readonly example?: unknown;
}

export interface ResponseContract {
  readonly description: string;
  readonly schema: z.ZodType;
  /** Response headers the client can rely on, by name. */
  readonly headers?: Readonly<Record<string, HeaderContract>>;
  /** Named example bodies; each is checked against `schema` in unit tests. */
  readonly examples?: ExampleMap;
}

/** The standalone app factory that serves a route. */
export type EndpointApp = "createHealthApp" | "createVerifyOrderApp" | "createSubmitOrderApp";

export interface RouteContract {
  /**
   * The standalone Hono app that serves this route and nothing else (one
   * deployable function per endpoint). `createApp` mounts all of them.
   */
  readonly servedBy: EndpointApp;
  /** The OpenAPI `operationId`; also the route's key in `routes`. */
  readonly operationId: string;
  readonly method: "get" | "post";
  readonly path: string;
  readonly summary: string;
  /** Longer operation documentation (CommonMark). */
  readonly description?: string;
  readonly requestBody?: z.ZodType;
  /** Named example request bodies; each is checked against `requestBody`. */
  readonly requestExamples?: ExampleMap;
  readonly responses: Readonly<Record<number, ResponseContract>>;
}

/**
 * How every JSON request body is read, before its schema applies. Rules that
 * JSON Schema cannot express (Content-Type, no coercion) are stated here.
 */
export const JSON_REQUEST_DESCRIPTION = [
  "Send the body as JSON with `Content-Type: application/json` (parameters such as `charset`, and `+json` media types, are accepted). A missing or different Content-Type, malformed JSON or an empty body is `400 INVALID_REQUEST`.",
  'Unknown fields are rejected (`400`). Numbers must be JSON numbers: strings such as `"10"` are never coerced.',
].join("\n\n");

export const invalidRequestResponse: ResponseContract = {
  description:
    "INVALID_REQUEST: invalid JSON, a missing or non-JSON Content-Type, unknown fields, or a value outside the documented limits. `issues` lists schema failures by path (`[]` is the body itself) and is absent for Content-Type and JSON syntax errors. Nothing is stored and no submissionId is consumed.",
  schema: errorResponseSchema,
};

/** Response examples shared by every endpoint with a JSON body. */
export const invalidRequestExamples = {
  unsupportedContentType: {
    summary: "Missing or non-JSON Content-Type",
    value: errorBody("INVALID_REQUEST", MESSAGES.unsupportedContentType),
  },
  malformedJson: {
    summary: "Body is not valid JSON",
    value: errorBody("INVALID_REQUEST", MESSAGES.malformedJson),
  },
} as const satisfies ExampleMap;

/** Body of a 404 for any path or method no endpoint serves. */
export const notFoundResponse: ResponseContract = {
  description:
    "NOT_FOUND: no route matches this method and path (including the unversioned `/orders` paths).",
  schema: errorResponseSchema,
  examples: {
    notFound: {
      summary: "Unknown method or path",
      value: errorBody("NOT_FOUND", MESSAGES.notFound),
    },
  },
};
