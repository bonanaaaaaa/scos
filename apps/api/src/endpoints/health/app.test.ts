import { describe, expect, test, vi } from "vitest";

import { errorResponseSchema } from "#http/errors";
import { submitBody, verifyBody } from "#testing/fixtures.test-support";
import { createHealthApp } from "#endpoints/health/app";
import { healthResponseSchema, healthRoute } from "#endpoints/health/contract";

describe("createHealthApp", () => {
  test("GET /health reports liveness as JSON", async () => {
    const response = await createHealthApp().request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(healthResponseSchema.parse(await response.json())).toStrictEqual({ status: "ok" });
  });

  test("the health app needs no dependencies and logs to the console by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await createHealthApp().request("/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({ status: "ok" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("its route is served; every other route is a 404 NOT_FOUND envelope", async () => {
    expect(healthRoute.servedBy).toBe("createHealthApp");
    const app = createHealthApp();
    const requests = [
      ["GET", "/health", undefined],
      ["POST", "/api/v1/orders/verify", verifyBody],
      ["POST", "/api/v1/orders", submitBody],
    ] as const;
    for (const [method, path, body] of requests) {
      const response = await app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (path === healthRoute.path) {
        expect(response.status).toBe(200);
      } else {
        expect(response.status).toBe(404);
        expect(errorResponseSchema.parse(await response.json()).error.code).toBe("NOT_FOUND");
      }
    }
  });
});
