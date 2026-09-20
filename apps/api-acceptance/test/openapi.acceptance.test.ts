/**
 * QA API acceptance: the served OpenAPI document and Swagger UI, over real
 * HTTP against the real seeded PostgreSQL.
 *
 * The document is treated as a black box: every schema used here is looked up
 * in the document served at `GET /openapi.json` (with `$ref`s resolved by
 * swagger-parser) and compiled with Ajv's JSON Schema 2020-12 dialect, the
 * OpenAPI 3.1 dialect. Nothing is taken from the Zod contracts. Real
 * responses are then validated against the schema the document declares for
 * their path, method and status, and the documented request examples are sent
 * to the server to show they produce the documented outcome.
 *
 * This app never imports API source, so the served document is pinned to the
 * built `apps/api/dist/openapi.json` artifact — the file a deployment ships.
 * The developer suite owns the matching "served document is
 * `renderOpenApiDocument()`" and "standalone endpoint apps serve no
 * documentation" checks, in `apps/api/src/openapi/docs-app.test.ts`.
 *
 * @module
 */

import { readFile } from "node:fs/promises";

import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormatsModule from "ajv-formats";
import type { OpenAPI } from "openapi-types";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { type ApiProcess, spawnApi, stopAllApiProcesses } from "./support/api-process";
import {
  openPool,
  readState,
  resetDatabase,
  setAllStock,
  setStock,
  stockById,
} from "./support/database";
import { openApiArtifact } from "./support/environment";
import {
  type ApiUnderTest,
  type HttpResult,
  expectErrorEnvelope,
  expectJson,
  get,
  postJson,
  request,
} from "./support/http";
import {
  AT_PARIS,
  FAR_AWAY,
  MANHATTAN,
  MAX_QUANTITY,
  ORDER_NUMBER,
  TOTAL_STOCK,
  WAREHOUSES,
  warehouse,
} from "./support/prd";
import { acceptanceDatabaseUrl, sharedApi } from "./support/shared-api";

// ajv-formats is CommonJS; its default export arrives wrapped under ESM.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as typeof addFormatsModule;

const VERIFY = "/api/v1/orders/verify";
const SUBMIT = "/api/v1/orders";
const HEALTH = "/health";

// ---------------------------------------------------------------------------
// JSON navigation (the document is untyped JSON to these tests)
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Follows `path` through nested objects, failing loudly if any step is missing. */
function dig(value: unknown, ...path: string[]): JsonRecord {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      throw new Error(`The served document has no ${path.join(" > ")} (missing "${key}")`);
    }
    current = current[key];
  }
  if (!isRecord(current)) {
    throw new Error(`${path.join(" > ")} is not an object`);
  }
  return current;
}

// ---------------------------------------------------------------------------
// The served document, resolved and compiled with Ajv 2020
// ---------------------------------------------------------------------------

interface ServedSpec {
  /** Exactly what `GET /openapi.json` returned, parsed. */
  readonly raw: JsonRecord;
  /** A copy with every `$ref` resolved (swagger-parser). */
  readonly resolved: JsonRecord;
  /** Compiles (and caches) a schema object taken from `resolved`. */
  compile(schema: JsonRecord): ValidateFunction;
}

async function loadServedSpec(target: ApiUnderTest): Promise<ServedSpec> {
  const response = await get(target, "/openapi.json");
  expect(response.status, response.text).toBe(200);
  const raw = response.json() as JsonRecord;
  const resolved = (await SwaggerParser.dereference(
    structuredClone(raw) as unknown as OpenAPI.Document,
  )) as unknown as JsonRecord;
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const cache = new Map<JsonRecord, ValidateFunction>();
  return {
    raw,
    resolved,
    compile(schema) {
      let validate = cache.get(schema);
      if (validate === undefined) {
        validate = ajv.compile(schema);
        cache.set(schema, validate);
      }
      return validate;
    },
  };
}

type Method = "get" | "post";

function operation(spec: ServedSpec, path: string, method: Method): JsonRecord {
  return dig(spec.resolved, "paths", path, method);
}

function requestSchema(spec: ServedSpec, path: string): ValidateFunction {
  return spec.compile(
    dig(operation(spec, path, "post"), "requestBody", "content", "application/json", "schema"),
  );
}

