import { describe, expect, test, vi } from "vitest";

import { errorResponseSchema } from "#http/errors";
import { offlineApp, renderOpenApiDocument } from "#openapi/offline";
import { json, post } from "#testing/fixtures.test-support";

describe("offline OpenAPI app", () => {
  test("has no working use cases: a request reaching one is a 500, never a database call", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    try {
      const response = await post(
        offlineApp(),
        "/api/v1/orders/verify",
        JSON.stringify({ quantity: 1, latitude: 0, longitude: 0 }),
      );
      expect(response.status).toBe(500);
      expect((await json(response, errorResponseSchema)).error.code).toBe("INTERNAL_ERROR");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("serves the document it exports", async () => {
    const response = await offlineApp().request("/openapi.json");
    expect(await response.text()).toBe(await renderOpenApiDocument());
  });
});
