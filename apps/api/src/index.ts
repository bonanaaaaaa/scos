/**
 * Public surface of the API adapter. Importing it reads no environment and
 * opens no connection:
 *
 * - app construction, per endpoint and combined, and the HTTP contract (for
 *   offline OpenAPI generation);
 * - the per-endpoint and combined compositions (they connect lazily, on the
 *   first query) and the per-runtime configuration parsers.
 *
 * The local listener lives in `server.ts`.
 *
 * @module
 */

import { corePackage } from "@scos/core";
import { persistencePackage } from "@scos/persistence";

export {
  type AppDependencies,
  type HealthAppOptions,
  type Logger,
  type SubmitOrderAppDependencies,
  type VerifyOrderAppDependencies,
  consoleLogger,
  createApp,
  createHealthApp,
  createSubmitOrderApp,
  createVerifyOrderApp,
} from "./app";
export {
  type ComposedApplication,
  type CompositionOptions,
  type DatabaseCompositionOptions,
  type SubmitOrderCompositionOptions,
  type VerifyOrderCompositionOptions,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  composeApplication,
  composeHealthApplication,
  composeSubmitOrderApplication,
  composeVerifyOrderApplication,
  databasePoolTimeouts,
} from "./composition";
export {
  type DatabaseConfig,
  type HealthConfig,
  type ParseResult,
  type ServerConfig,
  parseConfig,
  parseDatabaseConfig,
  parseHealthConfig,
} from "./config";
export * from "./http/contracts";

export function workspaceComposition(): readonly string[] {
  return [corePackage.name, persistencePackage.name];
}
