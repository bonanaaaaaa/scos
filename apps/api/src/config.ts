/**
 * Runtime configuration, validated once at the server entrypoint before any
 * client is built or the listener opens. Pure modules (the app, the contract)
 * never read the environment.
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

export const environmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  PORT: portSchema,
});

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly port: number;
}

export type ConfigResult =
  | { readonly success: true; readonly config: ServerConfig }
  | { readonly success: false; readonly errors: readonly string[] };

/**
 * Parses the process environment. Returns sanitized `NAME: reason` lines on
 * failure; values are never included.
 */
export function parseConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ConfigResult {
  const parsed = environmentSchema.safeParse({
    DATABASE_URL: environment.DATABASE_URL,
    PORT: environment.PORT,
  });
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return {
    success: true,
    config: { databaseUrl: parsed.data.DATABASE_URL, port: parsed.data.PORT },
  };
}
