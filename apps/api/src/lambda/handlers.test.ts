/**
 * The three Lambda entrypoints, imported as Lambda imports them (module
 * initialization reads `process.env`) and invoked with API Gateway HTTP API
 * payload format 2.0 events. No database is reachable here; the database
 * paths run in test/lambda.integration.test.ts and against the built
 * artifacts in test/lambda-artifacts.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { unreachableDatabaseUrl } from "../testing/persistence-spies.test-support";
import { httpApiEvent, lambdaContext } from "../testing/lambda-events.test-support";

const SECRET = "secret";

const loaders = {
  "verify-order": () => import("./verify-order"),
  "submit-order": () => import("./submit-order"),
};

beforeEach(() => {
  vi.resetModules();
  // Unexpected errors are logged by the endpoint apps; keep the output quiet.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("health handler", () => {
  test("answers GET /health with no configuration at all", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_AUTH_MODE", "nonsense");
    const { handler } = await import("./health");
    const result = await handler(httpApiEvent("GET", "/health"), lambdaContext("scos-health"));
    expect(result).toStrictEqual({
      statusCode: 200,
      body: JSON.stringify({ status: "ok" }),
      headers: { "content-type": "application/json" },
      isBase64Encoded: false,
    });
  });

  test("answers other routes with the 404 envelope", async () => {
    const { handler } = await import("./health");
    const result = await handler(httpApiEvent("POST", "/health"), lambdaContext());
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe.each([
  ["verify-order", "/api/v1/orders/verify", { quantity: 1, latitude: 0, longitude: 0 }],
  [
    "submit-order",
    "/api/v1/orders",
    { submissionId: "lambda-unit-1", quantity: 1, latitude: 0, longitude: 0 },
  ],
] as const)("%s handler", (name, path, body) => {
  const load = loaders[name];

  test("fails initialization without DATABASE_URL, naming the variable only", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    await expect(load()).rejects.toMatchObject({
      name: "LambdaConfigurationError",
      message: "DATABASE_URL: is required",
    });
  });

  test("fails initialization for a password in iam mode without echoing it", async () => {
    vi.stubEnv("DATABASE_URL", `postgresql://scos_app:${SECRET}@proxy.example.com/scos`);
    vi.stubEnv("DATABASE_AUTH_MODE", "iam");
    vi.stubEnv("AWS_REGION", "ap-southeast-1");
    const error = await load().then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message).toBe(
      "DATABASE_URL: must not include a password when DATABASE_AUTH_MODE is iam",
    );
    expect(error?.message).not.toContain(SECRET);
  });

  test("serves its route: 400 before the database, 500 when the database refuses", async () => {
    vi.stubEnv("DATABASE_URL", unreachableDatabaseUrl);
    vi.stubEnv("DATABASE_AUTH_MODE", undefined);
    const { handler } = await load();

    const invalid = await handler(
      httpApiEvent("POST", path, { body: { ...body, quantity: "1" } }),
      lambdaContext(),
    );
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const refused = await handler(httpApiEvent("POST", path, { body }), lambdaContext());
    expect(refused.statusCode).toBe(500);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(refused.body).not.toContain(SECRET);
  });

  test("answers every other route with the 404 envelope", async () => {
    vi.stubEnv("DATABASE_URL", unreachableDatabaseUrl);
    const { handler } = await load();
    for (const event of [httpApiEvent("GET", "/health"), httpApiEvent("GET", path)]) {
      const result = await handler(event, lambdaContext());
      expect(result.statusCode).toBe(404);
    }
  });
});
