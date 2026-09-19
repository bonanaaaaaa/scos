/**
 * Value object: Destination.
 *
 * A delivery location with no identity, equal by its coordinates. It is
 * branded: holding a `Destination` proves the coordinates were validated.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import { z } from "zod";

/** A point on Earth in decimal degrees (WGS84-style latitude/longitude). */
export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export const LATITUDE_LIMIT = 90;
export const LONGITUDE_LIMIT = 180;

/** Finite latitude in [-90, 90] inclusive; NaN and ±Infinity are rejected. */
export const latitudeSchema = z.number().min(-LATITUDE_LIMIT).max(LATITUDE_LIMIT);

/** Finite longitude in [-180, 180] inclusive; NaN and ±Infinity are rejected. */
export const longitudeSchema = z.number().min(-LONGITUDE_LIMIT).max(LONGITUDE_LIMIT);

/** Unbranded coordinate check, shared by the domain's invariant guards. */
export const geoPointSchema = z.object({ latitude: latitudeSchema, longitude: longitudeSchema });

/**
 * Domain input guard for a delivery location. Parsing reports every invalid
 * coordinate, strips unknown keys, preserves supplied precision unrounded and
 * returns a frozen value. Callers use `.safeParse` (see "Error handling" in
 * packages/core/README.md).
 */
export const destinationSchema = geoPointSchema.readonly().brand<"Destination">();

/** A validated delivery location. Supplied precision is preserved unrounded. */
export type Destination = z.infer<typeof destinationSchema>;
