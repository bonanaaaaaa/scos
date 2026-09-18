import assert from "node:assert/strict";
import { test } from "vitest";

import { Prisma } from "./generated/prisma/client.js";
import {
  formatDiscountRate,
  formatMoney,
  toOrderAllocationRecord,
  toOrderRecord,
  toWarehouseRecord,
} from "./records.js";

const createdAt = new Date("2026-09-18T01:02:03.456Z");
const updatedAt = new Date("2026-09-18T04:05:06.789Z");
const decimal = (value: string) => new Prisma.Decimal(value);

const snapshot = {
  unitPrice: decimal("150"),
  merchandiseSubtotal: decimal("15000"),
  discountRate: decimal("0.15"),
  discountAmount: decimal("2250"),
  discountedMerchandiseTotal: decimal("12750"),
};

test("money formats exactly to two decimal places without JavaScript numbers", () => {
  assert.equal(formatMoney(decimal("0")), "0.00");
  assert.equal(formatMoney(decimal("0.01")), "0.01");
  assert.equal(formatMoney(decimal("150.5")), "150.50");
  assert.equal(formatMoney(decimal("9999999999.99")), "9999999999.99");
  assert.equal(formatMoney(decimal("1234567890.1")), "1234567890.10");
  assert.equal(formatDiscountRate(decimal("0.05")), "0.05");
  assert.equal(formatDiscountRate(decimal("1")), "1.00");
});

test("money and rates refuse values that would need rounding or are not finite", () => {
  assert.throws(() => formatMoney(decimal("0.001")), /at most 2 decimal places/);
  assert.throws(() => formatMoney(decimal("NaN")), /Money must be finite/);
  assert.throws(() => formatMoney(decimal("Infinity")), /Money must be finite/);
  assert.throws(() => formatDiscountRate(decimal("0.125")), /at most 2 decimal places/);
});

test("warehouse rows map to plain records", () => {
  const warehouse = {
    id: "01996000-0000-7000-8000-000000000001",
    name: "Los Angeles",
    latitude: 33.9425,
    longitude: -118.408056,
    stock: 355,
    createdAt,
    updatedAt,
  };
  assert.deepEqual(toWarehouseRecord(warehouse), warehouse);
});

test("allocation rows map to warehouse quantities without the order ID", () => {
  assert.deepEqual(
    toOrderAllocationRecord({
      id: "01996000-0000-7000-8000-0000000000cc",
      orderId: "01996000-0000-7000-8000-0000000000bb",
      warehouseId: "01996000-0000-7000-8000-000000000001",
      quantity: 100,
      createdAt,
      updatedAt,
    }),
    {
      id: "01996000-0000-7000-8000-0000000000cc",
      warehouseId: "01996000-0000-7000-8000-000000000001",
      quantity: 100,
      createdAt,
      updatedAt,
    },
  );
});

test("order rows map the request, snapshot decimal strings, and allocations", () => {
  const order = {
    id: "01996000-0000-7000-8000-0000000000bb",
    orderNumber: "ORD-1",
    submissionKey: "attempt-1",
    quantity: 100,
    destinationLatitude: -90,
    destinationLongitude: 180,
    ...snapshot,
    shippingCost: decimal("0.01"),
    orderTotal: decimal("12750.01"),
    createdAt,
    updatedAt,
    allocations: [
      {
        id: "01996000-0000-7000-8000-0000000000cc",
        orderId: "01996000-0000-7000-8000-0000000000bb",
        warehouseId: "01996000-0000-7000-8000-000000000001",
        quantity: 100,
        createdAt,
        updatedAt,
      },
    ],
  };

  assert.deepEqual(toOrderRecord(order), {
    id: order.id,
    orderNumber: "ORD-1",
    submissionKey: "attempt-1",
    quantity: 100,
    destination: { latitude: -90, longitude: 180 },
    unitPrice: "150.00",
    merchandiseSubtotal: "15000.00",
    discountRate: "0.15",
    discountAmount: "2250.00",
    discountedMerchandiseTotal: "12750.00",
    shippingCost: "0.01",
    orderTotal: "12750.01",
    allocations: [
      {
        id: "01996000-0000-7000-8000-0000000000cc",
        warehouseId: "01996000-0000-7000-8000-000000000001",
        quantity: 100,
        createdAt,
        updatedAt,
      },
    ],
    createdAt,
    updatedAt,
  });
});

test("order rows with unmappable amounts are refused rather than rounded", () => {
  const order = {
    id: "01996000-0000-7000-8000-0000000000bb",
    orderNumber: "ORD-2",
    submissionKey: "attempt-2",
    quantity: 1,
    destinationLatitude: 0,
    destinationLongitude: 0,
    ...snapshot,
    shippingCost: decimal("0.005"),
    orderTotal: decimal("12750.01"),
    createdAt,
    updatedAt,
    allocations: [],
  };
  assert.throws(() => toOrderRecord(order), /Money must be finite with at most 2 decimal places/);
  assert.throws(
    () =>
      toOrderRecord({ ...order, shippingCost: decimal("0.01"), discountRate: decimal("0.125") }),
    /Discount rate must be finite with at most 2 decimal places/,
  );
});
