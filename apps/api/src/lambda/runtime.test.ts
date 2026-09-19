import { inspect } from "node:util";

import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";

import { httpApiEvent, lambdaContext } from "../testing/lambda-events.test-support";
import {
  LambdaConfigurationError,
  UNEXPECTED_VALIDATION_FAILURE,
  initializeLambda,
} from "./runtime";

function definition(
  parseResult: { success: true; config: { n: number } } | { success: false; errors: string[] },
) {
  const app = new Hono();
  let requests = 0;
  app.get("/health", (c) => {
    requests += 1;
    return c.json({ requests });
  });
  const close = vi.fn(async () => undefined);
  return {
    parse: vi.fn(() => parseResult),
    compose: vi.fn(() => ({ app, close })),
    close,
  };
}

describe("initializeLambda", () => {
  test("validates once, composes once, and reuses the app on every invocation", async () => {
    const lambda = definition({ success: true, config: { n: 1 } });
    const environment = { SOME: "value" };
    const { handler, composed } = initializeLambda(lambda, environment);

    expect(lambda.parse).toHaveBeenCalledExactlyOnceWith(environment);
    expect(lambda.compose).toHaveBeenCalledExactlyOnceWith({ n: 1 });
    expect(lambda.parse.mock.invocationCallOrder[0]).toBeLessThan(
      lambda.compose.mock.invocationCallOrder[0] ?? 0,
    );

    for (const expected of [1, 2, 3]) {
      const result = await handler(httpApiEvent("GET", "/health"), lambdaContext());
      expect(result).toMatchObject({
        statusCode: 200,
        body: JSON.stringify({ requests: expected }),
      });
    }
    expect(lambda.parse).toHaveBeenCalledOnce();
    expect(lambda.compose).toHaveBeenCalledOnce();
    expect(composed.close).toBe(lambda.close);
  });

  test("an invalid environment fails initialization with only NAME: reason lines", () => {
    const lambda = definition({
      success: false,
      errors: [
        "DATABASE_URL: is required",
        "AWS_REGION: is required when DATABASE_AUTH_MODE is iam",
      ],
    });
    let thrown: unknown;
    try {
      initializeLambda(lambda, { DATABASE_AUTH_MODE: "iam" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LambdaConfigurationError);
    expect(thrown).toMatchObject({
      name: "LambdaConfigurationError",
      message: "DATABASE_URL: is required\nAWS_REGION: is required when DATABASE_AUTH_MODE is iam",
    });
    expect(lambda.compose).not.toHaveBeenCalled();
  });

  test("anything thrown by validation becomes a sanitized configuration error", () => {
    const secret = "postgresql://u:secretpw@/d";
    const lambda = definition({ success: true, config: { n: 3 } });
    lambda.parse.mockImplementation(() => {
      // Like Node's ERR_INVALID_URL, whose `input` property holds the URL.
      throw Object.assign(new TypeError(`Invalid URL ${secret}`), { input: secret });
    });
    let thrown: unknown;
    try {
      initializeLambda(lambda, { DATABASE_URL: secret });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LambdaConfigurationError);
    const error = thrown as LambdaConfigurationError;
    expect(error.message).toBe(UNEXPECTED_VALIDATION_FAILURE);
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).toStrictEqual(["name"]);
    for (const text of [error.message, error.stack ?? "", JSON.stringify(error), inspect(error)]) {
      expect(text).not.toContain("secretpw");
    }
    expect(lambda.compose).not.toHaveBeenCalled();
  });

  test("defaults to process.env", () => {
    const lambda = definition({ success: true, config: { n: 2 } });
    initializeLambda(lambda);
    expect(lambda.parse).toHaveBeenCalledWith(process.env);
  });
});
