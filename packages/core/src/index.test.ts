import assert from "node:assert/strict";
import { test } from "vitest";

import * as core from "./index";

test("the core package exposes its public entry point", () => {
  assert.equal(core.corePackage.name, "core");
});

test("the public entry point exposes adapter-facing API only", () => {
  assert.deepEqual(Object.keys(core).sort(), [
    "DomainError",
    "LATITUDE_LIMIT",
    "LONGITUDE_LIMIT",
    "MAX_QUANTITY",
    "MONEY_MAX_STRING",
    "Money",
    "corePackage",
    "createOrder",
    "estimateOrder",
    "parseDestination",
    "parseOrderRequest",
    "parseQuantity",
  ]);
});
