import type { Order, OrderAllocation, Prisma, Warehouse } from "./generated/prisma/client.js";

// Persistence-local typed records. Rows from Prisma are mapped here so that
// Prisma Decimal values never leave the adapter. Money is a fixed two-decimal
// string produced from the Decimal itself, never via JS number.

function formatFixed(value: Prisma.Decimal, scale: number, label: string): string {
  if (!value.isFinite() || value.decimalPlaces() > scale) {
    throw new Error(`${label} must be finite with at most ${scale} decimal places`);
  }
  return value.toFixed(scale);
}

const MAX_MONEY = "9999999999.99";

/**
 * NUMERIC(12,2) amount as an exact decimal string, such as "150.00". Amounts
 * beyond the column range are refused: Decimal arithmetic keeps 20 significant
 * digits, so every in-range derived amount is exact and a larger one could
 * have been rounded.
 */
export function formatMoney(value: Prisma.Decimal): string {
  const text = formatFixed(value, 2, "Money");
  if (value.abs().greaterThan(MAX_MONEY)) {
    throw new Error("Money must fit NUMERIC(12,2)");
  }
  return text;
}

/** NUMERIC(3,2) discount rate as an exact decimal string, such as "0.15". */
export function formatDiscountRate(value: Prisma.Decimal): string {
  return formatFixed(value, 2, "Discount rate");
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

export interface OrderAllocationRecord extends Timestamps {
  readonly id: string;
  readonly warehouseId: string;
  readonly quantity: number;
}

export interface OrderRecord extends Timestamps {
  readonly id: string;
  readonly orderNumber: string;
  readonly submissionKey: string;
  readonly quantity: number;
  readonly destination: Coordinates;
  readonly unitPrice: string;
  readonly discountRate: string;
  readonly discountAmount: string;
  readonly shippingCost: string;
  // Derived on read from the stored facts above; not stored (3NF).
  readonly merchandiseSubtotal: string;
  readonly discountedMerchandiseTotal: string;
  readonly orderTotal: string;
  readonly allocations: readonly OrderAllocationRecord[];
}

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
  // The three totals are derived, not stored: exact Decimal arithmetic over
  // the stored facts, so the amounts returned equal what was charged.
  const merchandiseSubtotal = row.unitPrice.times(row.quantity);
  const discountedMerchandiseTotal = merchandiseSubtotal.minus(row.discountAmount);
  const orderTotal = discountedMerchandiseTotal.plus(row.shippingCost);
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    submissionKey: row.submissionKey,
    quantity: row.quantity,
    destination: { latitude: row.destinationLatitude, longitude: row.destinationLongitude },
    unitPrice: formatMoney(row.unitPrice),
    discountRate: formatDiscountRate(row.discountRate),
    discountAmount: formatMoney(row.discountAmount),
    shippingCost: formatMoney(row.shippingCost),
    merchandiseSubtotal: formatMoney(merchandiseSubtotal),
    discountedMerchandiseTotal: formatMoney(discountedMerchandiseTotal),
    orderTotal: formatMoney(orderTotal),
    allocations: row.allocations.map(toOrderAllocationRecord),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
