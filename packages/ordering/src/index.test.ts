import assert from "node:assert/strict";
import test from "node:test";

import { orderingPackage } from "./index.js";

test("the ordering package exposes its public entry point", () => {
  assert.equal(orderingPackage.name, "ordering");
});
