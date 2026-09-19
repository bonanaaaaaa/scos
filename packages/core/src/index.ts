/**
 * Public API of the Ordering domain. Adapters import only from here, never
 * from `./domain/*` directly.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

export const corePackage = Object.freeze({ name: "core" });

export type {
  InventorySnapshot,
  ShippingPlan,
  WarehouseAllocation,
  WarehouseStock,
} from "./domain/shipping/allocation";
export {
  type Destination,
  type GeoPoint,
  LATITUDE_LIMIT,
  LONGITUDE_LIMIT,
  destinationSchema,
} from "./domain/shared/destination";
export { DomainError, type DomainErrorCode } from "./domain/shared/errors";
export {
  type EstimateRejectionReason,
  type InsufficientStockEstimate,
  type OrderEstimate,
  type ShippingExceedsLimitEstimate,
  type ValidOrderEstimate,
  estimateOrder,
} from "./domain/ordering/estimate";
export { MONEY_MAX_STRING, Money } from "./domain/shared/money";
export { type CreateOrderInput, type Order, createOrder } from "./domain/ordering/order";
export { type OrderRequest, orderRequestSchema } from "./domain/ordering/order-request";
export type { DiscountRate } from "./domain/pricing/pricing";
export { MAX_QUANTITY, type Quantity, quantitySchema } from "./domain/shared/quantity";
