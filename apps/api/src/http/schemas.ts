/**
 * Schemas shared by more than one endpoint: request fields and response
 * building blocks. `.meta({ id, description })` names a schema as an OpenAPI
 * component (`components.schemas`) and documents it; hono-openapi converts
 * the schemas with Zod's own `z.toJSONSchema`.
 *
 * Numeric limits come from `@scos/core` (the quantity schema is composed
 * as-is; coordinate limits reuse the core constants), so the HTTP adapter and
 * the domain cannot drift apart.
 *
 * @module
 */

import { LATITUDE_LIMIT, LONGITUDE_LIMIT, MAX_QUANTITY, quantitySchema } from "@scos/core";
import { z } from "zod";

/**
 * Positive integer, at most core's `MAX_QUANTITY`. Strings are not coerced.
 * Core's schema, composed as-is; `.meta` names it for the OpenAPI document.
 */
export const quantityFieldSchema = quantitySchema.meta({
  id: "Quantity",
  description: `Number of units: a JSON integer from 1 to ${MAX_QUANTITY} inclusive (the largest quantity whose subtotal fits the stored amount). Strings such as "10" are rejected, not coerced.`,
});

/** Finite latitude in [-LATITUDE_LIMIT, LATITUDE_LIMIT] decimal degrees, inclusive. */
export const latitudeFieldSchema = z.number().min(-LATITUDE_LIMIT).max(LATITUDE_LIMIT).meta({
  id: "Latitude",
  description: "Destination latitude in decimal degrees, -90 to 90 inclusive. A JSON number.",
});

/** Finite longitude in [-LONGITUDE_LIMIT, LONGITUDE_LIMIT] decimal degrees, inclusive. */
export const longitudeFieldSchema = z.number().min(-LONGITUDE_LIMIT).max(LONGITUDE_LIMIT).meta({
  id: "Longitude",
  description: "Destination longitude in decimal degrees, -180 to 180 inclusive. A JSON number.",
});

/** A non-negative USD amount with exactly two fractional digits, e.g. "150.00". */
export const moneySchema = z
  .string()
  .regex(/^\d{1,10}\.\d{2}$/)
  .meta({
    id: "Money",
    description:
      'A non-negative USD amount as a decimal string with exactly two fractional digits, such as "150.00"; never a JSON number, so no precision is lost. At most "9999999999.99".',
  });

/** The volume discount rate applied, as a two-decimal string, e.g. "0.05". */
export const discountRateSchema = z
  .string()
  .regex(/^(?:0\.\d{2}|1\.00)$/)
  .meta({
    id: "DiscountRate",
    description:
      'The volume discount rate applied, as a two-decimal string from "0.00" to "1.00", such as "0.05".',
  });

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
export const warehouseIdSchema = z.guid().meta({
  id: "WarehouseId",
  description:
    "A warehouse's ID in canonical UUID form (8-4-4-4-12 hex digits). Warehouses are created with UUIDv7 IDs (the seeded warehouses and the database default), but the version is not guaranteed: treat it as an opaque identifier.",
});

/** The destination as validated from the request, echoed back. */
export const destinationResponseSchema = z
  .object({
    latitude: latitudeFieldSchema,
    longitude: longitudeFieldSchema,
  })
  .meta({ id: "Destination", description: "The requested destination, echoed back." });
