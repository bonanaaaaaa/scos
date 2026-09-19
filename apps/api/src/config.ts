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

/** The database endpoints (verify, submit) need DATABASE_URL only. */
export const databaseEnvironmentSchema = z.object({ DATABASE_URL: databaseUrlSchema });

export const serverEnvironmentSchema = databaseEnvironmentSchema.extend({ PORT: portSchema });

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

/** What the verify and submit compositions need. */
export interface DatabaseConfig {
  readonly databaseUrl: string;
}

/** For a verify-only or submit-only runtime: requires DATABASE_URL. */
export function parseDatabaseConfig(environment: Environment): ParseResult<DatabaseConfig> {
  return parseEnvironment(databaseEnvironmentSchema, environment, (data) => ({
    databaseUrl: data.DATABASE_URL,
  }));
}

export interface ServerConfig extends DatabaseConfig {
  readonly port: number;
}

export type ConfigResult = ParseResult<ServerConfig>;

/**
 * Parses the local server's environment (DATABASE_URL and PORT). Returns
 * sanitized `NAME: reason` lines on failure; values are never included.
 */
export function parseConfig(environment: Environment): ConfigResult {
  return parseEnvironment(serverEnvironmentSchema, environment, (data) => ({
    databaseUrl: data.DATABASE_URL,
    port: data.PORT,
  }));
}
