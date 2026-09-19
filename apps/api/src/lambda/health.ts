/**
 * AWS Lambda entrypoint for `GET /health` (handler `index.handler` in
 * `dist/lambda/health`). Requires no configuration and no database.
 *
 * @module
 */

import { composeHealthApplication } from "../endpoints/health/composition";
import { parseLambdaHealthConfig } from "./config";
import { initializeLambda } from "./runtime";

export const { handler } = initializeLambda({
  parse: parseLambdaHealthConfig,
  compose: () => composeHealthApplication(),
});
