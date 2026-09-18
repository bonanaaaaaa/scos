export const corePackage = Object.freeze({ name: "core" });

export {
  type InventorySnapshot,
  type ShippingPlan,
  type WarehouseAllocation,
  type WarehouseStock,
  allocateNearestFirst,
} from "./allocation.js";
export {
  type Destination,
  type GeoPoint,
  LATITUDE_LIMIT,
  LONGITUDE_LIMIT,
  isValidGeoPoint,
  parseDestination,
} from "./destination.js";
export { EARTH_RADIUS_KM, haversineDistanceKm } from "./distance.js";
export { DomainError, type DomainErrorCode } from "./errors.js";
export {
  type EstimateRejectionReason,
  type InsufficientStockEstimate,
  type OrderEstimate,
  type OrderRequest,
  type ShippingExceedsLimitEstimate,
  type ValidOrderEstimate,
  estimateOrder,
} from "./estimate.js";
export { MONEY_MAX_STRING, MONEY_SCALE, Money } from "./money.js";
export { type CreateOrderInput, type Order, createOrder } from "./order.js";
export { type OrderRequestInput, parseOrderRequest } from "./order-request.js";
export {
  DISCOUNT_TIERS,
  type DiscountRate,
  type DiscountTier,
  type MerchandisePricing,
  discountRateFor,
  isShippingWithinLimit,
  priceMerchandise,
  shippingCostFor,
  shippingLimitFor,
  unroundedShippingCost,
} from "./pricing.js";
export { MAX_QUANTITY, type Quantity, parseQuantity } from "./quantity.js";
export {
  type Result,
  type ValidationError,
  type ValidationErrorCode,
  type ValidationField,
  err,
  ok,
} from "./result.js";
