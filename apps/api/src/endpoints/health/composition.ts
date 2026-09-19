/**
 * Composition of `GET /health` alone: no configuration and no database.
 *
 * @module
 */

import type { ComposedApplication } from "../../database";
import type { Logger } from "../../http/logger";
import { createHealthApp } from "./app";

/** `close()` is a no-op: nothing was opened. */
export function composeHealthApplication(
  options: { readonly logger?: Logger } = {},
): ComposedApplication {
  return { app: createHealthApp(options), close: async () => undefined };
}
