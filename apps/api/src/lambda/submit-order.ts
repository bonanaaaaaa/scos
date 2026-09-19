/**
 * AWS Lambda entrypoint for `POST /api/v1/orders` (handler `index.handler` in
 * `dist/lambda/submit-order`). See `./config.ts` for the environment and
 * `./pool.ts` for the connection.
 *
 * @module
 */

import { composeSubmitOrderApplication } from "../endpoints/submit-order/composition";
import { databaseLambda } from "./database";
import { initializeLambda } from "./runtime";

export const { handler } = initializeLambda(databaseLambda(composeSubmitOrderApplication));
