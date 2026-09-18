import { orderingPackage } from "@scos/ordering";

export const persistencePackage = Object.freeze({
  name: "persistence",
  supports: orderingPackage.name,
});

export { createDatabasePool, readDatabaseUrl } from "./database.js";
