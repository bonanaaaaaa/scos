/**
 * Extension point for #17 (telemetry): the place where the telemetry
 * environment schema, including its conditional requirements (OTLP endpoint
 * settings required only when export is enabled), is merged into every
 * Lambda schema. It adds nothing yet; #17 replaces the identity with its
 * shape and refinement (Zod 4's `safeExtend`, since the database schema has
 * refinements) and adds the parsed values to the Lambda configs. Both Lambda
 * schemas in `./config.ts` pass through here, so the merge is one edit;
 * `config.telemetry.test.ts` proves it.
 *
 * @module
 */

import type { z } from "zod";

export function withLambdaTelemetryEnvironment<Schema extends z.ZodObject>(schema: Schema): Schema {
  return schema;
}
