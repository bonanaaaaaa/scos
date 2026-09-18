import { serve } from "@hono/node-server";

import { app } from "./index.js";

const defaultPort = 3000;
const configuredPort = process.env.PORT;
const port = configuredPort === undefined ? defaultPort : Number(configuredPort);

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`PORT must be an integer between 0 and 65535; received ${configuredPort}`);
}

serve({ fetch: app.fetch, port }, (serverInfo) => {
  console.log(`SCOS API listening on http://localhost:${serverInfo.port}`);
});
