import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool } from "pg";

import { PrismaClient } from "./generated/prisma/client";

export type { PrismaClient } from "./generated/prisma/client";
export { Prisma } from "./generated/prisma/client";

/**
 * Builds a Prisma client over an existing pg pool from createDatabasePool.
 *
 * The caller owns the pool: `$disconnect()` releases Prisma's use of it but
 * does not end it. Call `pool.end()` after disconnecting the client.
 */
export function createPrismaClient(pool: Pool): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: false }) });
}
