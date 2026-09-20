/**
 * Attaches a route contract to its Hono route as hono-openapi documentation.
 * The contract stays the single source: this maps its fields onto
 * `describeRoute` and hands every body schema to hono-openapi's `resolver`,
 * which converts it with Zod's own `z.toJSONSchema` (request bodies as input,
 * responses as output). Named components come from each schema's
 * `.meta({ id })`.
 *
 * Register it after the body validator: hono-openapi merges a route's
 * middleware in order, and this request body (with its examples and
 * description) must replace the bare one the validator contributes.
 *
 * @module
 */

import { type DescribeRouteOptions, describeRoute, resolver } from "hono-openapi";
import type { MiddlewareHandler } from "hono";
import type { OpenAPIV3_1 } from "openapi-types";
import { z } from "zod";

import {
  API_PREFIX,
  type ExampleMap,
  type HeaderContract,
  JSON_REQUEST_DESCRIPTION,
  type ResponseContract,
  type RouteContract,
} from "#http/route-contract";

type ResponsesOption = NonNullable<DescribeRouteOptions["responses"]>;
type ResponseOption = ResponsesOption[string];

const JSON_MEDIA_TYPE = "application/json";

/**
 * Zod conversion options for every schema hono-openapi resolves. The library
 * defaults to `unrepresentable: "any"`, which would publish a transform, a
 * bigint or a date as an empty schema (`{}`) that accepts anything; throwing
 * makes generation, and so the export and its unit tests, fail instead.
 */
export const SPEC_CONVERSION = { unrepresentable: "throw" } as const;

/** Tag of an operation: the versioned order API, or liveness. */
export function routeTag(route: Pick<RouteContract, "path">): "Orders" | "Health" {
  return route.path.startsWith(`${API_PREFIX}/`) ? "Orders" : "Health";
}

function examplesOf(examples: ExampleMap | undefined) {
  return examples === undefined ? {} : { examples: examples as Record<string, object> };
}

/**
 * A header's schema as plain JSON Schema: hono-openapi resolves body schemas
 * only, so headers are converted with Zod directly (without the per-schema
 * `$schema`, which the OpenAPI 3.1 dialect implies).
 */
function headerObject(header: HeaderContract): OpenAPIV3_1.HeaderObject {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(header.schema, { io: "output" });
  return {
    description: header.description,
    required: true,
    // openapi-types' 3.1 HeaderObject reuses its 3.0 schema types, which
    // Zod's draft 2020-12 JSON Schema type does not narrow to.
    schema: schema as unknown as NonNullable<OpenAPIV3_1.HeaderObject["schema"]>,
    ...(header.example === undefined ? {} : { example: header.example }),
  };
}

/** One documented response; its schema is converted as output. */
export function responseOption(response: ResponseContract): ResponseOption {
  return {
    description: response.description,
    ...(response.headers === undefined
      ? {}
      : {
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([name, header]) => [name, headerObject(header)]),
          ),
        }),
    content: {
      [JSON_MEDIA_TYPE]: {
        schema: resolver(response.schema, { options: { ...SPEC_CONVERSION, io: "output" } }),
        ...examplesOf(response.examples),
      },
    },
  };
}

/** The `describeRoute` options of a contract. */
export function describeRouteOptions(route: RouteContract): DescribeRouteOptions {
  return {
    operationId: route.operationId,
    tags: [routeTag(route)],
    summary: route.summary,
    ...(route.description === undefined ? {} : { description: route.description }),
    ...(route.requestBody === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            description: JSON_REQUEST_DESCRIPTION,
            content: {
              [JSON_MEDIA_TYPE]: {
                schema: resolver(route.requestBody, { options: SPEC_CONVERSION }),
                ...examplesOf(route.requestExamples),
              },
            },
          },
        }),
    responses: Object.fromEntries(
      Object.entries(route.responses).map(([status, response]) => [
        status,
        responseOption(response as ResponseContract),
      ]),
    ),
  };
}

/** Middleware that documents `route`; it does nothing at request time. */
export function describeContract(route: RouteContract): MiddlewareHandler {
  return describeRoute(describeRouteOptions(route));
}
