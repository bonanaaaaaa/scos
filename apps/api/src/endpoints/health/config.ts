/**
 * Configuration of a health-only runtime: none.
 *
 * @module
 */

import { z } from "zod";

import { type Environment, type ParseResult, parseEnvironment } from "../../config";

export const healthEnvironmentSchema = z.object({});

/** Health has no configuration; this always succeeds. */
export type HealthConfig = Readonly<Record<string, never>>;

export function parseHealthConfig(environment: Environment): ParseResult<HealthConfig> {
  return parseEnvironment(healthEnvironmentSchema, environment, () => ({}));
}
