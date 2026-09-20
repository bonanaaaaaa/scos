/**
 * The route/status table of the whole API, assembled from each endpoint's own
 * contract. Pure: it reads no environment and opens no connection, so an
 * offline OpenAPI export (`src/openapi/`) can import it.
 *
 * @module
 */

import { healthRoute } from "#endpoints/health/contract";
import { submitOrderRoute } from "#endpoints/submit-order/contract";
import { verifyOrderRoute } from "#endpoints/verify-order/contract";
import type { RouteContract } from "#http/route-contract";

/**
 * Every route the API serves with each documented status, and the standalone
 * app that serves it (`servedBy`). Each standalone app, and the combined
 * `createApp`, returns 404 with `errorResponseSchema` and code `NOT_FOUND`
 * for any other method or path (`notFoundResponse`).
 */
export const routes = {
  health: healthRoute,
  verifyOrder: verifyOrderRoute,
  submitOrder: submitOrderRoute,
} as const satisfies Record<string, RouteContract>;
