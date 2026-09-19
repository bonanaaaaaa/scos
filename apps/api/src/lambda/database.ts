/**
 * The Lambda definition shared by the database-backed functions (verify and
 * submit): Lambda configuration plus the per-environment pool.
 *
 * @module
 */

import type { ComposedApplication, DatabaseCompositionOptions } from "../database";
import { type LambdaDatabaseConfig, parseLambdaDatabaseConfig } from "./config";
import { type CreateAuthTokenSigner, createRdsAuthTokenSigner, lambdaPoolFactory } from "./pool";
import type { LambdaDefinition } from "./runtime";

export function databaseLambda(
  compose: (options: DatabaseCompositionOptions) => ComposedApplication,
  createSigner: CreateAuthTokenSigner = createRdsAuthTokenSigner,
): LambdaDefinition<LambdaDatabaseConfig> {
  return {
    parse: parseLambdaDatabaseConfig,
    compose: (config) =>
      compose({
        databaseUrl: config.databaseUrl,
        createPool: lambdaPoolFactory(config, createSigner),
      }),
  };
}
