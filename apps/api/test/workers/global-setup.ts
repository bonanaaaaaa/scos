/**
 * Runs in Node before the Workers integration tests: creates an isolated,
 * migrated and seeded database beside `scos_test` (the same helper as the
 * Node integration tests) and hands its URL to the Worker's Hyperdrive
 * binding (vitest.workers.integration.config.mjs). Dropped afterwards.
 */

import type { TestProject } from "vitest/node";

import { createTestDatabase } from "../support/database";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await createTestDatabase();
  await database.reset();
  project.provide("workerDatabaseUrl", database.url);
  return () => database.drop();
}
