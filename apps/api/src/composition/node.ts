/**
 * The combined composition: every route over one pool, for the local server
 * (`entrypoints/node.ts`) and the documentation routes. Each endpoint also has its own
 * composition in `endpoints/<name>/composition.ts`, building only what that
 * endpoint needs.
 *
 * @module
 */

import { createApp } from "#app";
import { type ComposedApplication, composeOverDatabase, withLogger } from "#composition/database";
import {
  type SubmitOrderCompositionOptions,
  buildSubmitOrder,
} from "#endpoints/submit-order/composition";
import { buildVerifyOrder } from "#endpoints/verify-order/composition";

export type { ComposedApplication } from "#composition/database";

/** Everything, for the local server: all options of both database endpoints. */
export type CompositionOptions = SubmitOrderCompositionOptions;

export function composeApplication(options: CompositionOptions): ComposedApplication {
  return composeOverDatabase(options, (prisma) =>
    createApp({
      verifyOrder: buildVerifyOrder(prisma, options.telemetry),
      submitOrder: buildSubmitOrder(prisma, options),
      ...withLogger(options.logger),
    }),
  );
}
