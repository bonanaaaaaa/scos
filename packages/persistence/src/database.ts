import { Pool } from "pg";

export function readDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

export function createDatabasePool(connectionString = readDatabaseUrl()): Pool {
  return new Pool({ connectionString });
}
