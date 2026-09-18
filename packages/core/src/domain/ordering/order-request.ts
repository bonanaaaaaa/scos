import { z } from "zod";

import { destinationSchema, latitudeSchema, longitudeSchema } from "../shared/destination";
import type { OrderRequest } from "./estimate";
import { quantitySchema } from "../shared/quantity";

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