function describeErrors(validate: ValidateFunction): string {
  return JSON.stringify(validate.errors ?? [], null, 2);
}

/**
 * Asserts the real response matches what the served document declares for
 * `method path` and the response's own status: the status is documented, the
 * body is JSON matching that status's schema, and every required response
 * header is present and matches its schema. `responseObject` overrides the
 * lookup (for 404, which the document declares once as a component).
 */
function expectConforms(
  spec: ServedSpec,
  path: string,
  method: Method,
  result: HttpResult,
  responseObject?: JsonRecord,
): unknown {
  const responses = dig(operation(spec, path, method), "responses");
  const documented = responseObject ?? responses[String(result.status)];
  expect(
    isRecord(documented),
    `${method.toUpperCase()} ${path} returned ${result.status}, which the document does not list (${Object.keys(responses).join(", ")}): ${result.text}`,
  ).toBe(true);
  const response = documented as JsonRecord;

  const content = dig(response, "content");
  expect(Object.keys(content)).toStrictEqual(["application/json"]);
  expect(result.contentType).toMatch(/^application\/json(\s*;\s*charset=utf-8)?$/i);

  const body = result.json();
  const validate = spec.compile(dig(content, "application/json", "schema"));
  expect(validate(body), `${result.status} body ${result.text}\n${describeErrors(validate)}`).toBe(
    true,
  );

  const headers = isRecord(response.headers) ? response.headers : {};
  for (const [name, header] of Object.entries(headers)) {
    if (!isRecord(header) || header.required !== true) {
      continue;
    }
    const value = result.headers.get(name);
    expect(value, `required header ${name}`).not.toBeNull();
    const headerSchema = dig(header, "schema");
    const typed =
      headerSchema.type === "integer" || headerSchema.type === "number" ? Number(value) : value;
    const validateHeader = spec.compile(headerSchema);
    expect(validateHeader(typed), `${name}: ${value}\n${describeErrors(validateHeader)}`).toBe(
      true,
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const api = sharedApi();
let pool: Pool;
let spec: ServedSpec;

beforeAll(async () => {
  pool = openPool(acceptanceDatabaseUrl());
  await resetDatabase(pool);
  spec = await loadServedSpec(api);
});

afterAll(async () => {
  // No API process this file started may outlive the run.
  await stopAllApiProcesses();
  await pool.end();
});

const verify = (body: unknown) => postJson(api, VERIFY, body);
const submit = (body: unknown) => postJson(api, SUBMIT, body);

describe("GET /openapi.json", () => {
  test("200 JSON, OpenAPI 3.1.x, valid per swagger-parser", async () => {
    const response = await get(api, "/openapi.json");
    const document = expectJson(response, 200) as JsonRecord;
    expect(document.openapi).toMatch(/^3\.1\.\d+$/);
    // validate() dereferences in place, so give it a copy.
    await expect(
      SwaggerParser.validate(structuredClone(document) as unknown as OpenAPI.Document),
    ).resolves.toBeDefined();
  });

  test("is exactly the build artifact dist/openapi.json", async () => {
    // The global setup refuses to run without this file, which `pnpm --filter
    // @scos/api build` writes; it is the artifact a deployment ships.
    const artifact = await readFile(openApiArtifact, "utf8");
    const served = await get(api, "/openapi.json");
    expect(served.text).toBe(artifact);
  });

  test("is stable across requests", async () => {
    const first = await get(api, "/openapi.json");
    const second = await get(api, "/openapi.json");
    expect(second.text).toBe(first.text);
  });

  test("documents exactly the three operations and their statuses", () => {
    const paths = dig(spec.raw, "paths");
    const operations = Object.fromEntries(
      Object.entries(paths).map(([path, item]) => [
        path,
        Object.fromEntries(
          Object.entries(item as JsonRecord)
            .filter(([key]) =>
              ["get", "put", "post", "delete", "patch", "head", "options", "trace"].includes(key),
            )
            .map(([method, op]) => [method, Object.keys(dig(op, "responses")).sort()]),
        ),
      ]),
    );
    expect(operations).toStrictEqual({
      [HEALTH]: { get: ["200"] },
      [VERIFY]: { post: ["200", "400", "500"] },
      [SUBMIT]: { post: ["201", "400", "409", "422", "500", "503"] },
    });
    // The documentation routes are not operations of the API.
    expect(Object.keys(paths)).not.toContain("/openapi.json");
    expect(Object.keys(paths)).not.toContain("/docs");
  });
});

describe("response conformance: real responses against the served schemas", () => {
  beforeEach(async () => {
    await resetDatabase(pool);
  });

  test("health 200", async () => {
    const body = expectConforms(spec, HEALTH, "get", await get(api, HEALTH));
    expect(body).toStrictEqual({ status: "ok" });
  });

  test("verify 200: valid, INSUFFICIENT_STOCK and SHIPPING_EXCEEDS_LIMIT", async () => {
    const valid = expectConforms(
      spec,
      VERIFY,
      "post",
      await verify({ quantity: 30, ...MANHATTAN }),
    );
    expect(valid).toMatchObject({ valid: true, reason: null });

    const short = expectConforms(
      spec,
      VERIFY,
      "post",
      await verify({ quantity: TOTAL_STOCK + 1, ...AT_PARIS }),
    );
    expect(short).toMatchObject({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });

    const far = expectConforms(spec, VERIFY, "post", await verify({ quantity: 1, ...FAR_AWAY }));
    expect(far).toMatchObject({ valid: false, reason: "SHIPPING_EXCEEDS_LIMIT" });
  });

  test.each([
    ["malformed JSON", { body: '{"quantity": 1,' }],
    [
      "wrong content type",
      { body: '{"quantity":1,"latitude":0,"longitude":0}', contentType: "text/plain" },
    ],
    ["no content type", { body: '{"quantity":1,"latitude":0,"longitude":0}', contentType: null }],
    ["an unknown field", { body: JSON.stringify({ quantity: 1, ...AT_PARIS, giftWrap: true }) }],
    [
      "an out-of-range value",
      { body: JSON.stringify({ quantity: 1, latitude: 90.5, longitude: 0 }) },
    ],
  ] as const)("verify 400: %s", async (_case, raw) => {
    const response = await request(api, VERIFY, raw);
    expect(response.status).toBe(400);
    expectConforms(spec, VERIFY, "post", response);
    expectErrorEnvelope(response, 400, "INVALID_REQUEST");
  });

  test("submit 201 accepted, then a byte-identical replay with no second deduction", async () => {
    const order = { submissionId: "qa-openapi-accept", quantity: 40, ...MANHATTAN };
    const first = await submit(order);
    expect(first.status, first.text).toBe(201);
    expectConforms(spec, SUBMIT, "post", first);
    const afterFirst = await stockById(pool);
    expect(afterFirst[warehouse("New York").id]).toBe(578 - 40);
    const stateAfterFirst = await readState(pool);

    const replay = await submit(order);
    expect(replay.status, replay.text).toBe(201);
    expectConforms(spec, SUBMIT, "post", replay);
    expect(replay.text).toBe(first.text);
    expect(await readState(pool)).toStrictEqual(stateAfterFirst);
  });

  test("submit 409: the same submissionId with a different quantity", async () => {
    const accepted = await submit({ submissionId: "qa-openapi-409", quantity: 2, ...AT_PARIS });
    expect(accepted.status).toBe(201);
    const conflict = await submit({ submissionId: "qa-openapi-409", quantity: 3, ...AT_PARIS });
    expect(conflict.status).toBe(409);
    expectConforms(spec, SUBMIT, "post", conflict);
    expectErrorEnvelope(conflict, 409, "SUBMISSION_ID_CONFLICT", { issues: "absent" });
  });

  test("submit 422 INSUFFICIENT_STOCK, then the same request is re-evaluated after restocking", async () => {
    // Only 3 units left anywhere, all in Paris.
    await setAllStock(pool, { [warehouse("Paris").id]: 3 });
    const order = { submissionId: "qa-openapi-short", quantity: 5, ...AT_PARIS };
    const rejected = await submit(order);
    expect(rejected.status).toBe(422);
    const body = expectConforms(spec, SUBMIT, "post", rejected) as JsonRecord;
    expect(dig(body, "error").code).toBe("INSUFFICIENT_STOCK");
    expect(dig(body, "estimate")).toMatchObject({ shippingCost: null, orderTotal: null });

    // Nothing was stored, so the key is free and the identical request is evaluated afresh.
    await setStock(pool, { [warehouse("Paris").id]: 5 });
    const retried = await submit(order);
    expect(retried.status, retried.text).toBe(201);
    expectConforms(spec, SUBMIT, "post", retried);
  });

  test("submit 422 SHIPPING_EXCEEDS_LIMIT, then a retry with the same submissionId is accepted", async () => {
    const rejected = await submit({ submissionId: "qa-openapi-far", quantity: 1, ...FAR_AWAY });
    expect(rejected.status).toBe(422);
    const body = expectConforms(spec, SUBMIT, "post", rejected) as JsonRecord;
    expect(dig(body, "error").code).toBe("SHIPPING_EXCEEDS_LIMIT");

    const again = await submit({ submissionId: "qa-openapi-far", quantity: 1, ...FAR_AWAY });
    expect(again.status).toBe(422);
    expect(again.text).toBe(rejected.text);

    const retried = await submit({ submissionId: "qa-openapi-far", quantity: 1, ...AT_PARIS });
    expect(retried.status, retried.text).toBe(201);
    expectConforms(spec, SUBMIT, "post", retried);
  });

  test.each([
    ["malformed JSON", { body: "not json" }],
    ["wrong content type", { body: "{}", contentType: "application/x-www-form-urlencoded" }],
    ["a missing submissionId", { body: JSON.stringify({ quantity: 1, ...AT_PARIS }) }],
    [
      "a zero quantity",
      { body: JSON.stringify({ submissionId: "qa-400", quantity: 0, ...AT_PARIS }) },
    ],
    [
      "an unknown field",
      { body: JSON.stringify({ submissionId: "qa-400", quantity: 1, ...AT_PARIS, x: 1 }) },
    ],
  ] as const)("submit 400: %s, nothing stored", async (_case, raw) => {
    const before = await readState(pool);
    const response = await request(api, SUBMIT, raw);
    expect(response.status).toBe(400);
    expectConforms(spec, SUBMIT, "post", response);
    expectErrorEnvelope(response, 400, "INVALID_REQUEST");
    expect(await readState(pool)).toStrictEqual(before);
  });

  test.each([
    ["GET", "/"],
    ["GET", "/orders"],
    ["POST", "/orders"],
    ["GET", SUBMIT],
    ["DELETE", SUBMIT],
    ["POST", HEALTH],
    ["POST", "/openapi.json"],
    ["POST", "/docs"],
  ])("404 for %s %s matches components.responses.NotFound", async (method, path) => {
    const hasBody = method === "POST";
    const response = await request(api, path, {
      method,
      contentType: hasBody ? "application/json" : null,
      ...(hasBody ? { body: "{}" } : {}),
    });
    expect(response.status).toBe(404);
    const notFound = dig(spec.resolved, "components", "responses", "NotFound");
    // Any operation will do as the lookup context: the override supplies the response.
    expectConforms(spec, HEALTH, "get", response, notFound);
    expectErrorEnvelope(response, 404, "NOT_FOUND", { issues: "absent" });
  });

  describe("database unreachable: 500/503 as documented", () => {
    let downApi: ApiProcess;

    beforeAll(async () => {
      // A server of its own, from the same built artifact: the shared one must
      // keep its working database. Port 1 refuses connections at once.
      downApi = await spawnApi({
        databaseUrl: "postgresql://qa_user:qa-secret-password@127.0.0.1:1/scos_unreachable",
      });
    });

    afterAll(async () => {
      await downApi?.stop();
    });

    test("verify and submit failures match their documented status, schema and headers", async () => {
      const verifyDown = await postJson(downApi, VERIFY, { quantity: 1, ...AT_PARIS });
      expect([500, 503]).toContain(verifyDown.status);
      expectConforms(spec, VERIFY, "post", verifyDown);

      const submitDown = await postJson(downApi, SUBMIT, {
        submissionId: "qa-openapi-down",
        quantity: 1,
        ...AT_PARIS,
      });
      expect([500, 503]).toContain(submitDown.status);
      expectConforms(spec, SUBMIT, "post", submitDown);
    });
  });
});

describe("documented examples are usable against a freshly seeded database", () => {
  interface Example {
    readonly name: string;
    readonly value: unknown;
    /** The status whose response examples share this example's name. */
    readonly status: number;
    readonly response: unknown;
  }

  /** Pairs each request example with the response example of the same name. */
  function examples(path: string): Example[] {
    const op = dig(spec.raw, "paths", path, "post");
    const requestExamples = dig(op, "requestBody", "content", "application/json", "examples");
    const responses = dig(op, "responses");
    return Object.entries(requestExamples).map(([name, example]) => {
      const matches = Object.entries(responses).filter(([, response]) => {
        const responseExamples = (response as JsonRecord).content;
        return (
          isRecord(responseExamples) &&
          isRecord(responseExamples["application/json"]) &&
          isRecord(responseExamples["application/json"].examples) &&
          name in responseExamples["application/json"].examples
        );
      });
      expect(
        matches.map(([status]) => status),
        `request example "${name}" should document exactly one outcome`,
      ).toHaveLength(1);
      const [status, response] = matches[0] as [string, JsonRecord];
      expect((example as JsonRecord).value, `request example "${name}" value`).toBeDefined();
      return {
        name,
        value: (example as JsonRecord).value,
        status: Number(status),
        response: dig(response, "content", "application/json", "examples", name).value,
      };
    });
  }

  /** The documented response example, with the random orderNumber compared by pattern. */
  function expectedBody(example: Example): unknown {
    if (isRecord(example.response) && typeof example.response.orderNumber === "string") {
      expect(example.response.orderNumber).toMatch(ORDER_NUMBER);
      return { ...example.response, orderNumber: expect.stringMatching(ORDER_NUMBER) };
    }
    return example.response;
  }

  beforeAll(async () => {
    await resetDatabase(pool);
  });

  test("the verify examples", async () => {
    const all = examples(VERIFY);
    expect(all.map(({ name }) => name).sort()).toStrictEqual(
      ["insufficientStock", "malformed", "shippingExceedsLimit", "validEstimate"].sort(),
    );
    for (const example of all) {
      const response = await verify(example.value);
      expect(response.status, `${example.name}: ${response.text}`).toBe(example.status);
      expectConforms(spec, VERIFY, "post", response);
      expect(response.json(), example.name).toStrictEqual(expectedBody(example));
    }
  });

  test("the submit examples, acceptance first so the repeat and conflict follow it", async () => {
    await resetDatabase(pool);
    const all = new Map(examples(SUBMIT).map((example) => [example.name, example]));
    const order = [
      "accepted",
      "repeated",
      "changedInput",
      "insufficientStock",
      "shippingExceedsLimit",
      "malformed",
    ];
    expect([...all.keys()].sort()).toStrictEqual([...order].sort());

    const results = new Map<string, HttpResult>();
    const stockAfter = new Map<string, Record<string, number>>();
    for (const name of order) {
      const example = all.get(name) as Example;
      const response = await submit(example.value);
      results.set(name, response);
      stockAfter.set(name, await stockById(pool));
      expect(response.status, `${name}: ${response.text}`).toBe(example.status);
      expectConforms(spec, SUBMIT, "post", response);
      expect(response.json(), name).toStrictEqual(expectedBody(example));
    }

    // The repeat is the original Order, byte for byte, and deducts nothing.
    expect(results.get("repeated")?.text).toBe(results.get("accepted")?.text);
    expect(stockAfter.get("repeated")).toStrictEqual(stockAfter.get("accepted"));
    const seeded = Object.fromEntries(WAREHOUSES.map(({ id, stock }) => [id, stock]));
    expect(stockAfter.get("malformed")).toStrictEqual({
      ...seeded,
      [warehouse("Warsaw").id]: 245 - 150,
    });
  });
});

describe("request constraints in the spec match the server at the boundaries", () => {
  beforeAll(async () => {
    await resetDatabase(pool);
  });

  const ULP_90 = 2 ** -46;
  const ULP_180 = 2 ** -45;
  const base = { quantity: 1, ...AT_PARIS };

  const cases: [string, JsonRecord, boolean][] = [
    ["quantity 1", { ...base, quantity: 1 }, true],
    ["quantity MAX_QUANTITY", { ...base, quantity: MAX_QUANTITY }, true],
    ["quantity 0", { ...base, quantity: 0 }, false],
    ["quantity -1", { ...base, quantity: -1 }, false],
    ["quantity MAX_QUANTITY + 1", { ...base, quantity: MAX_QUANTITY + 1 }, false],
    ["quantity 1.5", { ...base, quantity: 1.5 }, false],
    ['quantity "1"', { ...base, quantity: "1" }, false],
    ["latitude 90", { ...base, latitude: 90 }, true],
    ["latitude -90", { ...base, latitude: -90 }, true],
    ["latitude 90.000001", { ...base, latitude: 90.000001 }, false],
    ["latitude 90 + 1 ulp", { ...base, latitude: 90 + ULP_90 }, false],
    ["latitude -90.000001", { ...base, latitude: -90.000001 }, false],
    ["latitude -90 - 1 ulp", { ...base, latitude: -90 - ULP_90 }, false],
    ["longitude 180", { ...base, longitude: 180 }, true],
    ["longitude -180", { ...base, longitude: -180 }, true],
    ["longitude 180.000001", { ...base, longitude: 180.000001 }, false],
    ["longitude 180 + 1 ulp", { ...base, longitude: 180 + ULP_180 }, false],
    ["longitude -180.000001", { ...base, longitude: -180.000001 }, false],
    ["longitude -180 - 1 ulp", { ...base, longitude: -180 - ULP_180 }, false],
  ];

  test.each(cases)("verify, %s", async (_case, body, accepted) => {
    const validate = requestSchema(spec, VERIFY);
    const specAccepts = validate(body) === true;
    const response = await verify(body);
    expect(specAccepts, "spec verdict").toBe(accepted);
    expect(response.status !== 400, `server verdict (${response.status}): ${response.text}`).toBe(
      specAccepts,
    );
    expectConforms(spec, VERIFY, "post", response);
  });

  test.each([
    ...cases,
    ["submissionId of 1 character", { ...base, submissionId: "a" }, true],
    ["submissionId of 255 characters", { ...base, submissionId: "b".repeat(255) }, true],
    ["submissionId of 255 astral code points", { ...base, submissionId: "😀".repeat(255) }, true],
    ["empty submissionId", { ...base, submissionId: "" }, false],
    ["submissionId of 256 characters", { ...base, submissionId: "c".repeat(256) }, false],
    ["submissionId of 256 astral code points", { ...base, submissionId: "😀".repeat(256) }, false],
  ] as [string, JsonRecord, boolean][])("submit, %s", async (name, body, accepted) => {
    const withKey = { submissionId: `qa-boundary ${name}`, ...body };
    const validate = requestSchema(spec, SUBMIT);
    const specAccepts = validate(withKey) === true;
    const response = await submit(withKey);
    expect(specAccepts, "spec verdict").toBe(accepted);
    expect(response.status !== 400, `server verdict (${response.status}): ${response.text}`).toBe(
      specAccepts,
    );
    expectConforms(spec, SUBMIT, "post", response);
  });
});

describe("GET /docs", () => {
  test("200 text/html booting Swagger UI on /openapi.json", async () => {
    const response = await get(api, "/docs");
    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^text\/html/i);
    const html = response.text;
    expect(html).toMatch(/<html/i);
    expect(html).toContain('id="swagger-ui"');
    expect(html).toMatch(/<script[^>]+src="[^"]*swagger-ui-bundle\.js"/);
    expect(html).toMatch(/<link[^>]+href="[^"]*swagger-ui\.css"/);
    expect(html).toMatch(/SwaggerUIBundle\(\{[\s\S]*url:\s*['"]\/openapi\.json['"]/);
    expect(html).toContain("dom_id: '#swagger-ui'");
  });

  test("the URL the page loads is the served document", async () => {
    const html = (await get(api, "/docs")).text;
    const url = /url:\s*['"]([^'"]+)['"]/.exec(html)?.[1];
    expect(url).toBe("/openapi.json");
    const loaded = await get(api, url as string);
    expect(loaded.json()).toStrictEqual(spec.raw);
  });
});
