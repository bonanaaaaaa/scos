/**
 * The generated request schemas against runtime behaviour: each case is
 * checked with Ajv on the published JSON Schema, with the Zod schema the
 * endpoint validates with, and through the combined app. They agree except
 * for the submissionId rules the document states in prose.
 */

import { MAX_QUANTITY } from "@scos/core";
import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { createApp } from "#app";
import {
  SUBMISSION_ID_DESCRIPTION,
  submitOrderRequestSchema,
} from "#endpoints/submit-order/contract";
import { verifyOrderRequestSchema } from "#endpoints/verify-order/contract";
import { buildOpenApiDocument } from "#openapi/offline";
import { fakeLogger, post } from "#testing/fixtures.test-support";
import { ajvAccepts, specValidator } from "#testing/openapi.test-support";

const validator = specValidator(await buildOpenApiDocument());

/** Any well-formed request reaches the use case; these answer 200 and 201. */
const app = createApp({
  verifyOrder: async () => {
    throw new Error("unused");
  },
  submitOrder: async () => ({ kind: "conflict", submissionKey: "k" as never }),
  logger: fakeLogger(),
});

const verifyBody = { quantity: 10, latitude: 13.75, longitude: 100.5 };
const submitBody = { submissionId: "order-1", ...verifyBody };

function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));
}

type Case = readonly [name: string, body: unknown, accepted: boolean];

const fieldCases = (base: Record<string, unknown>): Case[] => [
  ["well-formed", base, true],
  ["quantity 1", { ...base, quantity: 1 }, true],
  ["quantity MAX_QUANTITY", { ...base, quantity: MAX_QUANTITY }, true],
  ["quantity 0", { ...base, quantity: 0 }, false],
  ["quantity -1", { ...base, quantity: -1 }, false],
  ["quantity MAX_QUANTITY + 1", { ...base, quantity: MAX_QUANTITY + 1 }, false],
  ["quantity 1.5", { ...base, quantity: 1.5 }, false],
  ['quantity "10"', { ...base, quantity: "10" }, false],
  ["quantity null", { ...base, quantity: null }, false],
  ["latitude -90", { ...base, latitude: -90 }, true],
  ["latitude 90", { ...base, latitude: 90 }, true],
  ["latitude 90.000001", { ...base, latitude: 90.000001 }, false],
  ["latitude -90.000001", { ...base, latitude: -90.000001 }, false],
  ['latitude "13.75"', { ...base, latitude: "13.75" }, false],
  ["longitude -180", { ...base, longitude: -180 }, true],
  ["longitude 180", { ...base, longitude: 180 }, true],
  ["longitude 180.000001", { ...base, longitude: 180.000001 }, false],
  ["longitude -180.000001", { ...base, longitude: -180.000001 }, false],
  ["unknown field", { ...base, note: "x" }, false],
  ["missing quantity", without(base, "quantity"), false],
  ["missing latitude", without(base, "latitude"), false],
  ["missing longitude", without(base, "longitude"), false],
  ["array body", [base], false],
  ["null body", null, false],
  ["string body", "x", false],
];

const submissionIdCases: Case[] = [
  ["missing submissionId", without(submitBody, "submissionId"), false],
  ["empty submissionId", { ...submitBody, submissionId: "" }, false],
  ["1-character submissionId", { ...submitBody, submissionId: "a" }, true],
  ["255-character submissionId", { ...submitBody, submissionId: "a".repeat(255) }, true],
  ["256-character submissionId", { ...submitBody, submissionId: "a".repeat(256) }, false],
  // Both count Unicode code points: 255 emoji are 510 UTF-16 code units.
  ["255-emoji submissionId", { ...submitBody, submissionId: "\u{1F600}".repeat(255) }, true],
  ["256-emoji submissionId", { ...submitBody, submissionId: "\u{1F600}".repeat(256) }, false],
  [
    "UUID submissionId",
    { ...submitBody, submissionId: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    true,
  ],
  ["numeric submissionId", { ...submitBody, submissionId: 42 }, false],
  ["null submissionId", { ...submitBody, submissionId: null }, false],
];

/** Rejected by the server, accepted by the published schema; each stated in prose. */
const documentedDivergences: readonly (readonly [
  name: string,
  submissionId: string,
  prose: string,
])[] = [
  ["leading whitespace", " order-1", "whitespace"],
  ["trailing newline", "order-1\n", "whitespace"],
  ["whitespace only", "   ", "whitespace"],
  ["NUL character", "order\u00001", "U+0000"],
  ["lone surrogate", "order-\uD800", "surrogates"],
];

function zodAccepts(schema: z.ZodType, body: unknown): boolean {
  return schema.safeParse(body).success;
}

async function appAccepts(path: string, body: unknown): Promise<boolean> {
  const response = await post(app, path, JSON.stringify(body));
  return response.status !== 400;
}

describe("generated request schemas agree with runtime validation", () => {
  const verify = validator.component("VerifyOrderRequest");
  const submit = validator.component("SubmitOrderRequest");

  test.each(fieldCases(verifyBody))("verify: %s", async (_name, body, accepted) => {
    expect(ajvAccepts(verify, body)).toBe(accepted);
    expect(zodAccepts(verifyOrderRequestSchema, body)).toBe(accepted);
  });

  test.each([...fieldCases(submitBody), ...submissionIdCases])(
    "submit: %s",
    async (_name, body, accepted) => {
      expect(ajvAccepts(submit, body)).toBe(accepted);
      expect(zodAccepts(submitOrderRequestSchema, body)).toBe(accepted);
    },
  );

  test("the app enforces the same result for every case", async () => {
    for (const [name, body, accepted] of fieldCases(verifyBody)) {
      // The verify use case throws (500) for well-formed bodies; only 400 matters.
      expect(await appAccepts("/api/v1/orders/verify", body), `verify: ${name}`).toBe(accepted);
    }
    for (const [name, body, accepted] of [...fieldCases(submitBody), ...submissionIdCases]) {
      expect(await appAccepts("/api/v1/orders", body), `submit: ${name}`).toBe(accepted);
    }
  });

  test.each(documentedDivergences)(
    "submissionId %s: schema-valid, rejected by the server, documented",
    async (_name, submissionId, prose) => {
      const body = { ...submitBody, submissionId };
      expect(ajvAccepts(submit, body)).toBe(true);
      expect(zodAccepts(submitOrderRequestSchema, body)).toBe(false);
      expect(await appAccepts("/api/v1/orders", body)).toBe(false);
      expect(SUBMISSION_ID_DESCRIPTION).toContain(prose);
    },
  );

  test("verification rejects submissionId as an unknown field in both", () => {
    expect(ajvAccepts(verify, submitBody)).toBe(false);
    expect(zodAccepts(verifyOrderRequestSchema, submitBody)).toBe(false);
  });
});
