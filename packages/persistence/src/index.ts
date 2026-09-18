import { corePackage } from "@scos/core";

export const persistencePackage = Object.freeze({
  name: "persistence",
  supports: corePackage.name,
});

export { createDatabasePool, readDatabaseUrl } from "./database.js";
export { createPrismaClient, Prisma, type PrismaClient } from "./prisma.js";
export * from "./records.js";
export { seedWarehouses, warehouseSeeds, type SeedQueryable, type WarehouseSeed } from "./seed.js";
export { confirmDatabaseReset, resetConfirmationVariable } from "./reset.js";
