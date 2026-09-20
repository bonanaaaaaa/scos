import { corePackage } from "@scos/core";

export const persistencePackage = Object.freeze({
  name: "persistence",
  supports: corePackage.name,
});

export { createDatabasePool, type DatabasePoolOptions, readDatabaseUrl } from "#database";
export { createPrismaInventoryReader, type InventoryReaderClient } from "#inventory-reader";
export { createPrismaClient, Prisma, type PrismaClient } from "#prisma";
export * from "#records";
export { seedWarehouses, warehouseSeeds, type SeedQueryable, type WarehouseSeed } from "#seed";
export { confirmDatabaseReset, resetConfirmationVariable } from "#reset";
export {
  createPrismaSubmissionStore,
  DEFAULT_SUBMISSION_TRANSACTION_OPTIONS,
  type PrismaSubmissionStoreOptions,
} from "#submission-store";
export { classifySubmissionError, PG_CONNECTION_TIMEOUT_MESSAGES } from "#submission-errors";
