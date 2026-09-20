import { describe, expect, test } from "vitest";

import * as api from "#index";

describe("API package surface", () => {
  test("the API composition root can import the inward packages", () => {
    expect(api.workspaceComposition()).toStrictEqual(["core", "persistence"]);
  });

  test("app construction and the HTTP contract are importable without any environment", async () => {
    expect(typeof api.createApp).toBe("function");
    expect(Object.keys(api.routes)).toStrictEqual(["health", "verifyOrder", "submitOrder"]);

    const app = api.createApp({
      verifyOrder: () => Promise.reject(new Error("not called")),
      submitOrder: () => Promise.reject(new Error("not called")),
    });
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toStrictEqual({ status: "ok" });
  });

  test("the OpenAPI document is built from the exported route contract", async () => {
    const document = await api.buildOpenApiDocument();
    expect(Object.keys(document.paths)).toStrictEqual(
      Object.values(api.routes).map((route) => route.path),
    );
    expect(await api.renderOpenApiDocument()).toBe(api.serializeOpenApiDocument(document));
    expect(api.serializeOpenApiDocument(document)).toBe(`${JSON.stringify(document, null, 2)}\n`);
    expect([api.OPENAPI_PATH, api.DOCS_PATH]).toStrictEqual(["/openapi.json", "/docs"]);
  });
});
