/**
 * Shared initialization of the Lambda entrypoints: a second driving adapter
 * over the same per-endpoint compositions the local server uses. Hono's AWS
 * Lambda adapter (`hono/aws-lambda`) translates API Gateway HTTP API
 * (payload format 2.0) events to requests and responses; no HTTP logic is
 * repeated here.
 *
 * Each entrypoint calls {@link initializeLambda} at module scope, so it runs
 * once per execution environment, during Lambda's init phase: the
 * environment is validated first, and an invalid one fails initialization
 * with a {@link LambdaConfigurationError} before any client is built. Warm
 * invocations reuse the composition (and its pool).
 *
 * This module imports no database code, so the health bundle stays free of
 * pg, Prisma and the AWS SDK.
 *
 * @module
 */

import {
  type APIGatewayProxyResult,
  type LambdaContext,
  type LambdaEvent,
  handle,
} from "hono/aws-lambda";

import type { Environment, ParseResult } from "../config";
import type { ComposedApplication } from "../database";

/** An API Gateway HTTP API (payload format 2.0) event. */
export type HttpApiEvent = Extract<LambdaEvent, { readonly routeKey: string }>;

export type LambdaHandler = (
  event: HttpApiEvent,
  context?: LambdaContext,
) => Promise<APIGatewayProxyResult>;

/**
 * Thrown during initialization when the environment is invalid. The message
 * is only the `NAME: reason` lines from validation, one per line; values are
 * never included.
 */
export class LambdaConfigurationError extends Error {
  constructor(problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "LambdaConfigurationError";
  }
}

/** The only line reported when validation itself throws. */
export const UNEXPECTED_VALIDATION_FAILURE =
  "environment: validation failed unexpectedly; check the variable formats";

export interface LambdaDefinition<Config> {
  readonly parse: (environment: Environment) => ParseResult<Config>;
  readonly compose: (config: Config) => ComposedApplication;
}

export interface LambdaRuntime {
  readonly handler: LambdaHandler;
  readonly composed: ComposedApplication;
}

/** Validates the environment, then composes the app and wraps it for Lambda. */
export function initializeLambda<Config>(
  definition: LambdaDefinition<Config>,
  environment: Environment = process.env,
): LambdaRuntime {
  let result: ParseResult<Config>;
  try {
    result = definition.parse(environment);
  } catch {
    // Validation is meant to return problems, not throw. Whatever was thrown
    // may carry a value (a URL error carries its input), so it is dropped.
    throw new LambdaConfigurationError([UNEXPECTED_VALIDATION_FAILURE]);
  }
  if (!result.success) {
    throw new LambdaConfigurationError(result.errors);
  }
  const composed = definition.compose(result.config);
  const handler = handle(composed.app);
  return { handler: (event, context) => handler(event, context), composed };
}
