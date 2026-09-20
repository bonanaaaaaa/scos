/**
 * PRD facts the acceptance suite asserts against (docs/prd/scos-ordering.md).
 *
 * Seed data, the destinations the scenarios use, and the externally visible
 * contract constants (the Order number pattern, the Order response key set).
 * These are transcribed from the PRD and the API contract, never imported from
 * the implementation, so a change in the app cannot silently move the target.
 *
 * @module
 */

export interface Warehouse {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly stock: number;
}

export const WAREHOUSES: readonly Warehouse[] = [
  {
    id: "01996000-0000-7000-8000-000000000001",
    name: "Los Angeles",
    latitude: 33.9425,
    longitude: -118.408056,
    stock: 355,
  },
  {
    id: "01996000-0000-7000-8000-000000000002",
    name: "New York",
    latitude: 40.639722,
    longitude: -73.778889,
    stock: 578,
  },
  {
    id: "01996000-0000-7000-8000-000000000003",
    name: "São Paulo",
    latitude: -23.435556,
    longitude: -46.473056,
    stock: 265,
  },
  {
    id: "01996000-0000-7000-8000-000000000004",
    name: "Paris",
    latitude: 49.009722,
    longitude: 2.547778,
    stock: 694,
  },
  {
    id: "01996000-0000-7000-8000-000000000005",
    name: "Warsaw",
    latitude: 52.165833,
    longitude: 20.967222,
    stock: 245,
  },
  {
    id: "01996000-0000-7000-8000-000000000006",
    name: "Hong Kong",
    latitude: 22.308889,
    longitude: 113.914444,
    stock: 419,
  },
];

export const TOTAL_STOCK = WAREHOUSES.reduce((sum, { stock }) => sum + stock, 0); // 2556

export function warehouse(name: string): Warehouse {
  const found = WAREHOUSES.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`No warehouse ${name}`);
  }
  return found;
}

/** Exactly the Paris warehouse coordinates: zero shipping distance. */
export const AT_PARIS = { latitude: 49.009722, longitude: 2.547778 } as const;
/** Manhattan: New York is nearest, a short non-zero distance. */
export const MANHATTAN = { latitude: 40.7128, longitude: -74.006 } as const;
/** South of New Zealand: every warehouse is thousands of kilometres away. */
export const FAR_AWAY = { latitude: -45, longitude: 170 } as const;

/** core MAX_QUANTITY: floor(9 999 999 999.99 / 150). */
export const MAX_QUANTITY = 66_666_666;

export const ORDER_NUMBER = /^SO-[0-9A-HJKMNP-TV-Z]{12}$/;

/** The exact key set of an accepted Order response (no internal id). */
export const ORDER_KEYS = [
  "allocations",
  "destination",
  "discountAmount",
  "discountRate",
  "discountedMerchandiseTotal",
  "merchandiseSubtotal",
  "orderNumber",
  "orderTotal",
  "quantity",
  "shippingCost",
  "submissionId",
  "unitPrice",
];
