/**
 * Aggregate root and factory: Order.
 *
 * An accepted order has identity (`id`, `orderNumber`) and is the consistency
 * boundary for its amounts and allocations. `createOrder` builds a new Order at
 * acceptance and enforces every commercial invariant; `restoreOrder` rebuilds a
 * stored Order from its persisted facts and checks structural invariants only.
 *
 * @see docs/architecture.md, "Domain model"
 * @module
 */

import type { OrderEstimate } from "#domain/ordering/estimate";
import { ORDER_NUMBER_PATTERN } from "#domain/ordering/order-number";
import type { OrderRequest } from "#domain/ordering/order-request";
import { type SubmissionKey, submissionKeySchema } from "#domain/ordering/submission-key";
import { discountRateFor } from "#domain/pricing/pricing";
import { DomainDecimal } from "#domain/shared/decimal";
import { type Destination, type GeoPoint, destinationSchema } from "#domain/shared/destination";
import { DomainError } from "#domain/shared/errors";
import { Money } from "#domain/shared/money";
import { UNIT_PRICE } from "#domain/shared/product";
import { type Quantity, MAX_QUANTITY } from "#domain/shared/quantity";
import { isShippingWithinLimit, shippingCostFor } from "#domain/shipping/shipping";

/**
 * Units of an accepted Order taken from one warehouse. Only these two facts are
 * persisted; the distance used to price shipping is not, so an Order rebuilt
 * from storage equals the Order returned at acceptance.
 */
export interface OrderAllocation {
  readonly warehouseId: string;
  readonly quantity: number;
}

/** A non-empty, frozen list of allocations with distinct warehouses. */
export type OrderAllocations = readonly [OrderAllocation, ...OrderAllocation[]];

/**
 * An accepted Order before the database has assigned its `id`. Amounts are
 * immutable historical facts: the unit price, discount and shipping that were
 * applied, never recalculated from current commercial rules.
 */
export interface NewOrder {
  /** Customer-facing reference matching `ORDER_NUMBER_PATTERN`. */
  readonly orderNumber: string;
  /** The client's retry key, stored as the Order's unique submission_key. */
  readonly submissionKey: SubmissionKey;
  readonly quantity: Quantity;
  readonly destination: Destination;
  readonly unitPrice: Money;
  readonly merchandiseSubtotal: Money;
  /**
   * The two-decimal rate applied at acceptance, such as `"0.05"`. Typed as a
   * string rather than the current tiers because a stored Order keeps the rate
   * it was accepted with even if the tiers later change.
   */
  readonly discountRate: string;
  readonly discountAmount: Money;
  readonly discountedMerchandiseTotal: Money;
  readonly shippingCost: Money;
  readonly orderTotal: Money;
  readonly allocations: OrderAllocations;
}

/** An accepted, persisted Order with its database-generated `id`. */
export interface Order extends NewOrder {
  readonly id: string;
}

export interface CreateOrderInput {
  readonly orderNumber: string;
  readonly submissionKey: SubmissionKey;
  readonly estimate: OrderEstimate;
}

/**
 * The stored facts of an accepted Order, as the persistence adapter reads them:
 * amounts are plain decimal strings (for example `"150.00"`), and the
 * subtotal and totals are absent because they are derived.
 */
export interface StoredOrder {
  readonly id: string;
  readonly orderNumber: string;
  readonly submissionKey: string;
  readonly quantity: number;
  readonly destination: GeoPoint;
  readonly unitPrice: string;
  readonly discountRate: string;
  readonly discountAmount: string;
  readonly shippingCost: string;
  readonly allocations: readonly OrderAllocation[];
}

/** A two-decimal rate string in [0, 1], matching NUMERIC(3, 2) with its CHECK. */
const DISCOUNT_RATE_PATTERN = /^(?:0\.\d{2}|1\.00)$/;

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new DomainError("INVALID_ORDER", message);
  }
}

/**
 * Runs a Money construction or calculation and reports any DomainError it
 * throws (unparseable, negative or out-of-range amount) as INVALID_ORDER.
 */
function orderAmount(compute: () => Money, message: string): Money {
  try {
    return compute();
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError("INVALID_ORDER", `${message} (${error.message})`);
    }
    throw error;
  }
}

