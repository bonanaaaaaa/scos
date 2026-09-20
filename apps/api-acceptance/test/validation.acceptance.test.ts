/**
 * QA API acceptance: request validation and the 400 envelope over real HTTP.
 *
 * Every malformed request must return `400 INVALID_REQUEST` in the documented
 * envelope, change no row, and consume no submissionId: a following valid
 * submission with the same submissionId must be accepted (201).
 *
 * The run shares one served API and one database, so this file returns the
 * seed state before every test; stock is only ever changed through the
 * database, never through the API.
 *
 * @module
 */

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { openPool, readState, resetDatabase } from "#test/support/database";
import {
  type HttpResult,
  type RawRequest,
  expectErrorEnvelope,
  expectJson,
  request,
} from "#test/support/http";
import { expectedOrder } from "#test/support/oracle";
import { AT_PARIS, MAX_QUANTITY } from "#test/support/prd";
import { acceptanceDatabaseUrl, sharedApi } from "#test/support/shared-api";

const api = sharedApi();
let pool: Pool;

beforeAll(async () => {
  pool = openPool(acceptanceDatabaseUrl());
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

const json = (value: unknown): RawRequest => ({ body: JSON.stringify(value) });
const encoder = new TextEncoder();

type Case = readonly [name: string, make: (id: string) => RawRequest, issues: "present" | "absent"];

/** Malformed at the transport level: not parsed as a JSON body. */
function transportCases(): Case[] {
  return [
    ["malformed JSON", (id) => ({ body: `{"submissionId":"${id}","quantity":5,` }), "absent"],
    ["single-quoted JSON", (id) => ({ body: `{'submissionId':'${id}','quantity':5}` }), "absent"],
    [
      "NaN literal",
      (id) => ({
        body: `{"submissionId":"${id}","quantity":NaN,"latitude":49,"longitude":2}`,
      }),
      "absent",
    ],
    ["empty body", () => ({ body: "" }), "absent"],
    ["no body at all", () => ({}), "absent"],
    ["whitespace-only body", () => ({ body: "  \n " }), "absent"],
    [
      "missing Content-Type",
      (id) => ({
        body: encoder.encode(JSON.stringify({ submissionId: id, quantity: 5, ...AT_PARIS })),
        contentType: null,
      }),
      "absent",
    ],
    [
      "text/plain Content-Type",
      (id) => ({
        body: JSON.stringify({ submissionId: id, quantity: 5, ...AT_PARIS }),
        contentType: "text/plain",
      }),
      "absent",
    ],
    [
      "form Content-Type",
      (id) => ({
        body: `submissionId=${id}&quantity=5&latitude=49&longitude=2`,
        contentType: "application/x-www-form-urlencoded",
      }),
      "absent",
    ],
    [
      "application/jsonp Content-Type",
      (id) => ({
        body: JSON.stringify({ submissionId: id, quantity: 5, ...AT_PARIS }),
        contentType: "application/jsonp",
      }),
      "absent",
    ],
  ];
}

/** Well-formed JSON that fails the body schema. */
function schemaCases(endpoint: "verify" | "submit"): Case[] {
  const base = (id: string): Record<string, unknown> =>
    endpoint === "submit"
      ? { submissionId: id, quantity: 5, ...AT_PARIS }
      : { quantity: 5, ...AT_PARIS };
  const withField = (field: string, value: unknown) => (id: string) =>
    json({ ...base(id), [field]: value });
  const without = (field: string) => (id: string) => {
    const body = base(id);
    delete body[field];
    return json(body);
  };
  const rawNumber = (field: string, literal: string) => (id: string) => {
    const body = { ...base(id), [field]: "__RAW__" };
    return { body: JSON.stringify(body).replace('"__RAW__"', literal) };
  };

  const cases: Case[] = [
    ["JSON array", () => json([]), "present"],
    ["JSON array of a valid body", (id) => json([base(id)]), "present"],
    ["JSON null", () => json(null), "present"],
    ["JSON number", () => json(5), "present"],
    ["JSON string", () => json("{}"), "present"],
    ["JSON true", () => json(true), "present"],
    ["empty object", () => json({}), "present"],
    ["missing quantity", without("quantity"), "present"],
    ["missing latitude", without("latitude"), "present"],
    ["missing longitude", without("longitude"), "present"],
    ["quantity 0", withField("quantity", 0), "present"],
    ["quantity -1", withField("quantity", -1), "present"],
    ["quantity -0", rawNumber("quantity", "-0"), "present"],
    ["quantity 1.5", withField("quantity", 1.5), "present"],
    ['quantity "5"', withField("quantity", "5"), "present"],
    ["quantity MAX_QUANTITY + 1", withField("quantity", MAX_QUANTITY + 1), "present"],
    ["quantity 1e999 (Infinity)", rawNumber("quantity", "1e999"), "present"],
    ["quantity null", withField("quantity", null), "present"],
    ["quantity true", withField("quantity", true), "present"],
    ['quantity "NaN"', withField("quantity", "NaN"), "present"],
    ["latitude 90.0001", withField("latitude", 90.0001), "present"],
    ["latitude -90.0001", withField("latitude", -90.0001), "present"],
    ["latitude 1e999 (Infinity)", rawNumber("latitude", "1e999"), "present"],
    ['latitude "Infinity"', withField("latitude", "Infinity"), "present"],
    ['latitude "49.009722"', withField("latitude", "49.009722"), "present"],
    ["latitude null", withField("latitude", null), "present"],
    ["longitude 180.0001", withField("longitude", 180.0001), "present"],
    ["longitude -180.0001", withField("longitude", -180.0001), "present"],
    ['longitude "-Infinity"', withField("longitude", "-Infinity"), "present"],
    ['longitude "2.547778"', withField("longitude", "2.547778"), "present"],
    ["longitude as object", withField("longitude", { value: 2 }), "present"],
    ["unknown extra field", withField("note", "hello"), "present"],
  ];

  if (endpoint === "verify") {
    cases.push([
      "submissionId is an unknown field on verify",
      withField("submissionId", "x"),
      "present",
    ]);
  } else {
    cases.push(
      ["missing submissionId", without("submissionId"), "present"],
      ['submissionId ""', withField("submissionId", ""), "present"],
      ['submissionId "   "', withField("submissionId", "   "), "present"],
      ['submissionId "\\t"', withField("submissionId", "\t"), "present"],
      ['submissionId "\\n"', withField("submissionId", "\n"), "present"],
      ['submissionId "\\r\\n"', withField("submissionId", "\r\n"), "present"],
      ['submissionId " a"', withField("submissionId", " a"), "present"],
      ['submissionId "a "', withField("submissionId", "a "), "present"],
      ['submissionId "a\\t"', withField("submissionId", "a\t"), "present"],
      [
        'submissionId "\\u00a0a" (NBSP)',
        withField("submissionId", `${String.fromCharCode(0xa0)}a`),
        "present",
      ],
      ["submissionId 256 characters", withField("submissionId", "x".repeat(256)), "present"],
      [
        "submissionId containing NUL",
        withField("submissionId", `a${String.fromCharCode(0)}b`),
        "present",
      ],
      ["submissionId lone surrogate", withField("submissionId", "a\ud800"), "present"],
      ["submissionId number", withField("submissionId", 123), "present"],
      ["submissionId null", withField("submissionId", null), "present"],
      ["submissionId true", withField("submissionId", true), "present"],
      ["submissionId object", withField("submissionId", { id: "a" }), "present"],
      ["submissionId array", withField("submissionId", ["a"]), "present"],
    );
  }
  return cases;
}

async function expectRejectedWithoutEffect(
  path: string,
  raw: RawRequest,
  issues: "present" | "absent",
): Promise<HttpResult> {
  const before = await readState(pool);
  const response = await request(api, path, raw);
  expectErrorEnvelope(response, 400, "INVALID_REQUEST", { issues });
  expect(await readState(pool)).toStrictEqual(before);
  return response;
}

describe("POST /api/v1/orders: 400 without consuming the submissionId or changing inventory", () => {
  const cases = [...transportCases(), ...schemaCases("submit")];

  test.each(cases.map((entry, index) => [entry[0], index] as const))("%s", async (_name, index) => {
    const [, make, issues] = cases[index] ?? [];
    if (make === undefined || issues === undefined) throw new Error("missing case");
    const id = `qa-invalid-${index}`;

    await expectRejectedWithoutEffect("/api/v1/orders", make(id), issues);

    // The same submissionId is still free: a valid submission is accepted.
    const accepted = await request(
      api,
      "/api/v1/orders",
      json({ submissionId: id, quantity: 5, ...AT_PARIS }),
    );
    expect(expectJson(accepted, 201)).toStrictEqual(expectedOrder(id, 5, AT_PARIS));
  });

  test("an invalid request after acceptance neither conflicts nor changes the Order", async () => {
    const accepted = await request(
      api,
      "/api/v1/orders",
      json({ submissionId: "qa-after", quantity: 5, ...AT_PARIS }),
    );
    expectJson(accepted, 201);
    await expectRejectedWithoutEffect(
      "/api/v1/orders",
      json({ submissionId: "qa-after", quantity: 0, ...AT_PARIS }),
      "present",
    );
    const repeat = await request(
      api,
      "/api/v1/orders",
      json({ submissionId: "qa-after", quantity: 5, ...AT_PARIS }),
    );
    expect(repeat.status).toBe(201);
    expect(repeat.text).toBe(accepted.text);
  });
});

describe("POST /api/v1/orders/verify: 400", () => {
  const cases = [...transportCases(), ...schemaCases("verify")];

  test.each(cases.map((entry, index) => [entry[0], index] as const))("%s", async (_name, index) => {
    const [, make, issues] = cases[index] ?? [];
    if (make === undefined || issues === undefined) throw new Error("missing case");
    await expectRejectedWithoutEffect("/api/v1/orders/verify", make(`qa-verify-${index}`), issues);
  });
});

describe("issue paths and content types", () => {
  test("a string quantity reports path [quantity]", async () => {
    const response = await request(
      api,
      "/api/v1/orders/verify",
      json({ quantity: "5", ...AT_PARIS }),
    );
    const error = expectErrorEnvelope(response, 400, "INVALID_REQUEST", { issues: "present" });
    expect(error.issues?.map((issue) => issue.path)).toStrictEqual([["quantity"]]);
  });

  test("an unknown field reports path [] (the body itself)", async () => {
    const response = await request(
      api,
      "/api/v1/orders",
      json({ submissionId: "qa-path", quantity: 5, ...AT_PARIS, extra: 1 }),
    );
    const error = expectErrorEnvelope(response, 400, "INVALID_REQUEST", { issues: "present" });
    expect(error.issues?.map((issue) => issue.path)).toStrictEqual([[]]);
  });

  test("a whitespace submissionId reports path [submissionId]", async () => {
    const response = await request(
      api,
      "/api/v1/orders",
      json({ submissionId: "\t", quantity: 5, ...AT_PARIS }),
    );
    const error = expectErrorEnvelope(response, 400, "INVALID_REQUEST", { issues: "present" });
    expect(error.issues?.every((issue) => issue.path.join(".") === "submissionId")).toBe(true);
  });

  test.each(["application/json; charset=utf-8", "APPLICATION/JSON", "application/vnd.api+json"])(
    "Content-Type %s is accepted",
    async (contentType) => {
      const response = await request(api, "/api/v1/orders/verify", {
        body: JSON.stringify({ quantity: 5, ...AT_PARIS }),
        contentType,
      });
      expectJson(response, 200);
    },
  );
});
