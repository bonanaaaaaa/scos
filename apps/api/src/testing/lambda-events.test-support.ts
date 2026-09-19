/**
 * Realistic API Gateway HTTP API (payload format 2.0) events and Lambda
 * contexts, as API Gateway sends them to a function behind a route on the
 * `$default` stage.
 *
 * @module
 */

import type { LambdaContext } from "hono/aws-lambda";

import type { HttpApiEvent } from "../lambda/runtime";

const DOMAIN = "a1b2c3d4e5.execute-api.ap-southeast-1.amazonaws.com";

export function httpApiEvent(
  method: string,
  path: string,
  options: { readonly body?: unknown; readonly headers?: Record<string, string> } = {},
): HttpApiEvent {
  const routeKey = `${method} ${path}`;
  const body =
    options.body === undefined
      ? null
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  return {
    version: "2.0",
    routeKey,
    rawPath: path,
    rawQueryString: "",
    headers: {
      accept: "application/json",
      "content-length": String(body === null ? 0 : Buffer.byteLength(body)),
      host: DOMAIN,
      "user-agent": "scos-lambda-test",
      "x-amzn-trace-id": "Root=1-66f00000-000000000000000000000000",
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-port": "443",
      "x-forwarded-proto": "https",
      ...(body === null ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    requestContext: {
      accountId: "123456789012",
      apiId: "a1b2c3d4e5",
      // Hono's type requires these two; a route without an authorizer
      // carries no authorizer data.
      authentication: null,
      authorizer: {},
      domainName: DOMAIN,
      domainPrefix: "a1b2c3d4e5",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.10",
        userAgent: "scos-lambda-test",
      },
      requestId: "Zx1yAbCdSQ0EJcQ=",
      routeKey,
      stage: "$default",
      time: "19/Sep/2026:08:00:00 +0000",
      timeEpoch: 1_789_804_800_000,
    },
    body,
    isBase64Encoded: false,
  };
}

export function lambdaContext(functionName = "scos-test"): LambdaContext {
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName,
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:ap-southeast-1:123456789012:function:${functionName}`,
    memoryLimitInMB: "512",
    awsRequestId: "8f5b2c1e-0000-4000-8000-000000000001",
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: "2026/09/19/[$LATEST]0123456789abcdef",
    getRemainingTimeInMillis: () => 10_000,
  };
}