function assertAllocations(quantity: number, allocations: readonly OrderAllocation[]): void {
  invariant(allocations.length > 0, "An order requires at least one warehouse allocation.");
  const warehouseIds = new Set<string>();
  let allocated = 0;
  for (const allocation of allocations) {
    invariant(
      typeof allocation.warehouseId === "string" && allocation.warehouseId.length > 0,
      "Each allocation requires a warehouse id.",
    );
    invariant(
      Number.isSafeInteger(allocation.quantity) && allocation.quantity > 0,
      "Each allocation quantity must be a positive integer.",
    );
    invariant(
      !warehouseIds.has(allocation.warehouseId),
      `Warehouse ${allocation.warehouseId} is allocated more than once.`,
    );
    warehouseIds.add(allocation.warehouseId);
    allocated += allocation.quantity;
  }
  invariant(allocated === quantity, "Allocations must sum to the ordered quantity.");
}

function freezeAllocations(allocations: readonly OrderAllocation[]): OrderAllocations {
  return Object.freeze(
    allocations.map(({ warehouseId, quantity }) => Object.freeze({ warehouseId, quantity })),
  ) as readonly OrderAllocation[] as OrderAllocations;
}

function assertOrderNumber(orderNumber: string): void {
  invariant(
    typeof orderNumber === "string" && ORDER_NUMBER_PATTERN.test(orderNumber),
    "Order number must match SO- followed by 12 Crockford base32 characters.",
  );
}

function assertSubmissionKey(submissionKey: string): asserts submissionKey is SubmissionKey {
  invariant(
    submissionKeySchema.safeParse(submissionKey).success,
    "Submission key must be a validated SubmissionKey.",
  );
}

/**
 * The acceptance-time factory: creates a {@link NewOrder} from a valid estimate,
 * a generated order number and the client's submission key. The database
 * assigns the `id` when the Order is saved. Throws DomainError INVALID_ORDER if
 * the estimate is not valid or any accepted-order invariant does not hold.
 * Money values already guarantee cent scale and NUMERIC(12, 2) range.
 *
 * It re-verifies the amounts against the CURRENT unit price, discount tiers and
 * shipping rule, so it must not be used to rehydrate stored orders: accepted
 * amounts are immutable historical facts. Use {@link restoreOrder} for that.
 *
 * The estimate's shipping plan (including each warehouse's distance) is checked
 * here; the Order keeps only the warehouse and quantity of each allocation,
 * which are the persisted facts.
 */
export function createOrder(input: CreateOrderInput): NewOrder {
  const { orderNumber, submissionKey, estimate } = input;
  assertOrderNumber(orderNumber);
  assertSubmissionKey(submissionKey);
  invariant(estimate.valid, `Only a valid estimate can become an order (${estimate.reason}).`);

  const { quantity, allocations, shippingCost, orderTotal } = estimate;
  invariant(
    Number.isSafeInteger(quantity) && quantity > 0 && quantity <= MAX_QUANTITY,
    "Order quantity must be a positive integer within the supported range.",
  );
  assertAllocations(quantity, allocations);
  for (const allocation of allocations) {
    invariant(
      Number.isFinite(allocation.distanceKm) && allocation.distanceKm >= 0,
      "Each allocation distance must be finite and non-negative.",
    );
  }
  invariant(
    estimate.merchandiseSubtotal.toDecimal().equals(UNIT_PRICE.times(quantity)),
    "Merchandise subtotal must equal quantity times unit price.",
  );
  invariant(
    estimate.discountRate === discountRateFor(quantity),
    "Discount rate must be the highest tier the quantity qualifies for.",
  );
  invariant(
    estimate.discountAmount
      .toDecimal()
      .equals(
        estimate.merchandiseSubtotal.toDecimal().times(new DomainDecimal(estimate.discountRate)),
      ),
    "Discount amount must equal subtotal times the discount rate.",
  );
  invariant(
    estimate.merchandiseSubtotal
      .minus(estimate.discountAmount)
      .equals(estimate.discountedMerchandiseTotal),
    "Discounted merchandise total must equal subtotal minus discount.",
  );
  invariant(
    shippingCost.equals(shippingCostFor(allocations)),
    "Shipping cost must equal the combined charge for the allocations' distances.",
  );
  invariant(
    isShippingWithinLimit(shippingCost, estimate.discountedMerchandiseTotal),
    "Shipping cost exceeds 15% of the discounted merchandise total.",
  );
  invariant(
    estimate.discountedMerchandiseTotal.plus(shippingCost).equals(orderTotal),
    "Order total must equal discounted merchandise total plus shipping.",
  );

  return Object.freeze({
    orderNumber,
    submissionKey,
    quantity,
    destination: estimate.destination,
    unitPrice: Money.fromDecimal(UNIT_PRICE),
    merchandiseSubtotal: estimate.merchandiseSubtotal,
    discountRate: estimate.discountRate,
    discountAmount: estimate.discountAmount,
    discountedMerchandiseTotal: estimate.discountedMerchandiseTotal,
    shippingCost,
    orderTotal,
    allocations: freezeAllocations(allocations),
  });
}

