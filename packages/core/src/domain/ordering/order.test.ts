import { describe, expect, test } from "vitest";

import type { Destination } from "../shared/destination";
import { DomainError } from "../shared/errors";
import { Money } from "../shared/money";
import { MAX_QUANTITY, type Quantity } from "../shared/quantity";

import type { WarehouseStock } from "../shipping/allocation";

import { type OrderEstimate, type ValidOrderEstimate, estimateOrder } from "./estimate";
import { type StoredOrder, createOrder, hasSameRequest, restoreOrder } from "./order";
import type { OrderRequest } from "./order-request";
import type { SubmissionKey } from "./submission-key";

const destination = { latitude: 0, longitude: 0 } as Destination;
const inventory: readonly WarehouseStock[] = [
  { warehouseId: "a", latitude: 0, longitude: 1, available: 20 },
  { warehouseId: "b", latitude: 0, longitude: 2, available: 20 },
];

function validEstimate(): ValidOrderEstimate {
  const estimate = estimateOrder({ quantity: 30 as Quantity, destination }, inventory);
  if (!estimate.valid) throw new Error("fixture must be valid");
  return estimate;
}

const submissionKey = "submission-1" as SubmissionKey;
const orderNumber = "SO-0123456789AB";

/** An Order as plain JSON (Money serialises to its decimal string). */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const expectInvalid = (
  estimate: unknown,
  message: RegExp,
  { number = orderNumber, key = submissionKey }: { number?: string; key?: string } = {},
) => {
  const run = () =>
    createOrder({
      orderNumber: number,
      submissionKey: key as SubmissionKey,
      estimate: estimate as OrderEstimate,
    });
  expect(run).toThrow(DomainError);
  expect(run).toThrow(message);
};

