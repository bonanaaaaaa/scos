/**
 * Configuration of the Lambda runtimes, built on the shared Zod helpers in
 * `../config.ts`. Each Lambda entrypoint parses once, at module
 * initialization, before any pool or Prisma client is built.
 *
 * - Health requires nothing.
 * - Verify and submit require `DATABASE_URL` and accept `DATABASE_AUTH_MODE`
 *   (`password`, the default, or `iam`). In `iam` mode `DATABASE_URL` names
 *   the RDS Proxy endpoint, the database user and the database, with no
 *   password and no query parameters, and `AWS_REGION` (set by Lambda) is
 *   required. TLS with certificate verification is then enforced by the pool
 *   (`./pool.ts`), not by the URL.
 *
 * Messages name the variable and a safe reason only, never the value.
 *
 * @module
 */

import { z } from "zod";

import {
  type DatabaseConfig,
  type Environment,
  type ParseResult,
  databaseEnvironmentSchema,
  parseEnvironment,
} from "../config";
import { healthEnvironmentSchema } from "../endpoints/health/config";
import { withLambdaTelemetryEnvironment } from "./telemetry";

export { withLambdaTelemetryEnvironment } from "./telemetry";

export const DATABASE_AUTH_MODES = ["password", "iam"] as const;
export type DatabaseAuthMode = (typeof DATABASE_AUTH_MODES)[number];

/** PostgreSQL's default port, used when `DATABASE_URL` names none. */
export const DEFAULT_POSTGRES_PORT = 5432;

const authModeSchema = z
  .enum(DATABASE_AUTH_MODES, { error: "must be password or iam" })
  .optional()
  .transform((mode) => mode ?? "password");

const awsRegionSchema = z
  .string()
  .regex(/^[a-z]{2,4}(-[a-z]+)+-\d+$/, {
    error: "must be an AWS Region code such as ap-southeast-1",
  })
  .optional();

function isDecodable(component: string): boolean {
  try {
    decodeURIComponent(component);
    return true;
  } catch {
    return false;
  }
}

/**
 * Problems with an iam-mode DATABASE_URL. An unparseable URL has already
 * been reported by the shared DATABASE_URL rule, and is skipped here: never
 * let `new URL()` throw, since its error carries the input (credentials
 * included).
 */
function iamUrlProblems(databaseUrl: string): string[] {
  const url = URL.parse(databaseUrl);
  if (url === null) {
    return [];
  }
  const problems: string[] = [];
  if (url.password.length > 0) {
    problems.push("must not include a password when DATABASE_AUTH_MODE is iam");
  }
  if (!isDecodable(url.username) || !isDecodable(url.pathname)) {
    problems.push("must use valid percent-encoding");
    return problems;
  }
  if (url.username.length === 0) {
    problems.push("must include the database user when DATABASE_AUTH_MODE is iam");
  }
  if (url.pathname.length <= 1) {
    problems.push("must include the database name when DATABASE_AUTH_MODE is iam");
  }
  if (url.hostname.startsWith("[")) {
    // RDS Proxy endpoints are DNS names; the token and the TLS host name
    // check are both bound to that name.
    problems.push(
      "must name the proxy by host name, not an IPv6 address, when DATABASE_AUTH_MODE is iam",
    );
  }
  if (url.port === "0") {
    problems.push("must not use port 0 when DATABASE_AUTH_MODE is iam");
  }
  if (url.search.length > 0) {
    problems.push(
      "must not include query parameters when DATABASE_AUTH_MODE is iam (TLS is enforced)",
    );
  }
  if (url.hash.length > 0) {
    problems.push("must not include a fragment when DATABASE_AUTH_MODE is iam");
  }
  return problems;
}

function hasIssueAt(
  issues: readonly { readonly path?: readonly PropertyKey[] | undefined }[],
  name: string,
) {
  return issues.some((issue) => issue.path?.[0] === name);
}

export const lambdaDatabaseEnvironmentSchema = withLambdaTelemetryEnvironment(
  databaseEnvironmentSchema
    .extend({ DATABASE_AUTH_MODE: authModeSchema, AWS_REGION: awsRegionSchema })
    // Checked even when DATABASE_URL is invalid, so every problem is reported.
    .refine(
      (environment) =>
        environment.DATABASE_AUTH_MODE !== "iam" || environment.AWS_REGION !== undefined,
      {
        path: ["AWS_REGION"],
        error: "is required when DATABASE_AUTH_MODE is iam",
        when: ({ issues }) =>
          !hasIssueAt(issues, "DATABASE_AUTH_MODE") && !hasIssueAt(issues, "AWS_REGION"),
      },
    )
    .superRefine((environment, context) => {
      if (environment.DATABASE_AUTH_MODE === "iam") {
        for (const message of iamUrlProblems(environment.DATABASE_URL)) {
          context.addIssue({ code: "custom", path: ["DATABASE_URL"], message });
        }
      }
    }),
);

export const lambdaHealthEnvironmentSchema =
  withLambdaTelemetryEnvironment(healthEnvironmentSchema);

/** What an IAM-authenticated pool needs; every field comes from the environment. */
export interface IamDatabaseAuthentication {
  readonly mode: "iam";
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly database: string;
  readonly region: string;
}

export type DatabaseAuthentication = { readonly mode: "password" } | IamDatabaseAuthentication;

export interface LambdaDatabaseConfig extends DatabaseConfig {
  readonly authentication: DatabaseAuthentication;
}

export type LambdaHealthConfig = Readonly<Record<string, never>>;

function iamAuthentication(databaseUrl: string, region: string): IamDatabaseAuthentication {
  // Validation has accepted the URL; still never let `new URL()` throw its
  // input into an error.
  const url = URL.parse(databaseUrl);
  if (url === null) {
    throw new Error("DATABASE_URL: must be a postgres:// or postgresql:// URL with a host");
  }
  return {
    mode: "iam",
    hostname: url.hostname,
    port: url.port === "" ? DEFAULT_POSTGRES_PORT : Number(url.port),
    username: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.slice(1)),
    region,
  };
}

/** For the verify and submit functions. */
export function parseLambdaDatabaseConfig(
  environment: Environment,
): ParseResult<LambdaDatabaseConfig> {
  return parseEnvironment(lambdaDatabaseEnvironmentSchema, environment, (data) => ({
    databaseUrl: data.DATABASE_URL,
    authentication:
      data.DATABASE_AUTH_MODE === "iam" && data.AWS_REGION !== undefined
        ? iamAuthentication(data.DATABASE_URL, data.AWS_REGION)
        : { mode: "password" },
  }));
}

/** For the health function: requires nothing (until #17 adds telemetry). */
export function parseLambdaHealthConfig(environment: Environment): ParseResult<LambdaHealthConfig> {
  return parseEnvironment(lambdaHealthEnvironmentSchema, environment, () => ({}));
}
