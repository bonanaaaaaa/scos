import {
  type Result,
  type ValidationError,
  type ValidationField,
  err,
  ok,
  validationError,
} from "./result";

/** A point on Earth in decimal degrees (WGS84-style latitude/longitude). */
export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

declare const destinationBrand: unique symbol;

/** A validated delivery location. Supplied precision is preserved unrounded. */
export type Destination = GeoPoint & { readonly [destinationBrand]: true };

export const LATITUDE_LIMIT = 90;
export const LONGITUDE_LIMIT = 180;

function checkCoordinate(
  field: ValidationField,
  value: unknown,
  limit: number,
): ValidationError | undefined {
  if (typeof value !== "number") {
    return validationError(field, "NOT_A_NUMBER", `${field} must be a number.`);
  }
  if (!Number.isFinite(value)) {
    return validationError(field, "NOT_FINITE", `${field} must be finite.`);
  }
  if (value < -limit || value > limit) {
    return validationError(
      field,
      "OUT_OF_RANGE",
      `${field} must be between -${limit} and ${limit} inclusive.`,
    );
  }
  return undefined;
}

/** Returns true for finite coordinates inside the inclusive geographic bounds. */
export function isValidGeoPoint(point: GeoPoint): boolean {
  return (
    checkCoordinate("latitude", point.latitude, LATITUDE_LIMIT) === undefined &&
    checkCoordinate("longitude", point.longitude, LONGITUDE_LIMIT) === undefined
  );
}

/**
 * Validates client-supplied coordinates. Returns every field error at once as a
 * `Result` rather than throwing (see "Error handling" in packages/core/README.md).
 */
export function parseDestination(
  latitude: unknown,
  longitude: unknown,
): Result<Destination, readonly ValidationError[]> {
  const errors = [
    checkCoordinate("latitude", latitude, LATITUDE_LIMIT),
    checkCoordinate("longitude", longitude, LONGITUDE_LIMIT),
  ].filter((error): error is ValidationError => error !== undefined);
  if (errors.length > 0) {
    return err(Object.freeze(errors));
  }
  return ok(Object.freeze({ latitude, longitude }) as Destination);
}
