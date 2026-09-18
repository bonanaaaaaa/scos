import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";

import { app } from "./index.js";

const defaultPort = 3000;

export function parsePort(configuredPort: string | undefined): number {
  const port = configuredPort === undefined ? defaultPort : Number(configuredPort);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer between 0 and 65535; received ${configuredPort}`);
  }

  return port;
}

interface ServerInfo {
  readonly port: number;
}

type ServeApplication = (
  options: { fetch: typeof app.fetch; port: number },
  onListening: (serverInfo: ServerInfo) => void,
) => unknown;

export function startServer(
  configuredPort = process.env.PORT,
  serveApplication: ServeApplication = serve,
  log: (message: string) => void = console.log,
): unknown {
  return serveApplication({ fetch: app.fetch, port: parsePort(configuredPort) }, (serverInfo) => {
    log(`SCOS API listening on http://localhost:${serverInfo.port}`);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
