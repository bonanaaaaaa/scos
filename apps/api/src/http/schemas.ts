/**
 * Schemas shared by more than one endpoint: request fields and response
 * building blocks.
 *
 * Numeric limits come from `@scos/core` (the quantity schema is composed
 * as-is; coordinate limits reuse the core constants), so the HTTP adapter and
 * the domain cannot drift apart.
 *
 * @module
 */

import { LATITUDE_LIMIT, LONGITUDE_LIMIT, quantitySchema } from "@scos/core";
import { z } from "zod";

/** Positive integer, at most core's `MAX_QUANTITY`. Strings are not coerced. */
export const quantityFieldSchema = quantitySchema;

/** Finite latitude in [-LATITUDE_LIMIT, LATITUDE_LIMIT] decimal degrees, inclusive. */
export const latitudeFieldSchema = z.number().min(-LATITUDE_LIMIT).max(LATITUDE_LIMIT);

/** Finite longitude in [-LONGITUDE_LIMIT, LONGITUDE_LIMIT] decimal degrees, inclusive. */
export const longitudeFieldSchema = z.number().min(-LONGITUDE_LIMIT).max(LONGITUDE_LIMIT);

/** A non-negative USD amount with exactly two fractional digits, e.g. "150.00". */
export const moneySchema = z.string().regex(/^\d{1,10}\.\d{2}$/);

/** The volume discount rate applied, as a two-decimal string, e.g. "0.05". */
export const discountRateSchema = z.string().regex(/^(?:0\.\d{2}|1\.00)$/);

export const destinationResponseSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});
