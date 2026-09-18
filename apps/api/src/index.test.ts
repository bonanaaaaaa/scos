import assert from "node:assert/strict";
import { test } from "vitest";

import { app, workspaceComposition } from "./index";
import { parsePort, startServer } from "./server";

test("the API composition root can import the inward packages", () => {
  assert.deepEqual(workspaceComposition(), ["core", "persistence"]);
});

test("GET /health reports application liveness without external services", async () => {
  const response = await app.request("/health");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("server ports accept defaults and boundaries while rejecting invalid values", () => {
  assert.equal(parsePort(undefined), 3000);
  assert.equal(parsePort("0"), 0);
  assert.equal(parsePort("65535"), 65_535);
  assert.throws(() => parsePort("1.5"), /PORT must be an integer/);
  assert.throws(() => parsePort("-1"), /PORT must be an integer/);
  assert.throws(() => parsePort("65536"), /PORT must be an integer/);
});

test("server startup passes the parsed port and reports the listening address", () => {
  const messages: string[] = [];
  const sentinel = { close: true };

  const result = startServer(
    "4321",
    (options, onListening) => {
      assert.equal(options.port, 4321);
      assert.equal(options.fetch, app.fetch);
      onListening({ port: options.port });
      return sentinel;
    },
    (message) => messages.push(message),
  );

  assert.equal(result, sentinel);
  assert.deepEqual(messages, ["SCOS API listening on http://localhost:4321"]);
});
