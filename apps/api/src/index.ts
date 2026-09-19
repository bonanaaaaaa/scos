/**
 * Public surface of the API adapter that needs no environment or database:
 * app construction and the HTTP contract (for offline OpenAPI generation).
 * Runtime wiring lives in `composition.ts`; the listener in `server.ts`.
 *
 * @module
 */

import { corePackage } from "@scos/core";
import { persistencePackage } from "@scos/persistence";

export { type AppDependencies, type Logger, consoleLogger, createApp } from "./app";
export * from "./http/contracts";

export function workspaceComposition(): readonly string[] {
  return [corePackage.name, persistencePackage.name];
}
