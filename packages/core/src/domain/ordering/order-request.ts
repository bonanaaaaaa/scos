/**
 * Value object: OrderRequest.
 *
 * A validated request to estimate an order, with no identity. The Zod schema
 * is its constructor: a parsed request is proof its fields were validated.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { z } from "zod";

import {
  type Destination,
  destinationSchema,
  latitudeSchema,
  longitudeSchema,
} from "#domain/shared/destination";
import { type Quantity, quantitySchema } from "#domain/shared/quantity";

/** A validated order request; build one with {@link orderRequestSchema}. */
export interface OrderRequest {
  readonly quantity: Quantity;
  readonly destination: Destination;
}

/**
 * Domain input guard for a raw order request `{ quantity, latitude, longitude }`.
 * Object parsing reports every malformed field at once; the output is the
 * frozen, branded {@link OrderRequest} that `estimateOrder` requires.
 */
export const orderRequestSchema = z
  .object({ quantity: quantitySchema, latitude: latitudeSchema, longitude: longitudeSchema })
  .transform(({ quantity, latitude, longitude }): OrderRequest =>
    Object.freeze({
      quantity,
      // Already validated field by field; parsing again only applies the brand.
      destination: destinationSchema.parse({ latitude, longitude }),
    }),
  );
