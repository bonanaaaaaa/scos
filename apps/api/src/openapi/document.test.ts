import SwaggerParser from "@apidevtools/swagger-parser";
import { MAX_QUANTITY } from "@scos/core";
import { resolver } from "hono-openapi";
import type { OpenAPIV3_1 } from "openapi-types";
import { describe, expect, test, vi } from "vitest";

import { SUBMISSION_ID_DESCRIPTION } from "#endpoints/submit-order/contract";
import {
  type ResponseContract,
  type RouteContract,
  SUBMISSION_ADR_URL,
  notFoundResponse,
} from "#http/route-contract";
import { warehouseIdSchema } from "#http/schemas";
import type { JsonObject } from "#openapi/document";
import { buildOpenApiDocument, renderOpenApiDocument } from "#openapi/offline";
import { routes } from "#routes";
import { ajvAccepts, specValidator } from "#testing/openapi.test-support";

const document = await buildOpenApiDocument();
const schemas = document.components.schemas;

function operation(path: string, method: string): JsonObject {
  const found = document.paths[path]?.[method];
  if (found === undefined) {
    throw new Error(`No ${method} ${path}`);
  }
  return found;
}

describe("OpenAPI document", () => {
  test("is a valid OpenAPI 3.1 document with resolvable references", async () => {
    const api = await SwaggerParser.validate(
      structuredClone(document) as unknown as OpenAPIV3_1.Document,
    );
    expect(api).toMatchObject({ openapi: "3.1.0" });
    expect(document.servers).toStrictEqual([
      { url: "/", description: "The server that serves this document." },
    ]);
  });

  test("lists exactly the routes of the contract with every documented status", () => {
    const documented = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, value]) => [
        method,
        path,
        Object.keys(value.responses as JsonObject).map(Number),
        value.operationId,
      ]),
    );
    expect(documented).toStrictEqual(
      Object.entries(routes).map(([name, route]) => [
        route.method,
        route.path,
        Object.keys(route.responses).map(Number),
        name,
      ]),
    );
    expect(documented.map(([, path]) => path)).not.toContain("/docs");
    expect(documented.map(([, path]) => path)).not.toContain("/openapi.json");
  });

  test("request bodies reference named components with the runtime limits", () => {
    for (const [path, name] of [
      ["/api/v1/orders/verify", "VerifyOrderRequest"],
      ["/api/v1/orders", "SubmitOrderRequest"],
    ] as const) {
      expect(operation(path, "post").requestBody).toMatchObject({
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
      });
      expect(schemas[name]).toMatchObject({ type: "object", additionalProperties: false });
    }
    expect(schemas.SubmitOrderRequest?.required).toStrictEqual([
      "submissionId",
      "quantity",
      "latitude",
      "longitude",
    ]);
    expect(schemas.VerifyOrderRequest?.required).toStrictEqual([
      "quantity",
      "latitude",
      "longitude",
    ]);
    expect(schemas.Quantity).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
      maximum: MAX_QUANTITY,
    });
    expect(schemas.Latitude).toMatchObject({ type: "number", minimum: -90, maximum: 90 });
    expect(schemas.Longitude).toMatchObject({ type: "number", minimum: -180, maximum: 180 });
    expect(schemas.SubmissionId).toMatchObject({ type: "string", minLength: 1, maxLength: 255 });
    expect(schemas.SubmissionId).not.toHaveProperty("format");
  });

  test("documents in prose what JSON Schema cannot express", () => {
    expect(schemas.SubmissionId?.description).toBe(SUBMISSION_ID_DESCRIPTION);
    for (const rule of [
      "not have to be a UUID",
      "code points",
      "whitespace",
      "U+0000",
      "surrogates",
    ]) {
      expect(SUBMISSION_ID_DESCRIPTION).toContain(rule);
    }
    const body = operation("/api/v1/orders", "post").requestBody as JsonObject;
    expect(body.description).toContain("Content-Type: application/json");
    expect(body.description).toContain("never coerced");
    expect(body.description).toContain("Unknown fields are rejected");
    expect(schemas.Money?.description).toContain('"150.00"');
    expect(schemas.InsufficientStockEstimate?.description).toContain("null");
    expect(schemas.WarehouseId).toMatchObject({ type: "string", format: "uuid" });
    expect(schemas.WarehouseId?.description).toContain("UUIDv7");
    expect(schemas.WarehouseId?.description).toContain("opaque");
    expect(document.info.description).toContain("freshly seeded database");
    expect(document.info.description).toContain("Every non-2xx body has an `error` object");
    expect(schemas.ErrorResponse?.description).toContain("RejectedSubmission");
  });

  test("explains submissionId retention and retries, linking ADR 0004", () => {
    const description = operation("/api/v1/orders", "post").description as string;
    expect(description).toContain("keeps its submissionId indefinitely");
    const notStored = description.split("\n").filter((line) => line.includes("not stored"));
    expect(notStored).toHaveLength(1);
    for (const status of ["`400`", "`422`", "`503`"]) {
      expect(notStored[0]).toContain(status);
    }
    // A 500 may follow a commit: it must never be listed as "not stored".
    expect(notStored[0]).not.toContain("500");
    expect(notStored[0]).toContain("not stored and consume no key");
    expect(description).toContain("can be retried with the same submissionId");
    expect(description).toContain("409 SUBMISSION_ID_CONFLICT");
    // A 500 may follow a commit; the description must not promise otherwise.
    expect(description).toContain("A `500` means the outcome is unknown");
    expect(description).toContain(SUBMISSION_ADR_URL);
    expect(document.info.description).toContain(SUBMISSION_ADR_URL);
  });

  test("insufficient-stock estimates have null totals and no allocations", () => {
    expect(schemas.InsufficientStockEstimate).toMatchObject({
      properties: {
        shippingCost: { type: "null" },
        orderTotal: { type: "null" },
        allocations: { type: "array", maxItems: 0 },
      },
    });
    expect(schemas.OrderEstimate?.anyOf).toStrictEqual([
      { $ref: "#/components/schemas/ValidEstimate" },
      { $ref: "#/components/schemas/ShippingExceedsLimitEstimate" },
      { $ref: "#/components/schemas/InsufficientStockEstimate" },
    ]);
  });

  test("503 documents Retry-After and 404 is a reusable response", () => {
    const unavailable = (operation("/api/v1/orders", "post").responses as JsonObject)[
      "503"
    ] as JsonObject;
    expect(unavailable.headers).toMatchObject({
      "Retry-After": { required: true, schema: { type: "integer", minimum: 1 }, example: 1 },
    });
    expect(document.components.responses.NotFound).toMatchObject({
      description: notFoundResponse.description,
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
    });
  });

  test("WarehouseId accepts any canonical UUID form, like the PostgreSQL uuid column", () => {
    const warehouseId = specValidator(document).component("WarehouseId");
    // Version 1 with a non-RFC variant nibble: stored by PostgreSQL, rejected by z.uuid().
    for (const id of [
      "12345678-1234-1234-1234-123456789abc",
      "01996000-0000-7000-8000-000000000005",
    ]) {
      expect(warehouseIdSchema.safeParse(id).success, id).toBe(true);
      expect(ajvAccepts(warehouseId, id), id).toBe(true);
    }
    for (const id of ["not-a-uuid", "12345678123412341234123456789abc", ""]) {
      expect(warehouseIdSchema.safeParse(id).success, id).toBe(false);
      expect(ajvAccepts(warehouseId, id), id).toBe(false);
    }
  });

  test("the error envelope matches runtime error bodies and rejects others", () => {
    const validator = specValidator(document);
    const envelope = validator.component("ErrorResponse");
    expect(ajvAccepts(envelope, { error: { code: "NOT_FOUND", message: "x" } })).toBe(true);
    expect(
      ajvAccepts(envelope, {
        error: {
          code: "INVALID_REQUEST",
          message: "x",
          issues: [{ path: ["a", 0], message: "m" }],
        },
      }),
    ).toBe(true);
    for (const invalid of [
      { error: { code: "TEAPOT", message: "x" } },
      { error: { code: "NOT_FOUND" } },
      { error: { code: "NOT_FOUND", message: "x", stack: "..." } },
      { error: { code: "NOT_FOUND", message: "x" }, extra: 1 },
      {
        error: { code: "INVALID_REQUEST", message: "x", issues: [{ path: [true], message: "m" }] },
      },
    ]) {
      expect(ajvAccepts(envelope, invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  test("no schema anywhere is empty (an unrepresentable schema published as {})", () => {
    const empty: string[] = [];
    let checked = 0;
    const schemaPositions = new Set(["schema", "items", "additionalProperties", "not"]);
    const schemaMaps = new Set(["properties", "patternProperties", "$defs"]);
    const schemaLists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
    const visitSchema = (value: unknown, path: string) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return;
      }
      checked += 1;
      if (Object.keys(value).length === 0) {
        empty.push(path);
      }
      walk(value as JsonObject, path);
    };
    function walk(node: JsonObject, path: string) {
      for (const [key, value] of Object.entries(node)) {
        // Example values are data, not schemas.
        if (key === "examples" || key === "example") {
          continue;
        }
        const at = `${path}/${key}`;
        if (schemaPositions.has(key)) {
          visitSchema(value, at);
        } else if (schemaMaps.has(key) && value !== null && typeof value === "object") {
          for (const [name, schema] of Object.entries(value)) {
            visitSchema(schema, `${at}/${name}`);
          }
        } else if (schemaLists.has(key) && Array.isArray(value)) {
          value.forEach((schema, index) => visitSchema(schema, `${at}/${index}`));
        } else if (value !== null && typeof value === "object") {
          walk(value as JsonObject, at);
        }
      }
    }
    for (const [name, schema] of Object.entries(schemas)) {
      visitSchema(schema, `#/components/schemas/${name}`);
    }
    walk({ paths: document.paths, responses: document.components.responses }, "#");
    expect(empty).toStrictEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  test("every request and response body is a $ref to a named component", () => {
    for (const route of Object.values(routes) as RouteContract[]) {
      const found = operation(route.path, route.method);
      const bodies: [string, JsonObject][] = Object.entries(
        found.responses as Record<string, JsonObject>,
      ).map(([status, response]) => [status, response]);
      if (route.requestBody !== undefined) {
        bodies.push(["request", found.requestBody as JsonObject]);
      }
      expect(bodies.map(([status]) => status)).toStrictEqual([
        ...Object.keys(route.responses),
        ...(route.requestBody === undefined ? [] : ["request"]),
      ]);
      for (const [status, body] of bodies) {
        const schema = (body.content as Record<string, JsonObject>)["application/json"]?.schema;
        expect(schema, `${route.operationId} ${status}`).toStrictEqual({
          $ref: expect.stringMatching(/^#\/components\/schemas\/[A-Za-z]+$/),
        });
        const name =
          String((schema as JsonObject).$ref)
            .split("/")
            .pop() ?? "";
        expect(schemas, `${route.operationId} ${status}`).toHaveProperty(name);
      }
    }
  });

  test("components carry no per-schema $schema, $id or brand artefacts", async () => {
    for (const schema of Object.values(schemas)) {
      expect(schema).not.toHaveProperty("$schema");
      expect(schema).not.toHaveProperty("$id");
    }
    const rendered = await renderOpenApiDocument();
    expect(rendered).not.toMatch(/brand|~standard/i);
  });

  test("every named component is the same whether reached from a request or a response", async () => {
    // A Zod id shared by an input and an output schema would be merged into one
    // component; each schema is resolved alone, in its own io mode, and every
    // component it yields must equal the published one.
    const resolved = new Map<string, unknown>();
    const collect = async (result: { components?: { schemas?: object } | undefined }) => {
      for (const [name, schema] of Object.entries(result.components?.schemas ?? {})) {
        expect(schemas[name], name).toStrictEqual(schema);
        resolved.set(name, schema);
      }
    };
    for (const route of Object.values(routes) as RouteContract[]) {
      if (route.requestBody !== undefined) {
        await collect(await resolver(route.requestBody).toOpenAPISchema());
      }
      for (const response of Object.values(route.responses) as ResponseContract[]) {
        await collect(
          await resolver(response.schema, { options: { io: "output" } }).toOpenAPISchema(),
        );
      }
    }
    expect([...resolved.keys()].sort()).toStrictEqual(Object.keys(schemas).sort());
    expect(Object.keys(schemas).sort()).toStrictEqual([
      "Destination",
      "DiscountRate",
      "ErrorBody",
      "ErrorCode",
      "ErrorIssue",
      "ErrorResponse",
      "EstimateAllocation",
      "HealthResponse",
      "InsufficientStockEstimate",
      "Latitude",
      "Longitude",
      "Money",
      "Order",
      "OrderAllocation",
      "OrderEstimate",
      "Quantity",
      "RejectedSubmission",
      "ShippingExceedsLimitEstimate",
      "SubmissionId",
      "SubmitOrderRequest",
      "ValidEstimate",
      "VerifyOrderRequest",
      "WarehouseId",
    ]);
  });

  test("is deterministic, including key order, and needs no environment", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("PORT", undefined);
    try {
      expect(await renderOpenApiDocument()).toBe(await renderOpenApiDocument());
      expect(await buildOpenApiDocument()).toStrictEqual(document);
      expect(await renderOpenApiDocument()).toBe(`${JSON.stringify(document, null, 2)}\n`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
