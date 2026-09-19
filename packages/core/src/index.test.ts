import { describe, expect, test } from "vitest";

import * as core from "./index";

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
      "MONEY_MAX_STRING",
      "Money",
      "corePackage",
      "createOrder",
      "destinationSchema",
      "estimateOrder",
      "orderRequestSchema",
      "quantitySchema",
      "submissionKeySchema",
    ]);
  });
});
