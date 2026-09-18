import assert from "node:assert/strict";
import test from "node:test";

import { app, workspaceComposition } from "./index.js";

test("the API composition root can import the inward packages", () => {
  assert.deepEqual(workspaceComposition(), ["ordering", "persistence"]);
});

test("GET /health reports application liveness without external services", async () => {
  const response = await app.request("/health");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { status: "ok" });
});
