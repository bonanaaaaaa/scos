import { orderingPackage } from "@scos/ordering";
import { persistencePackage } from "@scos/persistence";

export function workspaceComposition(): readonly string[] {
  return [orderingPackage.name, persistencePackage.name];
}
