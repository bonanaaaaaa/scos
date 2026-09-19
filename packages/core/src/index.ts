/**
 * Public API of the Ordering core: the domain model, the application use cases
 * and the ports that driven adapters implement. Adapters import only from
 * here, never from `./domain/*` or `./application/*` directly.
 *
 * @see docs/architecture.md, "Domain model" and "Application layer"
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
export {
  type CreateOrderInput,
  type NewOrder,
  type Order,
  type OrderAllocation,
  type OrderAllocations,
  type StoredOrder,
  createOrder,
  restoreOrder,
} from "./domain/ordering/order";
export { ORDER_NUMBER_PATTERN, generateOrderNumber } from "./domain/ordering/order-number";
export { type OrderRequest, orderRequestSchema } from "./domain/ordering/order-request";
export { type SubmissionKey, submissionKeySchema } from "./domain/ordering/submission-key";
export type { DiscountRate } from "./domain/pricing/pricing";
export { MAX_QUANTITY, type Quantity, quantitySchema } from "./domain/shared/quantity";

export {
  type SubmissionStore,
  type SubmissionTransaction,
  SubmissionKeyTakenError,
  TransientSubmissionError,
} from "./application/ports/submission-store";
export {
  type AcceptedSubmission,
  type ConflictingSubmission,
  type InvalidSubmission,
  MAX_SUBMISSION_ATTEMPTS,
  type RejectedSubmission,
  type SubmitOrder,
  type SubmitOrderDependencies,
  type SubmitOrderInput,
  type SubmitOrderIssue,
  type SubmitOrderOutcome,
  type UnavailableSubmission,
  createSubmitOrder,
} from "./application/submit-order";

export type { InventoryReader } from "./application/ports/inventory-reader";
export {
  type VerifyOrder,
  type VerifyOrderDependencies,
  createVerifyOrder,
} from "./application/verify-order";
