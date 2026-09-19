import { Pool, type PoolConfig } from "pg";

export function readDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

/**
 * pg pool settings accepted by {@link createDatabasePool}. The connection
 * string is its own argument; everything else (for example
 * `connectionTimeoutMillis`) is passed to pg unchanged.
 */
export type DatabasePoolOptions = Omit<PoolConfig, "connectionString">;

/**
 * Creates a pg pool. pg's default waits forever for a connection; runtime
 * callers should pass a bounded `connectionTimeoutMillis`. Do not set a
 * client-side `query_timeout`: when it fires inside a Prisma interactive
 * transaction, the rollback can be dropped and the connection returned to
 * the pool with the transaction still open (see docs/database-schema.md).
 */
export function createDatabasePool(
  connectionString = readDatabaseUrl(),
  options: DatabasePoolOptions = {},
): Pool {
  return new Pool({ ...options, connectionString });
}
