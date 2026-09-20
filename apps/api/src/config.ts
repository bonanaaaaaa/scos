/**
 * Runtime configuration: the shared environment parsing helper, the database
 * configuration used by the verify and submit endpoints, and the local
 * server's configuration. Each runtime validates once at its entrypoint,
 * before any client is built or a listener opens. Pure modules (the apps, the
 * contracts) never read the environment. The health parser lives in
 * `endpoints/health/config.ts`.
 *
 * Validation messages name the variable and a safe reason only; they never
 * echo the submitted value, which may contain credentials.
 *
 * @module
 */

import { z } from "zod";

import {
  REFINE_ALWAYS,
  type TelemetryConfig,
  type WorkersTelemetryConfig,
  refineTelemetry,
  telemetryEnvironmentShape,
  toTelemetryConfig,
  toWorkersTelemetryConfig,
  workersTelemetryEnvironmentShape,
} from "#telemetry/config";

export const DEFAULT_PORT = 3000;

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

function isPostgresUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return POSTGRES_PROTOCOLS.has(url.protocol) && url.hostname.length > 0;
}

const databaseUrlSchema = z
  .string({ error: "is required" })
  .min(1, { error: "is required", abort: true })
  .refine(isPostgresUrl, {
    error: "must be a postgres:// or postgresql:// URL with a host",
  });

const portSchema = z
  .string()
  .regex(/^\d{1,5}$/, { error: "must be an integer between 0 and 65535" })
  .transform(Number)
  .refine((port) => port <= 65_535, { error: "must be an integer between 0 and 65535" })
  .optional()
  .transform((port) => port ?? DEFAULT_PORT);

/**
 * Telemetry and logging variables every runtime accepts (see
 * `telemetry/config.ts`), with their cross-field rules.
 */
export const telemetryEnvironmentSchema = z
  .object(telemetryEnvironmentShape)
  .superRefine(refineTelemetry, REFINE_ALWAYS);

/** The database endpoints (verify, submit): DATABASE_URL plus telemetry. */
export const databaseEnvironmentSchema = z
  .object({ DATABASE_URL: databaseUrlSchema, ...telemetryEnvironmentShape })
  .superRefine(refineTelemetry, REFINE_ALWAYS);

export const serverEnvironmentSchema = z
  .object({ DATABASE_URL: databaseUrlSchema, PORT: portSchema, ...telemetryEnvironmentShape })
  .superRefine(refineTelemetry, REFINE_ALWAYS);

export type Environment = Readonly<Record<string, string | undefined>>;

export type ParseResult<Config> =
  | { readonly success: true; readonly config: Config }
  | { readonly success: false; readonly errors: readonly string[] };

/**
 * Validates only the variables `schema` declares. Returns sanitized
 * `NAME: reason` lines on failure; values are never included.
 */
export function parseEnvironment<Schema extends z.ZodObject, Config>(
  schema: Schema,
  environment: Environment,
  toConfig: (data: z.output<Schema>) => Config,
): ParseResult<Config> {
  const declared = Object.fromEntries(
    Object.keys(schema.shape).map((name) => [name, environment[name]]),
  );
  const parsed = schema.safeParse(declared);
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return { success: true, config: toConfig(parsed.data) };
}

/** Telemetry and logging settings, validated for every runtime. */
export interface TelemetrySettings {
  readonly telemetry: TelemetryConfig;
}

/** What the verify and submit runtimes need. */
export interface DatabaseConfig extends TelemetrySettings {
  readonly databaseUrl: string;
}

/**
 * For a verify-only or submit-only runtime: requires DATABASE_URL and
 * validates the telemetry variables.
 */
export function parseDatabaseConfig(environment: Environment): ParseResult<DatabaseConfig> {
  return parseEnvironment(databaseEnvironmentSchema, environment, (data) => ({
    databaseUrl: data.DATABASE_URL,
    telemetry: toTelemetryConfig(data),
  }));
}

export interface ServerConfig extends DatabaseConfig {
  readonly port: number;
}

export type ConfigResult = ParseResult<ServerConfig>;

/**
 * Parses the local server's environment (DATABASE_URL, PORT and telemetry).
 * Returns sanitized `NAME: reason` lines on failure; values are never
 * included.
 */
export function parseConfig(environment: Environment): ConfigResult {
  return parseEnvironment(serverEnvironmentSchema, environment, (data) => ({
    databaseUrl: data.DATABASE_URL,
    port: data.PORT,
    telemetry: toTelemetryConfig(data),
  }));
}

/**
 * The Cloudflare Worker: DATABASE_URL (taken from the Hyperdrive binding's
 * connection string by `entrypoints/worker.ts`, never from a variable) and the
 * Workers telemetry variables.
 */
export const workerEnvironmentSchema = z
  .object({ DATABASE_URL: databaseUrlSchema, ...workersTelemetryEnvironmentShape })
  .superRefine(refineTelemetry, REFINE_ALWAYS);

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly telemetry: WorkersTelemetryConfig;
}

/**
 * Parses the Worker's environment. Like every parser here, failures are
 * `NAME: reason` lines without values.
 */
export function parseWorkerConfig(environment: Environment): ParseResult<WorkerConfig> {
  return parseEnvironment(workerEnvironmentSchema, environment, (data) => ({
    databaseUrl: data.DATABASE_URL,
    telemetry: toWorkersTelemetryConfig(data),
  }));
}
