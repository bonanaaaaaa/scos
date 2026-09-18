import assert from "node:assert/strict";
import { test } from "vitest";

import { Prisma } from "./generated/prisma/client.js";
import {
  formatDiscountRate,
  formatMoney,
  parseRejectionReason,
  parseSubmissionOutcome,
  toOrderRecord,
  toSubmissionRecord,
  toSubmissionRejectionRecord,
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

const rejectionRow = (
  reason: string,
  shippingCost: Prisma.Decimal | null,
  orderTotal: Prisma.Decimal | null,
) => ({
  submissionId: "01996000-0000-7000-8000-0000000000aa",
  submissionOutcome: "REJECTED",
  reason,
  ...snapshot,
  shippingCost,
  orderTotal,
  createdAt,
  updatedAt,
});

test("lookup values parse to their string-literal unions and reject unknown values", () => {
  assert.equal(parseSubmissionOutcome("ACCEPTED"), "ACCEPTED");
  assert.equal(parseSubmissionOutcome("REJECTED"), "REJECTED");
  assert.equal(parseRejectionReason("INSUFFICIENT_STOCK"), "INSUFFICIENT_STOCK");
  assert.equal(parseRejectionReason("SHIPPING_EXCEEDS_LIMIT"), "SHIPPING_EXCEEDS_LIMIT");
  assert.throws(() => parseSubmissionOutcome("accepted"), /Unknown submission outcome value/);
  assert.throws(() => parseSubmissionOutcome("CONFLICT"), /Unknown submission outcome value/);
  assert.throws(() => parseRejectionReason(""), /Unknown rejection reason value/);
});

test("money formats exactly to two decimal places without JavaScript numbers", () => {
  assert.equal(formatMoney(decimal("0")), "0.00");
  assert.equal(formatMoney(decimal("0.01")), "0.01");
  assert.equal(formatMoney(decimal("150.5")), "150.50");
  assert.equal(formatMoney(decimal("9999999999.99")), "9999999999.99");
  assert.equal(formatMoney(decimal("1234567890.1")), "1234567890.10");
  assert.equal(formatDiscountRate(decimal("0.05")), "0.0500");
  assert.equal(formatDiscountRate(decimal("1")), "1.0000");
});

test("money and rates refuse values that would need rounding or are not finite", () => {
  assert.throws(() => formatMoney(decimal("0.001")), /at most 2 decimal places/);
  assert.throws(() => formatMoney(decimal("NaN")), /Money must be finite/);
  assert.throws(() => formatMoney(decimal("Infinity")), /Money must be finite/);
  assert.throws(() => formatDiscountRate(decimal("0.12345")), /at most 4 decimal places/);
});

test("warehouse and submission rows map to plain records", () => {
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

  assert.deepEqual(
    toSubmissionRecord({
      id: "01996000-0000-7000-8000-0000000000aa",
      submissionKey: "attempt-1",
      quantity: 100,
      destinationLatitude: -90,
      destinationLongitude: 180,
      outcome: "ACCEPTED",
      createdAt,
      updatedAt,
    }),
    {
      id: "01996000-0000-7000-8000-0000000000aa",
      submissionKey: "attempt-1",
      quantity: 100,
      destination: { latitude: -90, longitude: 180 },
      outcome: "ACCEPTED",
      createdAt,
      updatedAt,
    },
  );
  assert.throws(
    () =>
      toSubmissionRecord({
        id: "01996000-0000-7000-8000-0000000000aa",
        submissionKey: "attempt-1",
        quantity: 1,
        destinationLatitude: 0,
        destinationLongitude: 0,
        outcome: "PENDING",
        createdAt,
        updatedAt,
      }),
    /Unknown submission outcome value/,
  );
});

test("order rows map to snapshots with decimal strings and allocations", () => {
  const order = {
    id: "01996000-0000-7000-8000-0000000000bb",
    orderNumber: "ORD-1",
    submissionId: "01996000-0000-7000-8000-0000000000aa",
    submissionOutcome: "ACCEPTED",
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
    submissionId: order.submissionId,
    unitPrice: "150.00",
    merchandiseSubtotal: "15000.00",
    discountRate: "0.1500",
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
  assert.throws(
    () => toOrderRecord({ ...order, submissionOutcome: "REJECTED" }),
    /must reference an ACCEPTED submission/,
  );
});

test("rejection rows map to a discriminated union by reason", () => {
  const insufficient = toSubmissionRejectionRecord(rejectionRow("INSUFFICIENT_STOCK", null, null));
  assert.equal(insufficient.reason, "INSUFFICIENT_STOCK");
  assert.equal(insufficient.shippingCost, null);
  assert.equal(insufficient.orderTotal, null);
  assert.equal(insufficient.discountedMerchandiseTotal, "12750.00");
  assert.equal(insufficient.discountRate, "0.1500");

  const excessive = toSubmissionRejectionRecord(
    rejectionRow("SHIPPING_EXCEEDS_LIMIT", decimal("1912.51"), decimal("14662.51")),
  );
  assert.deepEqual(
    { reason: excessive.reason, shipping: excessive.shippingCost, total: excessive.orderTotal },
    { reason: "SHIPPING_EXCEEDS_LIMIT", shipping: "1912.51", total: "14662.51" },
  );
});

test("inconsistent rejection rows are refused rather than silently mapped", () => {
  assert.throws(
    () => toSubmissionRejectionRecord(rejectionRow("INSUFFICIENT_STOCK", decimal("1.00"), null)),
    /inconsistent shipping cost and order total/,
  );
  assert.throws(
    () => toSubmissionRejectionRecord(rejectionRow("SHIPPING_EXCEEDS_LIMIT", null, null)),
    /inconsistent shipping cost and order total/,
  );
  assert.throws(
    () => toSubmissionRejectionRecord(rejectionRow("OUT_OF_STOCK", null, null)),
    /Unknown rejection reason value/,
  );
  assert.throws(
    () =>
      toSubmissionRejectionRecord({
        ...rejectionRow("INSUFFICIENT_STOCK", null, null),
        submissionOutcome: "ACCEPTED",
      }),
    /must reference a REJECTED submission/,
  );
});
