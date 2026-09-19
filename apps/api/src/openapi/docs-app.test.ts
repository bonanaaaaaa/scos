import { describe, expect, test } from "vitest";

import { createApp } from "../app";
import { createHealthApp } from "../endpoints/health/app";
import { createSubmitOrderApp } from "../endpoints/submit-order/app";
import { createVerifyOrderApp } from "../endpoints/verify-order/app";
import { errorResponseSchema } from "../http/errors";
import { fakeLogger, json } from "../testing/fixtures.test-support";
import { noSubmit, noVerify } from "../testing/requests.test-support";
import { SWAGGER_UI_VERSION } from "./docs-app";
import { renderOpenApiDocument } from "./document";

function app() {
  return createApp({ verifyOrder: noVerify, submitOrder: noSubmit, logger: fakeLogger() });
}

describe("documentation routes", () => {
  test("GET /openapi.json serves the exported document byte for byte", async () => {
    const combined = app();
    for (let request = 0; request < 2; request += 1) {
      const response = await combined.request("/openapi.json");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=UTF-8");
      expect(await response.text()).toBe(renderOpenApiDocument());
    }
  });

  test("GET /docs serves Swagger UI loading /openapi.json", async () => {
    const response = await app().request("/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await response.text();
    expect(html).toContain("swagger-ui");
    expect(html).toContain("url: '/openapi.json'");
    expect(html).toContain("<title>SCOS Ordering API</title>");
    // Every CDN asset is pinned to one swagger-ui-dist release.
    const assets = [...html.matchAll(/cdn\.jsdelivr\.net\/npm\/swagger-ui-dist[^/"']*/g)];
    expect(assets.length).toBeGreaterThan(0);
    for (const [asset] of assets) {
      expect(asset).toBe(`cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`);
    }
  });

  test("other methods on the documentation paths are the 404 envelope", async () => {
    for (const path of ["/openapi.json", "/docs"]) {
      const response = await app().request(path, { method: "POST" });
      expect(response.status).toBe(404);
      expect((await json(response, errorResponseSchema)).error.code).toBe("NOT_FOUND");
    }
  });

  test("the standalone endpoint apps do not serve documentation", async () => {
    for (const standalone of [
      createHealthApp({ logger: fakeLogger() }),
      createVerifyOrderApp({ verifyOrder: noVerify, logger: fakeLogger() }),
      createSubmitOrderApp({ submitOrder: noSubmit, logger: fakeLogger() }),
    ]) {
      for (const path of ["/openapi.json", "/docs"]) {
        expect((await standalone.request(path)).status).toBe(404);
      }
    }
  });
});
