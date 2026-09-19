import { describe, expect, test } from "vitest";

import { errorResponseSchema } from "../../http/errors";
import { MESSAGES } from "../../http/messages";
import { json, post, submitBody, verifyBody } from "../../testing/fixtures.test-support";
import { harness } from "./harness.test-support";

describe("request validation before the use case", () => {
  const cases: readonly [string, unknown, string, string][] = [
    ["malformed JSON", "{ quantity: 1", "application/json", MESSAGES.malformedJson],
    ["an empty body", "", "application/json", MESSAGES.malformedJson],
    ["no Content-Type", JSON.stringify(submitBody), "", MESSAGES.unsupportedContentType],
    ["text/plain", JSON.stringify(submitBody), "text/plain", MESSAGES.unsupportedContentType],
    [
      "a form body",
      "quantity=1&latitude=0",
      "application/x-www-form-urlencoded",
      MESSAGES.unsupportedContentType,
    ],
    ["a JSON array", [submitBody], "application/json", MESSAGES.invalidBody],
    ["JSON null", "null", "application/json", MESSAGES.invalidBody],
    ["an empty object", {}, "application/json", MESSAGES.invalidBody],
    [
      "a string quantity",
      { ...submitBody, quantity: "30" },
      "application/json",
      MESSAGES.invalidBody,
    ],
    [
      "an unknown field",
      { ...submitBody, idempotencyKey: "x" },
      "application/json",
      MESSAGES.invalidBody,
    ],
    [
      "a blank submissionId",
      { ...submitBody, submissionId: " \t\n" },
      "application/json",
      MESSAGES.invalidBody,
    ],
    ["a missing submissionId", verifyBody, "application/json", MESSAGES.invalidBody],
    [
      "a 256-character submissionId",
      { ...submitBody, submissionId: "x".repeat(256) },
      "application/json",
      MESSAGES.invalidBody,
    ],
    ["a zero quantity", { ...submitBody, quantity: 0 }, "application/json", MESSAGES.invalidBody],
    [
      "a longitude above 180",
      { ...submitBody, longitude: 180.5 },
      "application/json",
      MESSAGES.invalidBody,
    ],
  ];

  test.each(cases)(
    "POST /api/v1/orders with %s is 400 INVALID_REQUEST",
    async (_name, body, type, message) => {
      const { app, submitOrder, logger } = harness();
      const response = await post(app, "/api/v1/orders", body, type);

      expect(response.status).toBe(400);
      const parsed = await json(response, errorResponseSchema);
      expect(parsed.error.code).toBe("INVALID_REQUEST");
      expect(parsed.error.message).toBe(message);
      expect(submitOrder).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );
});
