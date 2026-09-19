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

import { LATITUDE_LIMIT, LONGITUDE_LIMIT, MAX_QUANTITY, quantitySchema } from "@scos/core";
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

/**
 * A quantity in a response: the ordered quantity or a warehouse's share of it.
 * Unbranded (responses are built, not parsed) with the request's limits.
 */
export const responseQuantitySchema = z.number().int().positive().max(MAX_QUANTITY);

/**
 * A warehouse ID in canonical 8-4-4-4-12 hex UUID form. Warehouses are
 * generated as UUIDv7 (the seeded IDs and the database default), but the
 * PostgreSQL `uuid` column accepts any 128-bit value, so the schema checks the
 * form only, not RFC 9562 version or variant bits (`z.guid()`, not `z.uuid()`).
 * Clients should treat it as opaque.
 */
export const warehouseIdSchema = z.guid();

/** The destination as validated from the request, echoed back. */
export const destinationResponseSchema = z.object({
  latitude: latitudeFieldSchema,
  longitude: longitudeFieldSchema,
});
