import { Hono } from "hono";
import { resolver } from "hono-openapi";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { SPEC_CONVERSION, describeContract } from "#http/describe-route";
import { jsonBody } from "#http/json";
import type { RouteContract } from "#http/route-contract";
import { generateOpenApiDocument } from "#openapi/document";

/** A transform's output and a bigint have no JSON Schema. */
const unrepresentableOutput = z.object({ total: z.string().transform((value) => value.length) });
const unrepresentableInput = z.strictObject({ amount: z.bigint() });

function contract(overrides: Partial<RouteContract>): RouteContract {
  return {
    servedBy: "createHealthApp",
    operationId: "probe",
    method: "post",
    path: "/probe",
    summary: "Probe",
    responses: { 200: { description: "OK", schema: z.object({ ok: z.boolean() }) } },
    ...overrides,
  };
}

function appDocumenting(route: RouteContract, validated?: z.ZodType): Hono {
  const app = new Hono();
  const handler = () => new Response("{}");
  if (validated === undefined) {
    app.post(route.path, describeContract(route), handler);
  } else {
    app.post(route.path, jsonBody(validated), describeContract(route), handler);
  }
  return app;
}

describe("unrepresentable schemas fail generation instead of publishing {}", () => {
  test("the library default would publish an empty schema", async () => {
    // Why SPEC_CONVERSION exists: hono-openapi defaults to unrepresentable: "any".
    const { schema } = await resolver(unrepresentableInput).toOpenAPISchema();
    expect(schema).toMatchObject({ properties: { amount: {} } });
  });

  test("a response schema", async () => {
    const route = contract({
      responses: { 200: { description: "OK", schema: unrepresentableOutput } },
    });
    await expect(generateOpenApiDocument(appDocumenting(route))).rejects.toThrow(/transform/i);
  });

  test("a request body schema", async () => {
    const route = contract({ requestBody: unrepresentableInput });
    await expect(generateOpenApiDocument(appDocumenting(route))).rejects.toThrow(/bigint/i);
  });

  test("the validator's schema", async () => {
    await expect(
      generateOpenApiDocument(appDocumenting(contract({}), unrepresentableInput)),
    ).rejects.toThrow(/bigint/i);
  });

  test("representable schemas generate, with the throwing option in force", async () => {
    expect(SPEC_CONVERSION).toStrictEqual({ unrepresentable: "throw" });
    const route = contract({ requestBody: z.strictObject({ n: z.int() }) });
    const document = await generateOpenApiDocument(
      appDocumenting(route, z.strictObject({ n: z.int() })),
    );
    expect(document.paths["/probe"]?.post).toMatchObject({ operationId: "probe" });
  });
});
