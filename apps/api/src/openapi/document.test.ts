import SwaggerParser from "@apidevtools/swagger-parser";
import { MAX_QUANTITY } from "@scos/core";
import type { OpenAPIV3_1 } from "openapi-types";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { SUBMISSION_ADR_URL, notFoundResponse } from "../http/route-contract";
import { warehouseIdSchema } from "../http/schemas";
import { routes } from "../routes";
import { ajvAccepts, specValidator } from "../testing/openapi.test-support";
import { SUBMISSION_ID_DESCRIPTION, requestComponentRegistry } from "./components";
import { type JsonObject, buildOpenApiDocument, renderOpenApiDocument } from "./document";

const document = buildOpenApiDocument();
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

  test("components carry no per-schema $schema, $id or brand artefacts", () => {
    for (const schema of Object.values(schemas)) {
      expect(schema).not.toHaveProperty("$schema");
      expect(schema).not.toHaveProperty("$id");
    }
    const rendered = renderOpenApiDocument();
    expect(rendered).not.toMatch(/brand|~standard/i);
  });

  test("request and response component names never overlap", () => {
    const requestNames = Object.keys(
      z.toJSONSchema(requestComponentRegistry(), { io: "input" }).schemas,
    );
    expect(requestNames.sort()).toStrictEqual([
      "Latitude",
      "Longitude",
      "Quantity",
      "SubmissionId",
      "SubmitOrderRequest",
      "VerifyOrderRequest",
    ]);
    expect(Object.keys(schemas)).toStrictEqual(Object.keys(schemas).sort());
  });

  test("is deterministic and needs no environment", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("PORT", undefined);
    try {
      expect(renderOpenApiDocument()).toBe(renderOpenApiDocument());
      expect(buildOpenApiDocument()).toStrictEqual(document);
      expect(renderOpenApiDocument()).toBe(`${JSON.stringify(document, null, 2)}\n`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
