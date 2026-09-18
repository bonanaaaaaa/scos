import { orderingPackage } from "@scos/ordering";
import { persistencePackage } from "@scos/persistence";
import { Hono } from "hono";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.json({ status: "ok" }));

  return app;
}

export const app = createApp();

export function workspaceComposition(): readonly string[] {
  return [orderingPackage.name, persistencePackage.name];
}
