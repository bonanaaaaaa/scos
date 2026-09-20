import { Hono } from "hono";
import { describeRoute, type resolver } from "hono-openapi";
import { describe, expect, test } from "vitest";

import { createApp } from "#app";
import { createHealthApp } from "#endpoints/health/app";
import { createSubmitOrderApp } from "#endpoints/submit-order/app";
import { createVerifyOrderApp } from "#endpoints/verify-order/app";
import { errorResponseSchema } from "#http/errors";
import { SWAGGER_UI_VERSION, createDocsApp } from "#openapi/docs-app";
import { renderOpenApiDocument } from "#openapi/offline";
import { fakeLogger, json } from "#testing/fixtures.test-support";
import { noSubmit, noVerify } from "#testing/requests.test-support";

function app() {
  return createApp({ verifyOrder: noVerify, submitOrder: noSubmit, logger: fakeLogger() });
}

describe("documentation routes", () => {
  /**
   * The developer-owned home of "the served document is `renderOpenApiDocument()`":
   * the QA acceptance suite never imports API source, so it pins the served
   * document to the built `dist/openapi.json` artifact instead.
   */
  test("GET /openapi.json serves the exported document byte for byte", async () => {
    const combined = app();
    for (let request = 0; request < 2; request += 1) {
      const response = await combined.request("/openapi.json");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=UTF-8");
      expect(await response.text()).toBe(await renderOpenApiDocument());
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
        const response = await standalone.request(path);
        expect(response.status).toBe(404);
        expect((await json(response, errorResponseSchema)).error.code).toBe("NOT_FOUND");
      }
    }
  });

  describe("generation failure is not cached", () => {
    /**
     * An app whose only route documents its response with a stand-in
     * resolver: the conversion fails `failures` times, then succeeds.
     */
    function documentedApp(failures: number) {
      let calls = 0;
      const schema: ReturnType<typeof resolver> = {
        vendor: "test",
        validate: () => ({ value: undefined }),
        toJSONSchema: () => ({ type: "string" }),
        async toOpenAPISchema() {
          calls += 1;
          // Yield first, so concurrent requests overlap the generation.
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (calls <= failures) {
            throw new Error("conversion failed");
          }
          return { schema: { type: "string" as const }, components: undefined };
        },
      };
      const documented = new Hono();
      documented.get(
        "/probe",
        describeRoute({
          responses: { 200: { description: "OK", content: { "application/json": { schema } } } },
        }),
        (c) => c.text("ok"),
      );
      return { documented, calls: () => calls };
    }

    test("a failed generation is a 500 and the next request generates again", async () => {
      const logger = fakeLogger();
      const { documented, calls } = documentedApp(1);
      const docs = createDocsApp(logger, documented);

      const failed = await docs.request("/openapi.json");
      expect(failed.status).toBe(500);
      expect((await json(failed, errorResponseSchema)).error.code).toBe("INTERNAL_ERROR");
      expect(logger.error).toHaveBeenCalledTimes(1);

      const retried = await docs.request("/openapi.json");
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ paths: { "/probe": { get: {} } } });
      expect(calls()).toBe(2);

      // Success is cached: no third generation.
      expect((await docs.request("/openapi.json")).status).toBe(200);
      expect(calls()).toBe(2);
    });

    test("concurrent first requests share one generation", async () => {
      const { documented, calls } = documentedApp(0);
      const docs = createDocsApp(fakeLogger(), documented);
      const responses = await Promise.all([1, 2, 3].map(() => docs.request("/openapi.json")));
      expect(responses.map((response) => response.status)).toStrictEqual([200, 200, 200]);
      expect(calls()).toBe(1);
    });

    test("concurrent requests during a failed generation all fail; the next one retries", async () => {
      const { documented, calls } = documentedApp(1);
      const docs = createDocsApp(fakeLogger(), documented);
      const responses = await Promise.all([1, 2].map(() => docs.request("/openapi.json")));
      expect(responses.map((response) => response.status)).toStrictEqual([500, 500]);
      expect(calls()).toBe(1);
      expect((await docs.request("/openapi.json")).status).toBe(200);
      expect(calls()).toBe(2);
    });
  });
});
