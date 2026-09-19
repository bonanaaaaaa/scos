import { corePackage } from "@scos/core";

export const persistencePackage = Object.freeze({
  name: "persistence",
  supports: corePackage.name,
});

export { createDatabasePool, readDatabaseUrl } from "./database";
export { createPrismaClient, Prisma, type PrismaClient } from "./prisma";
export * from "./records";
export { seedWarehouses, warehouseSeeds, type SeedQueryable, type WarehouseSeed } from "./seed";
export { confirmDatabaseReset, resetConfirmationVariable } from "./reset";
