import assert from "node:assert/strict";
import { test } from "vitest";

import { orderingPackage } from "./index.js";

test("the ordering package exposes its public entry point", () => {
  assert.equal(orderingPackage.name, "ordering");
});