/**
 * The rehydration factory: rebuilds a stored Order from its persisted facts
 * WITHOUT re-verifying them against current commercial rules, because accepted
 * amounts are historical facts (a later price or tier change must not make a
 * stored Order unreadable or different).
 *
 * It checks structural invariants only: a non-empty id and order number, a
 * valid submission key and destination, a positive safe-integer quantity,
 * cent amounts within NUMERIC(12, 2), a two-decimal discount rate in [0, 1],
 * and non-empty allocations of positive integer quantities from distinct
 * warehouses summing to the quantity. The order number and quantity are
 * deliberately NOT checked against the current `ORDER_NUMBER_PATTERN` or
 * `MAX_QUANTITY`: tightening either later must not make repeats of Orders
 * stored under the old rules unreadable. `createOrder` applies both to new
 * Orders. It then derives
 *
 * ```text
 * merchandiseSubtotal        = unitPrice · quantity
 * discountedMerchandiseTotal = merchandiseSubtotal − discountAmount
 * orderTotal                 = discountedMerchandiseTotal + shippingCost
 * ```
 *
 * and requires each to be a storable, non-negative amount. Allocations keep
 * the order given; the adapter must read them in a stable order (their
 * insertion order) so a repeat returns the same Order as the first response.
 * Any violation throws DomainError INVALID_ORDER.
 */
export function restoreOrder(stored: StoredOrder): Order {
  const { id, orderNumber, submissionKey, discountRate, allocations } = stored;
  invariant(typeof id === "string" && id.length > 0, "Order id is required.");
  invariant(typeof orderNumber === "string" && orderNumber.length > 0, "Order number is required.");
  assertSubmissionKey(submissionKey);

  // A stored fact, checked structurally rather than against the current
  // MAX_QUANTITY, then carried as the Quantity it was accepted as.
  invariant(
    Number.isSafeInteger(stored.quantity) && stored.quantity > 0,
    "Order quantity must be a positive safe integer.",
  );
  const quantity = stored.quantity as Quantity;
  const destination = destinationSchema.safeParse(stored.destination);
  invariant(destination.success, "Order destination must be valid coordinates.");
  invariant(
    typeof discountRate === "string" && DISCOUNT_RATE_PATTERN.test(discountRate),
    "Discount rate must be a two-decimal rate between 0 and 1.",
  );
  assertAllocations(quantity, allocations);

  const unitPrice = orderAmount(() => Money.parse(stored.unitPrice), "Invalid unit price");
  const discountAmount = orderAmount(
    () => Money.parse(stored.discountAmount),
    "Invalid discount amount",
  );
  const shippingCost = orderAmount(() => Money.parse(stored.shippingCost), "Invalid shipping cost");
  const merchandiseSubtotal = orderAmount(
    () => Money.fromDecimal(unitPrice.toDecimal().times(quantity)),
    "Merchandise subtotal is not a storable amount",
  );
  const discountedMerchandiseTotal = orderAmount(
    () => merchandiseSubtotal.minus(discountAmount),
    "Discount amount exceeds the merchandise subtotal",
  );
  const orderTotal = orderAmount(
    () => discountedMerchandiseTotal.plus(shippingCost),
    "Order total is not a storable amount",
  );

  return Object.freeze({
    id,
    orderNumber,
    submissionKey,
    quantity: quantity,
    destination: destination.data,
    unitPrice,
    merchandiseSubtotal,
    discountRate,
    discountAmount,
    discountedMerchandiseTotal,
    shippingCost,
    orderTotal,
    allocations: freezeAllocations(allocations),
  });
}

/**
 * Whether a validated request asks for the same thing as an existing Order:
 * the same quantity and destination, compared as parsed numbers. JSON property
 * order and number spelling therefore do not matter, and `-0` equals `0`.
 */
export function hasSameRequest(
  order: Pick<NewOrder, "quantity" | "destination">,
  request: OrderRequest,
): boolean {
  return (
    order.quantity === request.quantity &&
    order.destination.latitude === request.destination.latitude &&
    order.destination.longitude === request.destination.longitude
  );
}
