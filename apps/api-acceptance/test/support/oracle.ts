/**
 * An independent oracle for the expected amounts, written from the PRD rules
 * (docs/prd/scos-ordering.md) rather than from `@scos/core`.
 *
 * Deriving the expectations from the implementation would make the acceptance
 * suite agree with whatever the app does, so this module deliberately
 * re-derives everything from the documented rules: $150 per unit, 0/5/10/15/20%
 * at 25/50/100/250 units, nearest-first allocation (ties by warehouse ID),
 * shipping 0.365 kg x $0.01/kg/km x great-circle km summed and rounded once
 * half-up to cents, and a limit of 15% of the discounted merchandise total.
 * Keep it free of any dependency on the application code.
 *
 * @module
 */

import { expect } from "vitest";

import { type Warehouse, ORDER_NUMBER, WAREHOUSES } from "#test/support/prd";

/** Mean Earth radius used for the great-circle distance (IUGG R1, km). */
const EARTH_RADIUS_KM = 6371.0088;

export function greatCircleKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLon = rad(to.longitude - from.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** An exact decimal n / 10^scale from a JavaScript number's shortest string. */
export function exactDecimal(value: number): { n: bigint; scale: number } {
  const [mantissa = "0", exponentText = "0"] = String(value).toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole = "0", fraction = ""] = mantissa.split(".");
  let n = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    n *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { n, scale };
}

export function formatCents(cents: bigint): string {
  const text = cents.toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** Discount percentage for a quantity (PRD tiers). */
export function discountPercent(quantity: number): number {
  if (quantity >= 250) return 20;
  if (quantity >= 100) return 15;
  if (quantity >= 50) return 10;
  if (quantity >= 25) return 5;
  return 0;
}

export interface Merchandise {
  merchandiseSubtotal: string;
  discountRate: string;
  discountAmount: string;
  discountedMerchandiseTotal: string;
}

export function merchandiseFor(quantity: number): Merchandise & { discountedCents: bigint } {
  const percent = BigInt(discountPercent(quantity));
  const subtotal = BigInt(quantity) * 15_000n;
  const discount = (subtotal * percent) / 100n; // exact: 150 * percent cents per unit
  const discounted = subtotal - discount;
  return {
    merchandiseSubtotal: formatCents(subtotal),
    discountRate: `0.${percent.toString().padStart(2, "0")}`,
    discountAmount: formatCents(discount),
    discountedMerchandiseTotal: formatCents(discounted),
    discountedCents: discounted,
  };
}

/** Combined shipping, summed exactly and rounded once half-up to cents. */
export function shippingCents(allocations: readonly { quantity: number; distanceKm: number }[]) {
  const parts = allocations.map(({ quantity, distanceKm }) => ({
    quantity,
    ...exactDecimal(distanceKm),
  }));
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  // 0.365 kg x 0.01 $/kg/km = 365 / 10^5 $ per unit-km.
  const numerator = parts.reduce(
    (sum, part) => sum + BigInt(part.quantity) * 365n * part.n * 10n ** BigInt(scale - part.scale),
    0n,
  );
  const denominator = 10n ** BigInt(5 + scale);
  // dollars = numerator / denominator; cents rounded half-up.
  return (numerator * 200n + denominator) / (2n * denominator);
}

export interface PlannedAllocation {
  warehouseId: string;
  quantity: number;
  distanceKm: number;
}

/** Nearest-first allocation, ties by warehouse ID; null when stock is short. */
export function allocate(
  quantity: number,
  destination: { latitude: number; longitude: number },
  stock: readonly Warehouse[] = WAREHOUSES,
): PlannedAllocation[] | null {
  if (stock.reduce((sum, w) => sum + w.stock, 0) < quantity) {
    return null;
  }
  const ranked = stock
    .filter((w) => w.stock > 0)
    .map((w) => ({ w, distanceKm: greatCircleKm(w, destination) }))
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.w.id < b.w.id ? -1 : 1));
  const plan: PlannedAllocation[] = [];
  let remaining = quantity;
  for (const { w, distanceKm } of ranked) {
    if (remaining === 0) break;
    const take = Math.min(remaining, w.stock);
    plan.push({ warehouseId: w.id, quantity: take, distanceKm });
    remaining -= take;
  }
  return plan;
}

/**
 * The expected `/api/v1/orders/verify` body for a request against the given stock.
 * Distances are matched to 1e-6 km; amounts are exact strings.
 */
export function expectedEstimate(
  quantity: number,
  destination: { latitude: number; longitude: number },
  stock: readonly Warehouse[] = WAREHOUSES,
): Record<string, unknown> {
  const { discountedCents, ...merchandise } = merchandiseFor(quantity);
  const plan = allocate(quantity, destination, stock);
  if (plan === null) {
    return {
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      quantity,
      destination: { latitude: destination.latitude, longitude: destination.longitude },
      ...merchandise,
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    };
  }
  const shipping = shippingCents(plan);
  // shipping <= 0.15 x discounted  <=>  100 x shipping <= 15 x discounted
  const withinLimit = shipping * 100n <= discountedCents * 15n;
  return {
    valid: withinLimit,
    reason: withinLimit ? null : "SHIPPING_EXCEEDS_LIMIT",
    quantity,
    destination: { latitude: destination.latitude, longitude: destination.longitude },
    ...merchandise,
    shippingCost: formatCents(shipping),
    orderTotal: formatCents(discountedCents + shipping),
    allocations: plan.map(({ warehouseId, quantity: units, distanceKm }) => ({
      warehouseId,
      quantity: units,
      distanceKm: expect.closeTo(distanceKm, 6),
    })),
  };
}

