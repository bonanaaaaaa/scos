import type { GeoPoint } from "./destination";

/**
 * Mean Earth radius in kilometres: the IUGG mean radius R1 = (2a + b) / 3 of
 * the WGS84 ellipsoid, 6371.0088 km (Moritz, "Geodetic Reference System 1980",
 * as adopted by the IUGG). Used consistently for verification and submission.
 */
export const EARTH_RADIUS_KM = 6371.0088;

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Great-circle distance in kilometres using the Haversine formula on a
 * spherical Earth with JavaScript number arithmetic.
 *
 * With φ = latitude and λ = longitude in radians, Δφ = φ₂ − φ₁,
 * Δλ = λ₂ − λ₁ and R = {@link EARTH_RADIUS_KM}:
 *
 * ```text
 * a = sin²(Δφ / 2) + cos φ₁ · cos φ₂ · sin²(Δλ / 2)
 * θ = 2 · asin(√clamp(a, 0, 1))
 * d = R · θ
 * ```
 *
 * Coordinates are used exactly as supplied (no rounding). The Haversine
 * intermediate is clamped to [0, 1] so floating-point drift near identical or
 * antipodal points cannot produce NaN. The result is not rounded; convert it to
 * decimal.js through its string form for monetary arithmetic.
 */
export function haversineDistanceKm(from: GeoPoint, to: GeoPoint): number {
  return EARTH_RADIUS_KM * centralAngleFromHaversine(haversineIntermediate(from, to));
}

/**
 * The unclamped Haversine intermediate, a = hav(θ). Internal.
 *
 * ```text
 * a = sin²(Δφ / 2) + cos φ₁ · cos φ₂ · sin²(Δλ / 2)
 * ```
 */
export function haversineIntermediate(from: GeoPoint, to: GeoPoint): number {
  const lat1 = from.latitude * DEGREES_TO_RADIANS;
  const lat2 = to.latitude * DEGREES_TO_RADIANS;
  const deltaLat = (to.latitude - from.latitude) * DEGREES_TO_RADIANS;
  const deltaLon = (to.longitude - from.longitude) * DEGREES_TO_RADIANS;

  const sinHalfLat = Math.sin(deltaLat / 2);
  const sinHalfLon = Math.sin(deltaLon / 2);
  return sinHalfLat * sinHalfLat + Math.cos(lat1) * Math.cos(lat2) * sinHalfLon * sinHalfLon;
}

/**
 * Central angle in radians from a Haversine intermediate, clamped to [0, 1].
 *
 * ```text
 * θ = 2 · asin(√min(1, max(0, a)))
 * ```
 *
 * Floating-point drift can push the intermediate just above 1 near antipodes;
 * values beyond one ulp above 1 would make Math.asin(Math.sqrt(a)) NaN. Internal.
 */
export function centralAngleFromHaversine(a: number): number {
  return 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
