export const corePackage = Object.freeze({ name: "core" });

export type {
  InventorySnapshot,
  ShippingPlan,
  WarehouseAllocation,
  WarehouseStock,
} from "./allocation";
export {
  type Destination,
  type GeoPoint,
  LATITUDE_LIMIT,
  LONGITUDE_LIMIT,
  parseDestination,
} from "./destination";
export { DomainError, type DomainErrorCode } from "./errors";
export {
  type EstimateRejectionReason,
  type InsufficientStockEstimate,
  type OrderEstimate,
  type OrderRequest,
  type ShippingExceedsLimitEstimate,
  type ValidOrderEstimate,
  estimateOrder,
} from "./estimate";
export { MONEY_MAX_STRING, Money } from "./money";
export { type CreateOrderInput, type Order, createOrder } from "./order";
export { type OrderRequestInput, parseOrderRequest } from "./order-request";
export type { DiscountRate } from "./pricing";
export { MAX_QUANTITY, type Quantity, parseQuantity } from "./quantity";
export type { Result, ValidationError, ValidationErrorCode, ValidationField } from "./result";
