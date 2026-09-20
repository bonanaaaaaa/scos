/**
 * The example scenarios shared by verification (200) and submission (201,
 * 422): request fields and the Order Estimates they produce against a
 * freshly seeded database (`warehouseSeeds` in `@scos/persistence`).
 *
 * The amounts are literal for readability. Unit tests recompute every one
 * with `@scos/core` over the seed inventory, replay the requests through the
 * apps, and check each example against its Zod and generated JSON schemas.
 *
 * @module
 */

const WARSAW = "01996000-0000-7000-8000-000000000005";
const WARSAW_NAME = "Warsaw";
const HONG_KONG = "01996000-0000-7000-8000-000000000006";
const HONG_KONG_NAME = "Hong Kong";

/** Berlin: 150 units, served from Warsaw, 15% discount. */
export const validRequest = { quantity: 150, latitude: 52.52, longitude: 13.405 } as const;

/** More units than all six warehouses hold together (2,556). */
export const insufficientStockRequest = {
  quantity: 3000,
  latitude: 52.52,
  longitude: 13.405,
} as const;

/** Sydney: 10 units from Hong Kong cost more than 15% of $1,500 to ship. */
export const shippingExceedsLimitRequest = {
  quantity: 10,
  latitude: -33.9,
  longitude: 151.2,
} as const;

export const validEstimateExample = {
  valid: true,
  reason: null,
  quantity: 150,
  destination: { latitude: 52.52, longitude: 13.405 },
  unitPrice: "150.00",
  merchandiseSubtotal: "22500.00",
  discountRate: "0.15",
  discountAmount: "3375.00",
  discountedMerchandiseTotal: "19125.00",
  shippingCost: "281.96",
  shippingLimit: "2868.75",
  orderTotal: "19406.96",
  allocations: [
    {
      warehouseId: WARSAW,
      warehouseName: WARSAW_NAME,
      quantity: 150,
      distanceKm: 514.9927163724758,
    },
  ],
} as const;

export const insufficientStockEstimateExample = {
  valid: false,
  reason: "INSUFFICIENT_STOCK",
  quantity: 3000,
  destination: { latitude: 52.52, longitude: 13.405 },
  unitPrice: "150.00",
  merchandiseSubtotal: "450000.00",
  discountRate: "0.20",
  discountAmount: "90000.00",
  discountedMerchandiseTotal: "360000.00",
  shippingCost: null,
  shippingLimit: null,
  orderTotal: null,
  allocations: [],
} as const;

export const shippingExceedsLimitEstimateExample = {
  valid: false,
  reason: "SHIPPING_EXCEEDS_LIMIT",
  quantity: 10,
  destination: { latitude: -33.9, longitude: 151.2 },
  unitPrice: "150.00",
  merchandiseSubtotal: "1500.00",
  discountRate: "0.00",
  discountAmount: "0.00",
  discountedMerchandiseTotal: "1500.00",
  shippingCost: "269.78",
  shippingLimit: "225.00",
  orderTotal: "1769.78",
  allocations: [
    {
      warehouseId: HONG_KONG,
      warehouseName: HONG_KONG_NAME,
      quantity: 10,
      distanceKm: 7391.125691194222,
    },
  ],
} as const;
