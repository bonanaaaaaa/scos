/**
 * Builds the OpenAPI 3.1 document from the route contracts (`routes.ts`) with
 * Zod's native JSON Schema conversion (draft 2020-12, the OpenAPI 3.1
 * dialect). Request bodies are converted as input (`io: "input"`), responses
 * as output (`io: "output"`), from the same schemas the endpoints validate
 * with and serialize to, so there is no second, handwritten model.
 *
 * Pure and deterministic: it reads no environment, opens no connection and
 * adds no timestamps, so `GET /openapi.json` and the offline export
 * (`docs/openapi.json`) are the same bytes.
 *
 * @module
 */

import { z } from "zod";

import {
  API_PREFIX,
  type ExampleMap,
  JSON_REQUEST_DESCRIPTION,
  type ResponseContract,
  type RouteContract,
  SUBMISSION_ADR_URL,
  notFoundResponse,
} from "../http/route-contract";
import { routes } from "../routes";
import {
  type ComponentRegistry,
  requestComponentRegistry,
  responseComponentRegistry,
} from "./components";

export type JsonObject = { [key: string]: unknown };

/** The generated document. Parts are plain JSON; see the OpenAPI 3.1 specification. */
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: JsonObject;
  readonly servers: readonly JsonObject[];
  readonly tags: readonly JsonObject[];
  readonly paths: Readonly<Record<string, Record<string, JsonObject>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonObject>>;
    readonly responses: Readonly<Record<string, JsonObject>>;
  };
}

const COMPONENT_SCHEMA_PREFIX = "#/components/schemas/";
const JSON_MEDIA_TYPE = "application/json";

const API_DESCRIPTION = [
  "Verify and submit orders for the SCOS device against current Warehouse Inventory.",
  [
    "- Request and response bodies are JSON. Requests must be sent with `Content-Type: application/json`; unknown fields are rejected and strings are never coerced to numbers.",
    '- Money is a decimal string with exactly two fractional digits, such as `"150.00"`; `discountRate` is a two-decimal string such as `"0.05"`. `distanceKm` is an unrounded number.',
    "- Every non-2xx body has an `error` object with a machine-readable `code` and a `message`. Most are exactly `ErrorResponse`; a `422` submission rejection (`RejectedSubmission`) also carries the `estimate` that caused it. Any method or path not listed here is `404 NOT_FOUND` (see `components.responses.NotFound`); the unversioned `/orders` paths are not aliases.",
    `- \`POST ${API_PREFIX}/orders\` is deduplicated by the client's \`submissionId\` ([ADR 0004](${SUBMISSION_ADR_URL})).`,
  ].join("\n"),
  "The request examples produce the documented responses against a freshly seeded database when sent in the documented order (the accepted submission before its repeat and the conflicting reuse). After other orders have been accepted, stock differs, so allocations, amounts and outcomes can differ too.",
].join("\n\n");

/** Zod's per-schema `$schema`/`$id` are implied by the OpenAPI 3.1 dialect. */
function withoutSchemaIdentifiers(schema: JsonObject): JsonObject {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

function convertRegistry(registry: ComponentRegistry, io: "input" | "output") {
  const converted = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    io,
    metadata: registry,
    unrepresentable: "throw",
    uri: (id) => `${COMPONENT_SCHEMA_PREFIX}${id}`,
  });
  return Object.fromEntries(
    Object.entries(converted.schemas).map(([id, schema]) => [
      id,
      withoutSchemaIdentifiers(schema as JsonObject),
    ]),
  );
}

/** A `$ref` to the component registered for `schema`; every body schema must be one. */
function componentRef(registry: ComponentRegistry, schema: z.ZodType, where: string): JsonObject {
  const meta = registry.get(schema);
  if (meta === undefined) {
    throw new Error(`The ${where} schema is not a named OpenAPI component.`);
  }
  return { $ref: `${COMPONENT_SCHEMA_PREFIX}${meta.id}` };
}

function examplesObject(examples: ExampleMap | undefined): JsonObject {
  return examples === undefined ? {} : { examples };
}

function responseObject(
  registry: ComponentRegistry,
  response: ResponseContract,
  where: string,
): JsonObject {
  const headers =
    response.headers === undefined
      ? {}
      : {
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([name, header]) => [
              name,
              {
                description: header.description,
                required: true,
                schema: withoutSchemaIdentifiers(
                  z.toJSONSchema(header.schema, { io: "output" }) as JsonObject,
                ),
                ...(header.example === undefined ? {} : { example: header.example }),
              },
            ]),
          ),
        };
  return {
    description: response.description,
    ...headers,
    content: {
      [JSON_MEDIA_TYPE]: {
        schema: componentRef(registry, response.schema, where),
        ...examplesObject(response.examples),
      },
    },
  };
}

function operationObject(
  operationId: string,
  route: RouteContract,
  requests: ComponentRegistry,
  responses: ComponentRegistry,
): JsonObject {
  const where = `${route.method.toUpperCase()} ${route.path}`;
  const requestBody =
    route.requestBody === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            description: JSON_REQUEST_DESCRIPTION,
            content: {
              [JSON_MEDIA_TYPE]: {
                schema: componentRef(requests, route.requestBody, `${where} request`),
                ...examplesObject(route.requestExamples),
              },
            },
          },
        };
  return {
    operationId,
    tags: [route.path.startsWith(`${API_PREFIX}/`) ? "Orders" : "Health"],
    summary: route.summary,
    ...(route.description === undefined ? {} : { description: route.description }),
    ...requestBody,
    responses: Object.fromEntries(
      Object.entries(route.responses).map(([status, response]) => [
        status,
        responseObject(responses, response, `${where} ${status} response`),
      ]),
    ),
  };
}

/** Components sorted by name, so the output does not depend on registration order. */
function sortedByKey<Value>(record: Readonly<Record<string, Value>>): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

/** The OpenAPI 3.1 document of every route in {@link routes}. */
export function buildOpenApiDocument(): OpenApiDocument {
  const requests = requestComponentRegistry();
  const responses = responseComponentRegistry();
  const requestSchemas = convertRegistry(requests, "input");
  const responseSchemas = convertRegistry(responses, "output");
  const shared = Object.keys(requestSchemas).filter((id) => id in responseSchemas);
  if (shared.length > 0) {
    throw new Error(`Request and response component names overlap: ${shared.join(", ")}.`);
  }

  const paths: Record<string, Record<string, JsonObject>> = {};
  for (const [operationId, route] of Object.entries(routes) as [string, RouteContract][]) {
    paths[route.path] = {
      ...paths[route.path],
      [route.method]: operationObject(operationId, route, requests, responses),
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "SCOS Ordering API",
      version: "1.0.0",
      description: API_DESCRIPTION,
    },
    servers: [{ url: "/", description: "The server that serves this document." }],
    tags: [
      { name: "Orders", description: "Order verification and submission." },
      { name: "Health", description: "Liveness." },
    ],
    paths,
    components: {
      schemas: sortedByKey({ ...requestSchemas, ...responseSchemas }),
      responses: {
        NotFound: responseObject(responses, notFoundResponse, "404 response"),
      },
    },
  };
}

/**
 * The document exactly as exported to `docs/openapi.json` and served at
 * `GET /openapi.json`: two-space indentation and a trailing newline.
 */
export function renderOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
