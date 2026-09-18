export const corePackage = Object.freeze({ name: "core" });

export type {
  InventorySnapshot,
  ShippingPlan,
  WarehouseAllocation,
  WarehouseStock,
} from "./allocation.js";
export {
  type Destination,
  type GeoPoint,
  LATITUDE_LIMIT,
  LONGITUDE_LIMIT,
  parseDestination,
} from "./destination.js";
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
export { MONEY_MAX_STRING, Money } from "./money.js";
export { type CreateOrderInput, type Order, createOrder } from "./order.js";
export { type OrderRequestInput, parseOrderRequest } from "./order-request.js";
export type { DiscountRate } from "./pricing.js";
export { MAX_QUANTITY, type Quantity, parseQuantity } from "./quantity.js";
export type { Result, ValidationError, ValidationErrorCode, ValidationField } from "./result.js";
