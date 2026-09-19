/**
 * What every runtime composition returns: the app to serve and a way to
 * release what it opened. Runtime-neutral, so Node/Lambda compositions
 * (`database.ts` and the endpoint compositions) and a Workers composition
 * share it.
 *
 * @module
 */

import type { Hono } from "hono";

export interface ComposedApplication {
  readonly app: Hono;
  /** Releases what the composition opened. Safe to call more than once. */
  close(): Promise<void>;
}