describe("createOrder", () => {
  test("creates an immutable order from a valid estimate", () => {
    const estimate = validEstimate();
    const order = createOrder({ orderNumber, submissionKey, estimate });
    expect(plain(order)).toStrictEqual({
      orderNumber,
      submissionKey: "submission-1",
      quantity: 30,
      destination: { latitude: 0, longitude: 0 },
      unitPrice: "150.00",
      merchandiseSubtotal: "4500.00",
      discountRate: "0.05",
      discountAmount: "225.00",
      discountedMerchandiseTotal: "4275.00",
      shippingCost: estimate.shippingCost.toString(),
      orderTotal: estimate.orderTotal.toString(),
      // Only the persisted facts: the estimate's distances are dropped.
      allocations: [
        { warehouseId: "a", quantity: 20 },
        { warehouseId: "b", quantity: 10 },
      ],
    });
    expect("id" in order).toBe(false);
    expect(Object.isFrozen(order)).toBe(true);
    expect(Object.isFrozen(order.allocations)).toBe(true);
    expect(Object.isFrozen(order.allocations[0])).toBe(true);
  });

  test("rejects insufficient-stock and shipping-limit estimates", () => {
    expectInvalid(
      estimateOrder({ quantity: 41 as Quantity, destination }, inventory),
      /INSUFFICIENT_STOCK/,
    );
    const far = estimateOrder({ quantity: 1 as Quantity, destination }, [
      { warehouseId: "far", latitude: 0, longitude: 179, available: 1 },
    ]);
    expect(far.reason).toBe("SHIPPING_EXCEEDS_LIMIT");
    expectInvalid(far, /SHIPPING_EXCEEDS_LIMIT/);
  });

  test.each([
    "",
    "SO-1",
    "SO-0123456789A",
    "SO-0123456789ABC",
    "so-0123456789AB",
    "SO-0123456789AI",
  ])("requires a well-formed order number, not %j", (number) => {
    expectInvalid(validEstimate(), /Order number must match/, { number });
  });

  test("requires a validated submission key even when an invalid one is cast", () => {
    for (const key of ["", "   ", " submission-1", "x".repeat(256)]) {
      expectInvalid(validEstimate(), /Submission key must be a validated SubmissionKey/, { key });
    }
  });

  test("enforces allocation invariants", () => {
    const base = validEstimate();
    const [first, second] = base.allocations;
    expectInvalid({ ...base, allocations: [] }, /at least one/);
    expectInvalid(
      { ...base, allocations: [{ ...first, quantity: 0 }, second] },
      /positive integer/,
    );
    expectInvalid(
      {
        ...base,
        allocations: [
          { ...first, quantity: 19.5 },
          { ...second, quantity: 10.5 },
        ],
      },
      /positive integer/,
    );
    expectInvalid({ ...base, allocations: [{ ...first, distanceKm: -1 }, second] }, /distance/);
    expectInvalid(
      { ...base, allocations: [first, { ...second, warehouseId: "a" }] },
      /more than once/,
    );
    expectInvalid({ ...base, allocations: [first] }, /sum to the ordered quantity/);
  });

  test("enforces amount invariants", () => {
    const base = validEstimate();
    expect(base.discountRate).toBe("0.05");
    expectInvalid({ ...base, quantity: 0 }, /quantity/);
    expectInvalid({ ...base, merchandiseSubtotal: Money.parse("1.00") }, /unit price/);
    expectInvalid({ ...base, discountedMerchandiseTotal: Money.parse("1.00") }, /minus discount/);
    expectInvalid({ ...base, orderTotal: Money.parse("1.00") }, /Order total/);
  });

  test("rejects a discount rate that is not the quantity's tier, even with a matching amount", () => {
    const base = validEstimate();
    // 10% of 4500.00 is 450.00, internally consistent but the wrong tier for 30 units.
    const discountAmount = Money.parse("450.00");
    expectInvalid(
      {
        ...base,
        discountRate: "0.10",
        discountAmount,
        discountedMerchandiseTotal: base.merchandiseSubtotal.minus(discountAmount),
      },
      /highest tier/,
    );
  });

  test("rejects a discount amount that does not match the rate", () => {
    const base = validEstimate();
    expectInvalid(
      {
        ...base,
        discountAmount: Money.parse("0.00"),
        discountedMerchandiseTotal: base.merchandiseSubtotal,
      },
      /subtotal times the discount rate/,
    );
  });

  test("rejects shipping that differs from the charge recomputed from the allocations", () => {
    const atWarehouse = estimateOrder({ quantity: 1 as Quantity, destination }, [
      { warehouseId: "here", latitude: 0, longitude: 0, available: 1 },
    ]);
    expect(atWarehouse.valid).toBe(true);
    expect(atWarehouse.shippingCost?.toString()).toBe("0.00");
    const shippingCost = Money.parse("5.00");
    expectInvalid(
      {
        ...atWarehouse,
        shippingCost,
        orderTotal: atWarehouse.discountedMerchandiseTotal.plus(shippingCost),
      },
      /combined charge/,
    );
  });

  test("rejects shipping above the limit even when an estimate is marked valid", () => {
    const far = estimateOrder({ quantity: 1 as Quantity, destination }, [
      { warehouseId: "far", latitude: 0, longitude: 179, available: 1 },
    ]);
    expectInvalid({ ...far, valid: true, reason: null }, /exceeds 15%/);
  });
});

const storedOrder = (overrides: Partial<StoredOrder> = {}): StoredOrder => ({
  id: "0199a000-0000-7000-8000-000000000001",
  orderNumber,
  submissionKey: "submission-1",
  quantity: 30,
  destination: { latitude: 13.75, longitude: 100.5 },
  unitPrice: "150.00",
  discountRate: "0.05",
  discountAmount: "225.00",
  shippingCost: "12.34",
  allocations: [
    { warehouseId: "a", quantity: 20 },
    { warehouseId: "b", quantity: 10 },
  ],
  ...overrides,
});

const expectInvalidStored = (overrides: Partial<StoredOrder>, message: RegExp) => {
  const run = () => restoreOrder(storedOrder(overrides));
  expect(run).toThrow(DomainError);
  expect(run).toThrow(expect.objectContaining({ code: "INVALID_ORDER" }));
  expect(run).toThrow(message);
};

