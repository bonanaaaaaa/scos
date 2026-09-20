/**
 * Configuration of a health-only runtime: telemetry and logging only; no
 * database.
 *
 * @module
 */

import {
  type Environment,
  type ParseResult,
  type TelemetrySettings,
  parseEnvironment,
  telemetryEnvironmentSchema,
} from "#config";
import { toTelemetryConfig } from "#telemetry/config";

export const healthEnvironmentSchema = telemetryEnvironmentSchema;

/** Health needs no database; only the telemetry variables are validated. */
export type HealthConfig = TelemetrySettings;

export function parseHealthConfig(environment: Environment): ParseResult<HealthConfig> {
  return parseEnvironment(healthEnvironmentSchema, environment, (data) => ({
    telemetry: toTelemetryConfig(data),
  }));
}
