import { describe, expect, test } from "vitest";

import type { GeoPoint } from "#domain/shared/destination";

import {
  EARTH_RADIUS_KM,
  centralAngleFromHaversine,
  haversineDistanceKm,
  haversineIntermediate,
} from "./distance";

const point = (latitude: number, longitude: number): GeoPoint => ({ latitude, longitude });

/**
 * Independent reference: the Vincenty special case for a sphere (atan2 form),
 * a different formula from Haversine that is well conditioned at all ranges.
 */
function vincentySphereKm(from: GeoPoint, to: GeoPoint): number {
  const rad = Math.PI / 180;
  const phi1 = from.latitude * rad;
  const phi2 = to.latitude * rad;
  const dLambda = (to.longitude - from.longitude) * rad;
  const y = Math.hypot(
    Math.cos(phi2) * Math.sin(dLambda),
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda),
  );
  const x = Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return EARTH_RADIUS_KM * Math.atan2(y, x);
}

/** Second independent reference: spherical law of cosines. */
function lawOfCosinesKm(from: GeoPoint, to: GeoPoint): number {
  const rad = Math.PI / 180;
  const phi1 = from.latitude * rad;
  const phi2 = to.latitude * rad;
  const dLambda = (to.longitude - from.longitude) * rad;
  return (
    EARTH_RADIUS_KM *
    Math.acos(Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(dLambda))
  );
}

describe("haversineDistanceKm", () => {
  test("uses the IUGG mean Earth radius", () => {
    expect(EARTH_RADIUS_KM).toBe(6371.0088);
  });

  test("identical locations are zero", () => {
    expect(haversineDistanceKm(point(33.9425, -118.408056), point(33.9425, -118.408056))).toBe(0);
    expect(haversineDistanceKm(point(90, 0), point(90, 123))).toBeCloseTo(0, 9);
  });

  test("pole to pole is half the circumference", () => {
    expect(haversineDistanceKm(point(90, 0), point(-90, 0))).toBeCloseTo(
      Math.PI * EARTH_RADIUS_KM,
      9,
    );
  });

  test("a quarter of the equator is a quarter circumference", () => {
    expect(haversineDistanceKm(point(0, 0), point(0, 90))).toBeCloseTo(
      (Math.PI / 2) * EARTH_RADIUS_KM,
      9,
    );
    expect(haversineDistanceKm(point(0, 0), point(90, 0))).toBeCloseTo(
      (Math.PI / 2) * EARTH_RADIUS_KM,
      9,
    );
  });

  test("crosses the date line along the short arc", () => {
    const oneDegree = (EARTH_RADIUS_KM * Math.PI) / 180;
    expect(haversineDistanceKm(point(0, 179.5), point(0, -179.5))).toBeCloseTo(oneDegree, 9);
    expect(haversineDistanceKm(point(0, 180), point(0, -180))).toBeCloseTo(0, 9);
  });

  test("exact and near antipodes stay finite and at most half the circumference", () => {
    const half = Math.PI * EARTH_RADIUS_KM;
    const pairs: [GeoPoint, GeoPoint][] = [
      [point(0, 0), point(0, 180)],
      [point(0, -90), point(0, 90)],
      [point(45, 30), point(-45, -150)],
      [point(1e-9, 0), point(-1e-9, 180)],
      [point(33.9425, -118.408056), point(-33.9425, 61.591944)],
      [point(89.999999, 0), point(-89.999999, 180)],
    ];
    for (const [from, to] of pairs) {
      const distance = haversineDistanceKm(from, to);
      expect(Number.isFinite(distance)).toBe(true);
      expect(distance).toBeLessThanOrEqual(half);
      expect(distance).toBeGreaterThan(half - 1e-3);
    }
  });

  test("clamps intermediates outside [0, 1] instead of producing NaN", () => {
    // Without the upper clamp, sqrt(1 + 2 ulp) > 1 and asin returns NaN.
    const aboveOne = 1 + 2 * Number.EPSILON;
    expect(Number.isNaN(Math.asin(Math.sqrt(aboveOne)))).toBe(true);
    expect(centralAngleFromHaversine(aboveOne)).toBe(Math.PI);
    expect(centralAngleFromHaversine(1.5)).toBe(Math.PI);
    // Without the lower clamp, sqrt of a negative drift value is NaN.
    expect(centralAngleFromHaversine(-Number.EPSILON)).toBe(0);
    expect(centralAngleFromHaversine(0.5)).toBeCloseTo(Math.PI / 2, 15);
  });

  test("handles a real pair whose Haversine intermediate rounds above 1", () => {
    const from = point(-83.5582880963103, 39.932617928632226);
    const to = point(83.5582880963103, -140.06738207136777);
    expect(haversineIntermediate(from, to)).toBeGreaterThan(1);
    const distance = haversineDistanceKm(from, to);
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 9);
  });

  test("near-antipodal pairs agree with the independent Vincenty sphere form", () => {
    const pairs: [GeoPoint, GeoPoint][] = [
      [point(10, 20), point(-10.001, -160)],
      [point(10, 20), point(-10, -159.999)],
      [point(0, 0), point(0.001, 180)],
      [point(45, 30), point(-45.001, -150.001)],
      [point(33.9425, -118.408056), point(-33.9435, 61.592944)],
    ];
    for (const [from, to] of pairs) {
      const distance = haversineDistanceKm(from, to);
      expect(distance).toBeLessThan(Math.PI * EARTH_RADIUS_KM);
      // Within 1 mm despite Haversine's reduced conditioning near antipodes.
      expect(Math.abs(distance - vincentySphereKm(from, to))).toBeLessThan(1e-6);
    }
  });

  test("is symmetric", () => {
    const a = point(-23.435556, -46.473056);
    const b = point(22.308889, 113.914444);
    expect(haversineDistanceKm(a, b)).toBe(haversineDistanceKm(b, a));
  });

  test("LAX to JFK matches independent spherical formulas", () => {
    const lax = point(33.9425, -118.408056);
    const jfk = point(40.639722, -73.778889);
    const distance = haversineDistanceKm(lax, jfk);
    expect(Math.abs(distance - vincentySphereKm(lax, jfk))).toBeLessThan(1e-9);
    expect(Math.abs(distance - lawOfCosinesKm(lax, jfk))).toBeLessThan(1e-6);
  });

  test("LAX to JFK matches the Aviation Formulary worked example's central angle", () => {
    // Ed Williams, "Aviation Formulary V1.47", worked example: LAX
    // (33deg57'N 118deg24'W) to JFK (40deg38'N 73deg47'W) is 0.623585 radians.
    // http://www.edwilliams.org/avform147.htm
    // The angle is independent of the Earth radius, which cancels out.
    const lax = point(33 + 57 / 60, -(118 + 24 / 60));
    const jfk = point(40 + 38 / 60, -(73 + 47 / 60));
    const centralAngle = haversineDistanceKm(lax, jfk) / EARTH_RADIUS_KM;
    expect(Math.abs(centralAngle - 0.623585)).toBeLessThan(1e-6);
  });

  test("agrees with the Vincenty sphere form across the PRD warehouse pairs", () => {
    const warehouses = [
      point(33.9425, -118.408056),
      point(40.639722, -73.778889),
      point(-23.435556, -46.473056),
      point(49.009722, 2.547778),
      point(52.165833, 20.967222),
      point(22.308889, 113.914444),
    ];
    for (const from of warehouses) {
      for (const to of warehouses) {
        expect(Math.abs(haversineDistanceKm(from, to) - vincentySphereKm(from, to))).toBeLessThan(
          1e-8,
        );
      }
    }
  });
});