describe("restoreOrder", () => {
  test("rebuilds a frozen Order and derives the subtotal and totals", () => {
    const order = restoreOrder(storedOrder());
    expect(plain(order)).toStrictEqual({
      id: "0199a000-0000-7000-8000-000000000001",
      orderNumber,
      submissionKey: "submission-1",
      quantity: 30,
      destination: { latitude: 13.75, longitude: 100.5 },
      unitPrice: "150.00",
      merchandiseSubtotal: "4500.00",
      discountRate: "0.05",
      discountAmount: "225.00",
      discountedMerchandiseTotal: "4275.00",
      shippingCost: "12.34",
      orderTotal: "4287.34",
      allocations: [
        { warehouseId: "a", quantity: 20 },
        { warehouseId: "b", quantity: 10 },
      ],
    });
    expect(Object.isFrozen(order)).toBe(true);
    expect(Object.isFrozen(order.destination)).toBe(true);
    expect(Object.isFrozen(order.allocations)).toBe(true);
    expect(Object.isFrozen(order.allocations[0])).toBe(true);
  });

  test("equals the Order created at acceptance once the database id is added", () => {
    const created = createOrder({ orderNumber, submissionKey, estimate: validEstimate() });
    const restored = restoreOrder({
      id: "id-1",
      orderNumber: created.orderNumber,
      submissionKey: created.submissionKey,
      quantity: created.quantity,
      destination: { ...created.destination },
      unitPrice: created.unitPrice.toString(),
      discountRate: created.discountRate,
      discountAmount: created.discountAmount.toString(),
      shippingCost: created.shippingCost.toString(),
      allocations: created.allocations.map((allocation) => ({ ...allocation })),
    });
    expect(plain(restored)).toStrictEqual(plain({ id: "id-1", ...created }));
  });

  test("keeps historical facts that current commercial rules would not produce", () => {
    // A different unit price, a rate that is no longer a tier, a discount that is
    // not rate x subtotal, and shipping unrelated to any distance.
    const order = restoreOrder(
      storedOrder({
        unitPrice: "99.99",
        discountRate: "0.12",
        discountAmount: "1.00",
        shippingCost: "0.00",
      }),
    );
    expect(order.merchandiseSubtotal.toString()).toBe("2999.70");
    expect(order.discountedMerchandiseTotal.toString()).toBe("2998.70");
    expect(order.orderTotal.toString()).toBe("2998.70");
    expect(order.discountRate).toBe("0.12");
  });

  test.each(["0.00", "1.00", "0.20"])("accepts the discount rate %s", (discountRate) => {
    expect(restoreOrder(storedOrder({ discountRate, discountAmount: "0.00" })).discountRate).toBe(
      discountRate,
    );
  });

  test("requires identifiers and a valid submission key", () => {
    expectInvalidStored({ id: "" }, /id is required/);
    expectInvalidStored({ orderNumber: "" }, /Order number is required/);
    expectInvalidStored({ orderNumber: 42 as unknown as string }, /Order number is required/);
    expectInvalidStored({ submissionKey: " padded" }, /Submission key/);
    expectInvalidStored({ submissionKey: "" }, /Submission key/);
  });

  test("restores an order number that does not match the current format", () => {
    // Stored under an older or different numbering scheme: still a fact.
    expect(restoreOrder(storedOrder({ orderNumber: "ORD-2025-000001" })).orderNumber).toBe(
      "ORD-2025-000001",
    );
  });

  test("restores a stored quantity above the current MAX_QUANTITY", () => {
    const quantity = MAX_QUANTITY + 1;
    const order = restoreOrder(
      storedOrder({
        quantity,
        unitPrice: "1.00",
        discountAmount: "0.00",
        allocations: [{ warehouseId: "a", quantity }],
      }),
    );
    expect(order.quantity).toBe(quantity);
    expect(order.merchandiseSubtotal.toString()).toBe(`${quantity}.00`);
  });

  test.each([0, -1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects stored quantity %s",
    (quantity) => {
      expectInvalidStored(
        { quantity, allocations: [{ warehouseId: "a", quantity: 1 }] },
        /quantity/,
      );
    },
  );

  test("rejects an invalid destination", () => {
    expectInvalidStored({ destination: { latitude: 91, longitude: 0 } }, /destination/);
    expectInvalidStored({ destination: { latitude: 0, longitude: Number.NaN } }, /destination/);
  });

  test.each(["0.5", "1.01", "-0.05", "0.050", "", "5%"])(
    "rejects discount rate %j",
    (discountRate) => {
      expectInvalidStored({ discountRate }, /Discount rate/);
    },
  );

  test("enforces allocation invariants", () => {
    expectInvalidStored({ allocations: [] }, /at least one/);
    expectInvalidStored(
      {
        allocations: [
          { warehouseId: "", quantity: 20 },
          { warehouseId: "b", quantity: 10 },
        ],
      },
      /warehouse id/,
    );
    expectInvalidStored(
      {
        allocations: [
          { warehouseId: "a", quantity: 0 },
          { warehouseId: "b", quantity: 30 },
        ],
      },
      /positive integer/,
    );
    expectInvalidStored(
      {
        allocations: [
          { warehouseId: "a", quantity: 19.5 },
          { warehouseId: "b", quantity: 10.5 },
        ],
      },
      /positive integer/,
    );
    expectInvalidStored(
      {
        allocations: [
          { warehouseId: "a", quantity: 20 },
          { warehouseId: "a", quantity: 10 },
        ],
      },
      /more than once/,
    );
    expectInvalidStored(
      { allocations: [{ warehouseId: "a", quantity: 20 }] },
      /sum to the ordered quantity/,
    );
  });

  test.each([
    ["unitPrice", "abc", /Invalid unit price/],
    ["unitPrice", "-1.00", /Invalid unit price/],
    ["unitPrice", "1.005", /Invalid unit price/],
    ["discountAmount", "", /Invalid discount amount/],
    ["shippingCost", "10000000000.00", /Invalid shipping cost/],
  ] as const)("rejects a malformed stored %s %j", (field, value, message) => {
    expectInvalidStored({ [field]: value }, message);
  });

  test("does not disguise an unexpected error as INVALID_ORDER", () => {
    const run = () => restoreOrder(storedOrder({ unitPrice: Symbol("bad") as unknown as string }));
    expect(run).toThrow(TypeError);
  });

  test("rejects derived amounts that are negative or not storable", () => {
    expectInvalidStored({ discountAmount: "4500.01" }, /exceeds the merchandise subtotal/);
    expectInvalidStored(
      {
        quantity: 66_666_666,
        unitPrice: "151.00",
        allocations: [{ warehouseId: "a", quantity: 66_666_666 }],
      },
      /Merchandise subtotal is not a storable amount/,
    );
    expectInvalidStored(
      {
        quantity: 66_666_666,
        // 66,666,666 x 150.00 = 9,999,999,900.00; plus 100.00 exceeds 9,999,999,999.99.
        discountAmount: "0.00",
        shippingCost: "100.00",
        allocations: [{ warehouseId: "a", quantity: 66_666_666 }],
      },
      /Order total is not a storable amount/,
    );
  });
});

describe("hasSameRequest", () => {
  const order = restoreOrder(storedOrder({ destination: { latitude: 0, longitude: 100.5 } }));
  const request = (quantity: number, latitude: number, longitude: number): OrderRequest =>
    ({ quantity, destination: { latitude, longitude } }) as OrderRequest;

  test("matches the same quantity and destination, treating -0 as 0", () => {
    expect(hasSameRequest(order, request(30, 0, 100.5))).toBe(true);
    expect(hasSameRequest(order, request(30, -0, 100.5))).toBe(true);
  });

  test("differs by quantity, latitude or longitude", () => {
    expect(hasSameRequest(order, request(31, 0, 100.5))).toBe(false);
    expect(hasSameRequest(order, request(30, 0.000001, 100.5))).toBe(false);
    expect(hasSameRequest(order, request(30, 0, 100.50000001))).toBe(false);
  });
});
