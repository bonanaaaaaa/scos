export const corePackage = Object.freeze({ name: "core" });

export type {
  InventorySnapshot,
  ShippingPlan,
  WarehouseAllocation,
  WarehouseStock,
} from "./domain/allocation";
export {
  type Destination,
  type GeoPoint,
  LATITUDE_LIMIT,
  LONGITUDE_LIMIT,
  destinationSchema,
} from "./domain/destination";
export { DomainError, type DomainErrorCode } from "./domain/errors";
export {
  type EstimateRejectionReason,
  type InsufficientStockEstimate,
  type OrderEstimate,
  type OrderRequest,
  type ShippingExceedsLimitEstimate,
  type ValidOrderEstimate,
  estimateOrder,
} from "./domain/estimate";
export { MONEY_MAX_STRING, Money } from "./domain/money";
export { type CreateOrderInput, type Order, createOrder } from "./domain/order";
export { orderRequestSchema } from "./domain/order-request";
export type { DiscountRate } from "./domain/pricing";
export { MAX_QUANTITY, type Quantity, quantitySchema } from "./domain/quantity";
