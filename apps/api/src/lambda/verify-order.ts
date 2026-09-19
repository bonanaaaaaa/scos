/**
 * AWS Lambda entrypoint for `POST /api/v1/orders/verify` (handler
 * `index.handler` in `dist/lambda/verify-order`). See `./config.ts` for the
 * environment and `./pool.ts` for the connection.
 *
 * @module
 */

import { composeVerifyOrderApplication } from "../endpoints/verify-order/composition";
import { databaseLambda } from "./database";
import { initializeLambda } from "./runtime";

export const { handler } = initializeLambda(databaseLambda(composeVerifyOrderApplication));
