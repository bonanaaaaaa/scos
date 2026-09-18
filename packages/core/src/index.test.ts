import assert from "node:assert/strict";
import { test } from "vitest";

import { corePackage } from "./index.js";

test("the core package exposes its public entry point", () => {
  assert.equal(corePackage.name, "core");
});
