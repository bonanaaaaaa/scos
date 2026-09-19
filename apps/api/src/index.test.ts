import { describe, expect, test } from "vitest";

import { app, workspaceComposition } from "./index";
import { parsePort, startServer } from "./server";

describe("API composition root", () => {
  test("the API composition root can import the inward packages", () => {
    expect(workspaceComposition()).toStrictEqual(["core", "persistence"]);
  });

  test("GET /health reports application liveness without external services", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toStrictEqual({ status: "ok" });
  });
});

describe("server", () => {
  test("server ports accept defaults and boundaries while rejecting invalid values", () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort("0")).toBe(0);
    expect(parsePort("65535")).toBe(65_535);
    expect(() => parsePort("1.5")).toThrow(/PORT must be an integer/);
    expect(() => parsePort("-1")).toThrow(/PORT must be an integer/);
    expect(() => parsePort("65536")).toThrow(/PORT must be an integer/);
  });

  test("server startup passes the parsed port and reports the listening address", () => {
    const messages: string[] = [];
    const sentinel = { close: true };

    const result = startServer(
      "4321",
      (options, onListening) => {
        expect(options.port).toBe(4321);
        expect(options.fetch).toBe(app.fetch);
        onListening({ port: options.port });
        return sentinel;
      },
      (message) => messages.push(message),
    );

    expect(result).toBe(sentinel);
    expect(messages).toStrictEqual(["SCOS API listening on http://localhost:4321"]);
  });
});
