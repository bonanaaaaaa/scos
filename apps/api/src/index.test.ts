import assert from "node:assert/strict";
import test from "node:test";

import { workspaceComposition } from "./index.js";

test("the API composition root can import the inward packages", () => {
  assert.deepEqual(workspaceComposition(), ["ordering", "persistence"]);
});