/** The expected 201 body for an accepted submission (orderNumber by pattern). */
export function expectedOrder(
  submissionId: string,
  quantity: number,
  destination: { latitude: number; longitude: number },
  stock: readonly Warehouse[] = WAREHOUSES,
): Record<string, unknown> {
  const estimate = expectedEstimate(quantity, destination, stock);
  if (estimate.valid !== true) {
    throw new Error(`Oracle: ${String(estimate.reason)} for ${quantity} units`);
  }
  return {
    orderNumber: expect.stringMatching(ORDER_NUMBER),
    submissionId,
    quantity,
    destination: estimate.destination,
    unitPrice: "150.00",
    merchandiseSubtotal: estimate.merchandiseSubtotal,
    discountRate: estimate.discountRate,
    discountAmount: estimate.discountAmount,
    discountedMerchandiseTotal: estimate.discountedMerchandiseTotal,
    shippingCost: estimate.shippingCost,
    orderTotal: estimate.orderTotal,
    allocations: (estimate.allocations as PlannedAllocation[]).map(
      ({ warehouseId, quantity: units }) => ({
        warehouseId,
        quantity: units,
      }),
    ),
  };
}

/** Stock remaining after deducting accepted allocations, for follow-up oracles. */
export function afterDeducting(
  stock: readonly Warehouse[],
  allocations: readonly { warehouseId: string; quantity: number }[],
): Warehouse[] {
  return stock.map((w) => {
    const taken = allocations
      .filter((a) => a.warehouseId === w.id)
      .reduce((sum, a) => sum + a.quantity, 0);
    return { ...w, stock: w.stock - taken };
  });
}

// ---------------------------------------------------------------------------
// Shipping-limit destinations (1 unit: limit 15% x 150.00 = 22.50)
// ---------------------------------------------------------------------------

/** A destination whose 1-unit estimate ships from one warehouse for an exact charge. */
export interface LimitDestination {
  readonly latitude: number;
  readonly longitude: number;
  readonly warehouse: Warehouse;
  readonly distanceKm: number;
  readonly shippingCost: string;
}

/**
 * The point `distanceKm` along the great circle from `from` at `bearing`
 * degrees (spherical direct problem, same Earth radius as the oracle).
 */
export function pointAt(
  from: { latitude: number; longitude: number },
  bearing: number,
  distanceKm: number,
): { latitude: number; longitude: number } {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const deg = (radians: number) => (radians * 180) / Math.PI;
  const angular = distanceKm / EARTH_RADIUS_KM;
  const lat1 = rad(from.latitude);
  const theta = rad(bearing);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(theta),
  );
  const lon2 =
    rad(from.longitude) +
    Math.atan2(
      Math.sin(theta) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  const longitude = ((((deg(lon2) + 180) % 360) + 360) % 360) - 180;
  // Six decimals (~0.1 m) keep request bodies readable; the oracle re-checks below.
  return { latitude: Number(deg(lat2).toFixed(6)), longitude: Number(longitude.toFixed(6)) };
}

/** Minimum gap to the second-nearest warehouse, so the allocation is unambiguous. */
export const NEAREST_MARGIN_KM = 100;

/**
 * Finds a destination whose nearest warehouse is the only one used for 1 unit
 * and whose rounded shipping is exactly `cents`. The charge window for `c`
 * cents is [(c - 0.5) / 0.365, (c + 0.5) / 0.365) km; the target is its
 * middle, about 1.37 km from either edge, far beyond any floating-point
 * difference between this oracle and the implementation.
 *
 * The result is asserted against the independent oracle (distance, nearest
 * warehouse by a clear margin, charge in cents), so a wrong point fails here
 * rather than silently weakening a test.
 */
export function destinationWithShippingCents(cents: number): LimitDestination {
  const targetKm = cents / 0.365;
  for (const origin of WAREHOUSES) {
    for (let bearing = 0; bearing < 360; bearing += 1) {
      const point = pointAt(origin, bearing, targetKm);
      const ranked = WAREHOUSES.map((w) => ({ w, km: greatCircleKm(w, point) })).sort(
        (a, b) => a.km - b.km,
      );
      const [nearest, second] = ranked;
      if (
        nearest === undefined ||
        second === undefined ||
        nearest.w.id !== origin.id ||
        second.km - nearest.km < NEAREST_MARGIN_KM
      ) {
        continue;
      }
      const charged = shippingCents([{ quantity: 1, distanceKm: nearest.km }]);
      expect(charged, `oracle shipping for ${JSON.stringify(point)}`).toBe(BigInt(cents));
      expect(Math.abs(nearest.km - targetKm)).toBeLessThan(0.01);
      expect(allocate(1, point)).toStrictEqual([
        { warehouseId: origin.id, quantity: 1, distanceKm: nearest.km },
      ]);
      return {
        ...point,
        warehouse: origin,
        distanceKm: nearest.km,
        shippingCost: formatCents(charged),
      };
    }
  }
  throw new Error(`No destination found with 1-unit shipping of ${cents} cents`);
}

/** 1 unit: shipping 22.49, one cent under the 22.50 limit. */
export const BELOW_LIMIT = destinationWithShippingCents(2249);
/** 1 unit: shipping exactly 22.50, the limit (equality is valid). */
export const AT_LIMIT = destinationWithShippingCents(2250);
/** 1 unit: shipping 22.51, one cent over the limit. */
export const ABOVE_LIMIT = destinationWithShippingCents(2251);
