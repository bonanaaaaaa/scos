import { corePackage } from "@scos/core";

export const persistencePackage = Object.freeze({
  name: "persistence",
  supports: corePackage.name,
});

export { createDatabasePool, readDatabaseUrl } from "./database";
