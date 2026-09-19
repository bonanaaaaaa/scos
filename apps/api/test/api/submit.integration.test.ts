/**
 * QA API acceptance: POST /orders over real HTTP — acceptance, repeats,
 * conflicts, business rejections and submissionId reuse.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { type TestDatabase, createTestDatabase, readState, stockById } from "../support/database";
import {
  AT_PARIS,
  FAR_AWAY,
  MANHATTAN,
  ORDER_KEYS,
  ORDER_NUMBER,
  type RunningApi,
  TOTAL_STOCK,
  WAREHOUSES,
  afterDeducting,
  expectErrorEnvelope,
  expectJson,
  expectedEstimate,
  expectedOrder,
  postJson,
  startApi,
  warehouse,
} from "./support";

let db: TestDatabase;
let api: RunningApi;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await startApi(db.url);
});

afterAll(async () => {
  await api?.stop();
  await db?.drop();
});

beforeEach(async () => {
  await db.reset();
});

const submit = (body: unknown) => postJson(api, "/orders", body);

function seededStock(): Record<string, number> {
  return Object.fromEntries(WAREHOUSES.map(({ id, stock }) => [id, stock]));
}

describe("201 accepted", () => {
  test("the accepted Order body, with no internal id, and stock deducted", async () => {
    const response = await submit({ submissionId: "qa-accept-1", quantity: 30, ...MANHATTAN });
    const body = expectJson(response, 201) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toStrictEqual(ORDER_KEYS);
    expect(body).toStrictEqual({
      orderNumber: expect.stringMatching(ORDER_NUMBER),
      submissionId: "qa-accept-1",
      quantity: 30,
      destination: MANHATTAN,
      unitPrice: "150.00",
      merchandiseSubtotal: "4500.00",
      discountRate: "0.05",
      discountAmount: "225.00",
      discountedMerchandiseTotal: "4275.00",
      shippingCost: "2.28",
      orderTotal: "4277.28",
      allocations: [{ warehouseId: warehouse("New York").id, quantity: 30 }],
    });
    expect(body).toStrictEqual(expectedOrder("qa-accept-1", 30, MANHATTAN));
    expect(response.text).not.toMatch(/"id"/);

    expect(await stockById(db.pool)).toStrictEqual({
      ...seededStock(),
      [warehouse("New York").id]: 578 - 30,
    });
  });

  test("a split Order and the next estimate reflect the deduction", async () => {
    const body = expectJson(
      await submit({ submissionId: "qa-split", quantity: 700, ...AT_PARIS }),
      201,
    ) as { allocations: { warehouseId: string; quantity: number }[] };
    expect(body).toStrictEqual(expectedOrder("qa-split", 700, AT_PARIS));
    expect(body.allocations).toStrictEqual([
      { warehouseId: warehouse("Paris").id, quantity: 694 },
      { warehouseId: warehouse("Warsaw").id, quantity: 6 },
    ]);

    const remaining = afterDeducting(WAREHOUSES, body.allocations);
    const next = expectJson(
      await postJson(api, "/orders/verify", { quantity: 5, ...AT_PARIS }),
      200,
    );
    expect(next).toStrictEqual(expectedEstimate(5, AT_PARIS, remaining));
  });

  test("order numbers are unique across Orders", async () => {
    const numbers = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      const body = expectJson(
        await submit({ submissionId: `qa-unique-${index}`, quantity: 1, ...AT_PARIS }),
        201,
      ) as { orderNumber: string; submissionId: string };
      expect(body.orderNumber).toMatch(ORDER_NUMBER);
      expect(body.submissionId).toBe(`qa-unique-${index}`);
      numbers.add(body.orderNumber);
    }
    expect(numbers.size).toBe(8);
  });

  test("a 255-character submissionId is accepted and echoed exactly", async () => {
    const submissionId = "k".repeat(254) + "é";
    const body = expectJson(await submit({ submissionId, quantity: 1, ...AT_PARIS }), 201) as {
      submissionId: string;
    };
    expect(body.submissionId).toBe(submissionId);
  });

  test("a submissionId with inner whitespace and Unicode is stored verbatim", async () => {
    const submissionId = "order 1\t☃ 😀";
    const body = expectJson(await submit({ submissionId, quantity: 1, ...AT_PARIS }), 201) as {
      submissionId: string;
    };
    expect(body.submissionId).toBe(submissionId);
  });
});

describe("repeated submissionId", () => {
  test("same input returns 201 with a byte-identical body and no second deduction", async () => {
    const request = { submissionId: "qa-repeat", quantity: 50, ...MANHATTAN };
    const first = await submit(request);
    expectJson(first, 201);
    const before = await readState(db.pool);

    const repeat = await submit(request);

    expectJson(repeat, 201);
    expect(repeat.text).toBe(first.text);
    expect(await readState(db.pool)).toStrictEqual(before);
  });

  test("same input with fields in a different order is still a repeat", async () => {
    const first = await submit({ submissionId: "qa-order", quantity: 5, ...AT_PARIS });
    expectJson(first, 201);
    const repeat = await submit({
      longitude: AT_PARIS.longitude,
      latitude: AT_PARIS.latitude,
      quantity: 5,
      submissionId: "qa-order",
    });
    expectJson(repeat, 201);
    expect(repeat.text).toBe(first.text);
  });

  test.each([
    ["quantity", { quantity: 6, ...AT_PARIS }],
    ["latitude", { quantity: 5, latitude: 49.0097, longitude: AT_PARIS.longitude }],
    ["longitude", { quantity: 5, latitude: AT_PARIS.latitude, longitude: 2.5478 }],
  ])("changed %s is 409 with no Order details and nothing changed", async (_field, changed) => {
    const accepted = await submit({ submissionId: "qa-conflict", quantity: 5, ...AT_PARIS });
    const order = expectJson(accepted, 201) as { orderNumber: string };
    const before = await readState(db.pool);

    const conflict = await submit({ submissionId: "qa-conflict", ...changed });

    const error = expectErrorEnvelope(conflict, 409, "SUBMISSION_ID_CONFLICT", {
      issues: "absent",
    });
    expect(conflict.text).not.toContain(order.orderNumber);
    expect(conflict.text).not.toMatch(/orderNumber|allocations|orderTotal|estimate/);
    expect(error.message).not.toContain(order.orderNumber);
    expect(await readState(db.pool)).toStrictEqual(before);

    // The original Order is still returned for its own input.
    const repeat = await submit({ submissionId: "qa-conflict", quantity: 5, ...AT_PARIS });
    expect(repeat.status).toBe(201);
    expect(repeat.text).toBe(accepted.text);
  });

  test("submissionIds are case- and byte-sensitive: a different key is a new Order", async () => {
    const first = expectJson(
      await submit({ submissionId: "qa-Case", quantity: 1, ...AT_PARIS }),
      201,
    ) as { orderNumber: string };
    const second = expectJson(
      await submit({ submissionId: "qa-case", quantity: 1, ...AT_PARIS }),
      201,
    ) as { orderNumber: string };
    expect(second.orderNumber).not.toBe(first.orderNumber);
  });
});

describe("422 business rejections", () => {
  test("INSUFFICIENT_STOCK: error plus the estimate, nothing stored", async () => {
    const before = await readState(db.pool);
    const response = await submit({
      submissionId: "qa-short",
      quantity: TOTAL_STOCK + 1,
      ...AT_PARIS,
    });

    const body = expectJson(response, 422) as Record<string, Record<string, unknown>>;
    expect(Object.keys(body).sort()).toStrictEqual(["error", "estimate"]);
    expect(Object.keys(body.error ?? {}).sort()).toStrictEqual(["code", "message"]);
    expect(body.error?.code).toBe("INSUFFICIENT_STOCK");
    expect(typeof body.error?.message).toBe("string");
    expect(body.estimate).toStrictEqual({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      quantity: 2557,
      destination: AT_PARIS,
      merchandiseSubtotal: "383550.00",
      discountRate: "0.20",
      discountAmount: "76710.00",
      discountedMerchandiseTotal: "306840.00",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });
    expect(await readState(db.pool)).toStrictEqual(before);
  });

  test("SHIPPING_EXCEEDS_LIMIT: error plus the estimate with every amount, nothing stored", async () => {
    const before = await readState(db.pool);
    const response = await submit({ submissionId: "qa-far", quantity: 1, ...FAR_AWAY });

    const body = expectJson(response, 422) as Record<string, Record<string, unknown>>;
    expect(Object.keys(body).sort()).toStrictEqual(["error", "estimate"]);
    expect(Object.keys(body.error ?? {}).sort()).toStrictEqual(["code", "message"]);
    expect(body.error?.code).toBe("SHIPPING_EXCEEDS_LIMIT");
    expect(body.estimate).toStrictEqual(expectedEstimate(1, FAR_AWAY));
    expect(body.estimate).toMatchObject({ shippingCost: "34.28", orderTotal: "184.28" });
    expect(await readState(db.pool)).toStrictEqual(before);
  });

  test("the 422 estimate equals what /orders/verify returns for the same input", async () => {
    for (const input of [
      { quantity: TOTAL_STOCK, ...AT_PARIS },
      { quantity: 1, latitude: -90, longitude: -180 },
    ]) {
      const verified = expectJson(await postJson(api, "/orders/verify", input), 200);
      const rejected = expectJson(
        await submit({ submissionId: "qa-same-estimate", ...input }),
        422,
      ) as { estimate: unknown };
      expect(rejected.estimate).toStrictEqual(verified);
    }
  });

  test("a rejected submissionId is re-evaluated when repeated and reusable for a new input", async () => {
    const shortRequest = { submissionId: "qa-reuse", quantity: TOTAL_STOCK + 1, ...AT_PARIS };
    const first = await submit(shortRequest);
    expect(first.status).toBe(422);
    const again = await submit(shortRequest);
    expect(again.status).toBe(422);
    expect(again.text).toBe(first.text);

    const far = await submit({ submissionId: "qa-reuse", quantity: 1, ...FAR_AWAY });
    expect((expectJson(far, 422) as { error: { code: string } }).error.code).toBe(
      "SHIPPING_EXCEEDS_LIMIT",
    );

    const accepted = await submit({ submissionId: "qa-reuse", quantity: 3, ...AT_PARIS });
    expect(expectJson(accepted, 201)).toStrictEqual(expectedOrder("qa-reuse", 3, AT_PARIS));

    // Once accepted, the earlier rejected inputs now conflict.
    expectErrorEnvelope(await submit(shortRequest), 409, "SUBMISSION_ID_CONFLICT", {
      issues: "absent",
    });
  });
});
