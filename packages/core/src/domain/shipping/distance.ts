/**
 * Domain service: Distance.
 *
 * A pure geometric calculation: the great-circle distance between two points,
 * with no state and no business policy.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import type { GeoPoint } from "#domain/shared/destination";

/**
 * Mean Earth radius in kilometres: the IUGG mean radius R1 = (2a + b) / 3 of
 * the GRS80 ellipsoid, 6371.0088 km (WGS84 gives the same value to this
 * precision). Used consistently for verification and submission.
 *
 * @see H. Moritz, "Geodetic Reference System 1980", Bulletin Géodésique 54
 *   (1980) — defines the GRS80 ellipsoid and its mean radius R1.
 * @see H. Moritz, "Geodetic Reference System 1980", Journal of Geodesy 74
 *   (2000) 128–133, https://doi.org/10.1007/s001900050278 — republished
 *   GRS80 document; mean radius R1 = 6371.0088 km.
 * @see https://en.wikipedia.org/wiki/Earth_radius#Arithmetic_mean_radius —
 *   readable summary of the IUGG mean radius R1 = 6371.0088 km.
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
 *
 * @see R. W. Sinnott, "Virtues of the Haversine", Sky and Telescope 68(2)
 *   (1984) 159 — original formulation.
 * @see https://en.wikipedia.org/wiki/Haversine_formula — formula and the
 *   note that rounding error can push `a` slightly outside [0, 1].
 * @see https://www.movable-type.co.uk/scripts/latlong.html — reference
 *   JavaScript implementation of the same formula.
 * @see docs/design-decisions.md, section "Distance calculation and precision"
 *   — project policy for number arithmetic, clamping and no rounding.
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
 *
 * @see https://en.wikipedia.org/wiki/Haversine_formula — notes that rounding
 *   error can push the intermediate outside [0, 1], so it must be kept in range.
 * @see https://www.movable-type.co.uk/scripts/latlong.html — reference
 *   implementation of the same Haversine formula.
 */
export function centralAngleFromHaversine(a: number): number {
  return 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
