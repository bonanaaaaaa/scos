import { describe, expect, test } from "vitest";

import * as core from "#index";

describe("@scos/core public entry point", () => {
  test("the core package exposes its public entry point", () => {
    expect(core.corePackage.name).toBe("core");
  });

  test("the public entry point exposes adapter-facing API only", () => {
    expect(Object.keys(core).sort()).toStrictEqual([
      "DomainError",
      "LATITUDE_LIMIT",
      "LONGITUDE_LIMIT",
      "MAX_QUANTITY",
      "MAX_SUBMISSION_ATTEMPTS",
      "MONEY_MAX_STRING",
      "Money",
      "ORDER_NUMBER_PATTERN",
      "SubmissionKeyTakenError",
      "TransientSubmissionError",
      "corePackage",
      "createOrder",
      "createSubmitOrder",
      "createVerifyOrder",
      "destinationSchema",
      "estimateOrder",
      "generateOrderNumber",
      "orderRequestSchema",
      "quantitySchema",
      "restoreOrder",
      "submissionKeySchema",
    ]);
  });
});
