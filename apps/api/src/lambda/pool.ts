/**
 * The pg pool of a Lambda execution environment, for the verify and submit
 * functions.
 *
 * Pool size: an execution environment serves one invocation at a time, so
 * one connection is all it can use. RDS Proxy pools across environments and
 * bounds what reaches PostgreSQL; `max: 1` keeps each environment's demand on
 * the proxy at one client connection.
 *
 * Idle eviction (`idleTimeoutMillis: 0`, meaning never): between invocations
 * Lambda freezes the environment, and pg's idle timer cannot run while it is
 * frozen, so no client-side value can close the connection before a long
 * freeze. Its only effect would be to fire on thaw (timers are overdue then)
 * and drop a healthy connection just before the next invocation wants it,
 * paying TLS, a new IAM token and a proxy handshake again. So the one
 * connection is kept for the life of the environment, and closing abandoned
 * connections is left to the proxy's idle client timeout (RDS Proxy
 * `IdleClientTimeout`, 1800 s by default), which runs on the proxy side
 * whether or not the environment is frozen. If an environment stays frozen
 * longer than that, the proxy has closed the connection: pg sees the closed
 * socket on thaw and discards it (the Prisma pg adapter listens for idle
 * client errors, so it cannot crash the process). A request that races the
 * close fails with 500 or 503 and is safe to retry with the same
 * `submissionId` (ADR 0004).
 *
 * The bounded `connectionTimeoutMillis` from `databasePoolTimeouts` applies
 * in both modes.
 *
 * @module
 */

import { Signer } from "@aws-sdk/rds-signer";
import { type DatabasePoolOptions, createDatabasePool } from "@scos/persistence";
import { Pool, type PoolConfig } from "pg";

import type { IamDatabaseAuthentication, LambdaDatabaseConfig } from "./config";

/** Pool settings for one Lambda execution environment (see the module notes). */
export const LAMBDA_POOL_OPTIONS = { max: 1, idleTimeoutMillis: 0 } as const;

/** Mints RDS IAM authentication tokens (`Signer` from `@aws-sdk/rds-signer`). */
export interface AuthTokenSigner {
  getAuthToken(): Promise<string>;
}

export interface AuthTokenSignerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly region: string;
}

export type CreateAuthTokenSigner = (options: AuthTokenSignerOptions) => AuthTokenSigner;

/**
 * The real signer. It signs locally (SigV4 presigning) with credentials from
 * the default provider chain, which in Lambda reads the execution role's
 * credentials from the environment. Constructing it makes no network call.
 */
export const createRdsAuthTokenSigner: CreateAuthTokenSigner = (options) =>
  new Signer({ ...options });

/**
 * pg configuration for IAM database authentication through RDS Proxy.
 *
 * - `password` is a function, which pg calls for every new physical
 *   connection, so each connection authenticates with a freshly minted token.
 *   Tokens are valid for 15 minutes but only matter while authenticating;
 *   nothing caches or logs them.
 * - No `connectionString`: pg lets a connection string override the explicit
 *   options (an empty password would replace the token function, and
 *   `sslmode` would replace `ssl`), so host, port, user and database are
 *   passed separately.
 * - TLS is mandatory with certificate and host name verification. RDS Proxy
 *   presents an AWS Certificate Manager certificate that chains to the Amazon
 *   Root CAs in Node.js's bundled trust store, so no CA bundle is shipped.
 */
export function iamPoolConfig(
  authentication: IamDatabaseAuthentication,
  timeouts: DatabasePoolOptions,
  createSigner: CreateAuthTokenSigner = createRdsAuthTokenSigner,
): PoolConfig {
  const signer = createSigner({
    hostname: authentication.hostname,
    port: authentication.port,
    username: authentication.username,
    region: authentication.region,
  });
  return {
    ...timeouts,
    ...LAMBDA_POOL_OPTIONS,
    host: authentication.hostname,
    port: authentication.port,
    user: authentication.username,
    database: authentication.database,
    ssl: { rejectUnauthorized: true },
    password: () => signer.getAuthToken(),
  };
}

/**
 * The `createPool` option for the verify and submit compositions. Nothing
 * connects, and no token is minted, until the first query.
 */
export function lambdaPoolFactory(
  config: LambdaDatabaseConfig,
  createSigner: CreateAuthTokenSigner = createRdsAuthTokenSigner,
): (timeouts: DatabasePoolOptions) => Pool {
  const authentication = config.authentication;
  if (authentication.mode === "iam") {
    return (timeouts) => new Pool(iamPoolConfig(authentication, timeouts, createSigner));
  }
  return (timeouts) =>
    createDatabasePool(config.databaseUrl, { ...timeouts, ...LAMBDA_POOL_OPTIONS });
}
