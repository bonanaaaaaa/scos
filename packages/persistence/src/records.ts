import type {
  Order,
  OrderAllocation,
  Prisma,
  Submission,
  SubmissionRejection,
  Warehouse,
} from "./generated/prisma/client.js";

// Persistence-local typed records. Rows from Prisma are mapped here so that
// Prisma Decimal and lookup strings never leave the adapter. Money is a fixed
// two-decimal string produced from the Decimal itself, never via JS number.

export const submissionOutcomes = ["ACCEPTED", "REJECTED"] as const;
export type SubmissionOutcomeValue = (typeof submissionOutcomes)[number];

export const rejectionReasons = ["INSUFFICIENT_STOCK", "SHIPPING_EXCEEDS_LIMIT"] as const;
export type RejectionReasonValue = (typeof rejectionReasons)[number];

function parseLookupValue<T extends string>(
  allowed: readonly T[],
  value: string,
  lookup: string,
): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`Unknown ${lookup} value: ${JSON.stringify(value)}`);
  }
  return match;
}

export function parseSubmissionOutcome(value: string): SubmissionOutcomeValue {
  return parseLookupValue(submissionOutcomes, value, "submission outcome");
}

export function parseRejectionReason(value: string): RejectionReasonValue {
  return parseLookupValue(rejectionReasons, value, "rejection reason");
}

function formatFixed(value: Prisma.Decimal, scale: number, label: string): string {
  if (!value.isFinite() || value.decimalPlaces() > scale) {
    throw new Error(`${label} must be finite with at most ${scale} decimal places`);
  }
  return value.toFixed(scale);
}

/** NUMERIC(12,2) amount as an exact decimal string, such as "150.00". */
export function formatMoney(value: Prisma.Decimal): string {
  return formatFixed(value, 2, "Money");
}

/** NUMERIC(5,4) discount rate as an exact decimal string, such as "0.1500". */
export function formatDiscountRate(value: Prisma.Decimal): string {
  return formatFixed(value, 4, "Discount rate");
}

function formatOptionalMoney(value: Prisma.Decimal | null): string | null {
  return value === null ? null : formatMoney(value);
}

export interface Timestamps {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface WarehouseRecord extends Timestamps, Coordinates {
  readonly id: string;
  readonly name: string;
  readonly stock: number;
}

export interface SubmissionRecord extends Timestamps {
  readonly id: string;
  readonly submissionKey: string;
  readonly quantity: number;
  readonly destination: Coordinates;
  readonly outcome: SubmissionOutcomeValue;
}

export interface CommercialSnapshot {
  readonly unitPrice: string;
  readonly merchandiseSubtotal: string;
  readonly discountRate: string;
  readonly discountAmount: string;
  readonly discountedMerchandiseTotal: string;
}

export interface OrderAllocationRecord extends Timestamps {
  readonly id: string;
  readonly warehouseId: string;
  readonly quantity: number;
}

export interface OrderRecord extends Timestamps, CommercialSnapshot {
  readonly id: string;
  readonly orderNumber: string;
  readonly submissionId: string;
  readonly shippingCost: string;
  readonly orderTotal: string;
  readonly allocations: readonly OrderAllocationRecord[];
}

interface RejectionRecordBase extends Timestamps, CommercialSnapshot {
  readonly submissionId: string;
}

export interface InsufficientStockRejectionRecord extends RejectionRecordBase {
  readonly reason: "INSUFFICIENT_STOCK";
  readonly shippingCost: null;
  readonly orderTotal: null;
}

export interface ShippingExceedsLimitRejectionRecord extends RejectionRecordBase {
  readonly reason: "SHIPPING_EXCEEDS_LIMIT";
  readonly shippingCost: string;
  readonly orderTotal: string;
}

export type SubmissionRejectionRecord =
  | InsufficientStockRejectionRecord
  | ShippingExceedsLimitRejectionRecord;

export function toWarehouseRecord(row: Warehouse): WarehouseRecord {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    stock: row.stock,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSubmissionRecord(row: Submission): SubmissionRecord {
  return {
    id: row.id,
    submissionKey: row.submissionKey,
    quantity: row.quantity,
    destination: { latitude: row.destinationLatitude, longitude: row.destinationLongitude },
    outcome: parseSubmissionOutcome(row.outcome),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCommercialSnapshot(row: Order | SubmissionRejection): CommercialSnapshot {
  return {
    unitPrice: formatMoney(row.unitPrice),
    merchandiseSubtotal: formatMoney(row.merchandiseSubtotal),
    discountRate: formatDiscountRate(row.discountRate),
    discountAmount: formatMoney(row.discountAmount),
    discountedMerchandiseTotal: formatMoney(row.discountedMerchandiseTotal),
  };
}

export function toOrderAllocationRecord(row: OrderAllocation): OrderAllocationRecord {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    quantity: row.quantity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toOrderRecord(
  row: Order & { readonly allocations: readonly OrderAllocation[] },
): OrderRecord {
  if (parseSubmissionOutcome(row.submissionOutcome) !== "ACCEPTED") {
    throw new Error("An Order must reference an ACCEPTED submission");
  }
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    submissionId: row.submissionId,
    ...toCommercialSnapshot(row),
    shippingCost: formatMoney(row.shippingCost),
    orderTotal: formatMoney(row.orderTotal),
    allocations: row.allocations.map(toOrderAllocationRecord),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSubmissionRejectionRecord(row: SubmissionRejection): SubmissionRejectionRecord {
  if (parseSubmissionOutcome(row.submissionOutcome) !== "REJECTED") {
    throw new Error("A rejection must reference a REJECTED submission");
  }
  const base: RejectionRecordBase = {
    submissionId: row.submissionId,
    ...toCommercialSnapshot(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  const shippingCost = formatOptionalMoney(row.shippingCost);
  const orderTotal = formatOptionalMoney(row.orderTotal);
  const reason = parseRejectionReason(row.reason);

  if (reason === "INSUFFICIENT_STOCK" && shippingCost === null && orderTotal === null) {
    return { ...base, reason, shippingCost, orderTotal };
  }
  if (reason === "SHIPPING_EXCEEDS_LIMIT" && shippingCost !== null && orderTotal !== null) {
    return { ...base, reason, shippingCost, orderTotal };
  }
  throw new Error(`Rejection ${reason} has inconsistent shipping cost and order total`);
}
