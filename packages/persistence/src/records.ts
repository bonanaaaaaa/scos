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

/** NUMERIC(12,2) amount as an exact decimal string, such as "150.00". */
export function formatMoney(value: Prisma.Decimal): string {
  return formatFixed(value, 2, "Money");
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
  readonly submissionKey: string;
  readonly quantity: number;
  readonly destination: Coordinates;
  readonly shippingCost: string;
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

function toCommercialSnapshot(row: Order): CommercialSnapshot {
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
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    submissionKey: row.submissionKey,
    quantity: row.quantity,
    destination: { latitude: row.destinationLatitude, longitude: row.destinationLongitude },
    ...toCommercialSnapshot(row),
    shippingCost: formatMoney(row.shippingCost),
    orderTotal: formatMoney(row.orderTotal),
    allocations: row.allocations.map(toOrderAllocationRecord),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
