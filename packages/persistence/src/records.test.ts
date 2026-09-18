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

const orderRow = {
  id: "01996000-0000-7000-8000-0000000000bb",
  orderNumber: "ORD-1",
  submissionKey: "attempt-1",
  quantity: 100,
  destinationLatitude: -90,
  destinationLongitude: 180,
  unitPrice: decimal("150"),
  discountRate: decimal("0.15"),
  discountAmount: decimal("2250"),
  shippingCost: decimal("0.01"),
  createdAt,
  updatedAt,
  allocations: [],
};

const derivedTotals = (overrides: Partial<typeof orderRow>) => {
  const { merchandiseSubtotal, discountedMerchandiseTotal, orderTotal } = toOrderRecord({
    ...orderRow,
    ...overrides,
  });
  return { merchandiseSubtotal, discountedMerchandiseTotal, orderTotal };
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

test("money refuses amounts outside NUMERIC(12,2)", () => {
  assert.throws(() => formatMoney(decimal("10000000000.00")), /Money must fit NUMERIC\(12,2\)/);
  assert.throws(() => formatMoney(decimal("-10000000000.00")), /Money must fit NUMERIC\(12,2\)/);
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

test("order rows map the request, stored facts, derived totals, and allocations", () => {
  const order = {
    ...orderRow,
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
    discountRate: "0.15",
    discountAmount: "2250.00",
    shippingCost: "0.01",
    merchandiseSubtotal: "15000.00",
    discountedMerchandiseTotal: "12750.00",
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

test("order totals are derived exactly from the stored facts", () => {
  // PRD-like: 30 x 150.00 with the 5% tier.
  assert.deepEqual(
    derivedTotals({
      quantity: 30,
      unitPrice: decimal("150.00"),
      discountRate: decimal("0.05"),
      discountAmount: decimal("225.00"),
      shippingCost: decimal("123.45"),
    }),
    {
      merchandiseSubtotal: "4500.00",
      discountedMerchandiseTotal: "4275.00",
      orderTotal: "4398.45",
    },
  );
  // Cent-level: 0.01 x 2147483647 is not exactly representable as a double.
  assert.deepEqual(
    derivedTotals({
      quantity: 2_147_483_647,
      unitPrice: decimal("0.01"),
      discountRate: decimal("0.00"),
      discountAmount: decimal("0.01"),
      shippingCost: decimal("0.01"),
    }),
    {
      merchandiseSubtotal: "21474836.47",
      discountedMerchandiseTotal: "21474836.46",
      orderTotal: "21474836.47",
    },
  );
  // Every stored and derived amount at the NUMERIC(12,2) maximum.
  assert.deepEqual(
    derivedTotals({
      quantity: 1,
      unitPrice: decimal("9999999999.99"),
      discountRate: decimal("0.00"),
      discountAmount: decimal("0.00"),
      shippingCost: decimal("0.00"),
    }),
    {
      merchandiseSubtotal: "9999999999.99",
      discountedMerchandiseTotal: "9999999999.99",
      orderTotal: "9999999999.99",
    },
  );
  assert.deepEqual(
    derivedTotals({
      quantity: 1,
      unitPrice: decimal("9999999999.99"),
      discountRate: decimal("1.00"),
      discountAmount: decimal("9999999999.99"),
      shippingCost: decimal("9999999999.99"),
    }),
    {
      merchandiseSubtotal: "9999999999.99",
      discountedMerchandiseTotal: "0.00",
      orderTotal: "9999999999.99",
    },
  );
});

test("derived totals beyond NUMERIC(12,2) are refused rather than rounded", () => {
  // 9999999999.99 x 2147483647 has 22 significant digits; Decimal would round
  // it to 20 and drop the cents.
  assert.throws(
    () => derivedTotals({ quantity: 2_147_483_647, unitPrice: decimal("9999999999.99") }),
    /Money must fit NUMERIC\(12,2\)/,
  );
  assert.throws(
    () =>
      derivedTotals({
        quantity: 1,
        unitPrice: decimal("9999999999.99"),
        discountAmount: decimal("0.00"),
        shippingCost: decimal("0.01"),
      }),
    /Money must fit NUMERIC\(12,2\)/,
  );
});

test("order rows with unmappable amounts are refused rather than rounded", () => {
  const order = { ...orderRow, shippingCost: decimal("0.005") };
  assert.throws(() => toOrderRecord(order), /Money must be finite with at most 2 decimal places/);
  assert.throws(
    () => toOrderRecord({ ...orderRow, discountRate: decimal("0.125") }),
    /Discount rate must be finite with at most 2 decimal places/,
  );
  // A stored fact with excess scale makes the derived total inexact too.
  assert.throws(
    () => derivedTotals({ quantity: 1, unitPrice: decimal("150.005") }),
    /Money must be finite with at most 2 decimal places/,
  );
});
