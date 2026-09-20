/**
 * QA API acceptance: GET /health and POST /api/v1/orders/verify over real HTTP.
 *
 * Literal amounts below are hand-computed from the PRD rules and seed data;
 * `expectedEstimate` is the independent oracle in ./support/oracle.ts.
 *
 * Verification is read-only, so the seed state is restored once for the file
 * (as the old suite did) rather than before every test; the run shares one
 * served API and one database, and the runner's single worker keeps files
 * apart.
 *
 * @module
 */

import { expect, test } from "@playwright/test";
import type { Pool } from "pg";

import { openPool, readState, resetDatabase } from "#test/support/database";
import { formatTitle } from "#test/support/each";
import { expectJson, get, postJson } from "#test/support/http";
import {
  ABOVE_LIMIT,
  AT_LIMIT,
  BELOW_LIMIT,
  type LimitDestination,
  expectedEstimate,
} from "#test/support/oracle";
import {
  AT_PARIS,
  FAR_AWAY,
  MANHATTAN,
  MAX_QUANTITY,
  TOTAL_STOCK,
  WAREHOUSES,
  type Warehouse,
  warehouse,
} from "#test/support/prd";
import { acceptanceDatabaseUrl, sharedApi } from "#test/support/shared-api";

const api = sharedApi();
let pool: Pool;

test.beforeAll(async () => {
  pool = openPool(acceptanceDatabaseUrl());
  await resetDatabase(pool);
});

test.afterAll(async () => {
  await pool.end();
});

const verify = (body: unknown) => postJson(api, "/api/v1/orders/verify", body);

test.describe("GET /health", () => {
  test('200 {"status":"ok"} as JSON', async () => {
    const response = await get(api, "/health");
    expect(expectJson(response, 200)).toStrictEqual({ status: "ok" });
    expect(response.text).toBe('{"status":"ok"}');
  });
});

test.describe("POST /api/v1/orders/verify: valid estimates", () => {
  test("30 units to Manhattan: New York stock, 5% discount, shipping rounded once half-up", async () => {
    // 30 x $150 = 4500.00; 5% = 225.00; 4275.00. Limit 15% of 4275.00 = 641.25.
    // New York to (40.7128, -74.006) ~ 20.80497 km; 30 x 0.365 x 0.01 x 20.80497 = 2.2781 -> 2.28.
    const response = await verify({ quantity: 30, ...MANHATTAN });
    const body = expectJson(response, 200);

    expect(body).toStrictEqual({
      valid: true,
      reason: null,
      quantity: 30,
      destination: MANHATTAN,
      unitPrice: "150.00",
      merchandiseSubtotal: "4500.00",
      discountRate: "0.05",
      discountAmount: "225.00",
      discountedMerchandiseTotal: "4275.00",
      shippingCost: "2.28",
      shippingLimit: "641.25",
      orderTotal: "4277.28",
      allocations: [
        {
          warehouseId: warehouse("New York").id,
          warehouseName: "New York",
          quantity: 30,
          distanceKm: expect.closeTo(20.80497359288961, 6),
        },
      ],
    });
    expect(body).toStrictEqual(expectedEstimate(30, MANHATTAN));
  });

  test("a destination at a warehouse has zero shipping", async () => {
    const body = expectJson(await verify({ quantity: 10, ...AT_PARIS }), 200);
    expect(body).toStrictEqual({
      valid: true,
      reason: null,
      quantity: 10,
      destination: AT_PARIS,
      unitPrice: "150.00",
      merchandiseSubtotal: "1500.00",
      discountRate: "0.00",
      discountAmount: "0.00",
      discountedMerchandiseTotal: "1500.00",
      shippingCost: "0.00",
      shippingLimit: "225.00",
      orderTotal: "1500.00",
      allocations: [
        {
          warehouseId: warehouse("Paris").id,
          warehouseName: "Paris",
          quantity: 10,
          distanceKm: 0,
        },
      ],
    });
  });

  test("700 units at Paris split nearest-first: 694 Paris + 6 Warsaw", async () => {
    // 105000.00 - 20% (21000.00) = 84000.00; 6 x 0.00365 x 1342.78413 = 29.4070 -> 29.41.
    const body = expectJson(await verify({ quantity: 700, ...AT_PARIS }), 200);
    expect(body).toStrictEqual({
      valid: true,
      reason: null,
      quantity: 700,
      destination: AT_PARIS,
      unitPrice: "150.00",
      merchandiseSubtotal: "105000.00",
      discountRate: "0.20",
      discountAmount: "21000.00",
      discountedMerchandiseTotal: "84000.00",
      shippingCost: "29.41",
      shippingLimit: "12600.00",
      orderTotal: "84029.41",
      allocations: [
        {
          warehouseId: warehouse("Paris").id,
          warehouseName: "Paris",
          quantity: 694,
          distanceKm: 0,
        },
        {
          warehouseId: warehouse("Warsaw").id,
          warehouseName: "Warsaw",
          quantity: 6,
          distanceKm: expect.closeTo(1342.7841255600601, 6),
        },
      ],
    });
  });

  test("1000 units to Manhattan names all three warehouses it draws from, nearest first", async () => {
    // New York holds 578, so the plan spills into Los Angeles (355) and then
    // Paris (67): a multi-warehouse plan whose every allocation must name the
    // warehouse its ID identifies, in the order the plan was built.
    const body = expectJson(await verify({ quantity: 1000, ...MANHATTAN }), 200) as {
      allocations: { warehouseId: string; warehouseName: string; quantity: number }[];
    };

    expect(
      body.allocations.map(({ warehouseId, warehouseName, quantity }) => ({
        warehouseId,
        warehouseName,
        quantity,
      })),
    ).toStrictEqual([
      { warehouseId: warehouse("New York").id, warehouseName: "New York", quantity: 578 },
      { warehouseId: warehouse("Los Angeles").id, warehouseName: "Los Angeles", quantity: 355 },
      { warehouseId: warehouse("Paris").id, warehouseName: "Paris", quantity: 67 },
    ]);
    // Each name is the seeded warehouse's own, looked up by the ID beside it,
    // so a plan that shuffled names between warehouses would fail here.
    expect(body.allocations.map(({ warehouseName }) => warehouseName)).toStrictEqual(
      body.allocations.map(
        ({ warehouseId }) =>
          (WAREHOUSES.find(({ id }) => id === warehouseId) as Warehouse | undefined)?.name,
      ),
    );
    expect(body).toStrictEqual(expectedEstimate(1000, MANHATTAN));
  });

  test("verification stores nothing and changes no row", async () => {
    const before = await readState(pool);
    for (const body of [
      { quantity: 30, ...MANHATTAN },
      { quantity: 1, ...FAR_AWAY },
      { quantity: TOTAL_STOCK + 1, ...AT_PARIS },
    ]) {
      expectJson(await verify(body), 200);
    }
    expect(await readState(pool)).toStrictEqual(before);
  });
});

test.describe("POST /api/v1/orders/verify: discount tier boundaries (at Paris, zero shipping)", () => {
  // The limit is 15% of the discounted total truncated toward zero, so the
  // half-cent tiers (25, 49, 249 units) publish 534.37, 1047.37 and 4762.12
  // rather than the half-up 534.38, 1047.38 and 4762.13.
  const cases = [
    // quantity, subtotal, rate, discount, discounted, limit
    [24, "3600.00", "0.00", "0.00", "3600.00", "540.00"],
    [25, "3750.00", "0.05", "187.50", "3562.50", "534.37"],
    [49, "7350.00", "0.05", "367.50", "6982.50", "1047.37"],
    [50, "7500.00", "0.10", "750.00", "6750.00", "1012.50"],
    [99, "14850.00", "0.10", "1485.00", "13365.00", "2004.75"],
    [100, "15000.00", "0.15", "2250.00", "12750.00", "1912.50"],
    [249, "37350.00", "0.15", "5602.50", "31747.50", "4762.12"],
    [250, "37500.00", "0.20", "7500.00", "30000.00", "4500.00"],
  ] as const;

  for (const testCase of cases) {
    const [quantity, subtotal, rate, discount, discounted, limit] = testCase;
    test(formatTitle("%i units", testCase), async () => {
      const body = expectJson(await verify({ quantity, ...AT_PARIS }), 200);
      expect(body).toStrictEqual({
        valid: true,
        reason: null,
        quantity,
        destination: AT_PARIS,
        unitPrice: "150.00",
        merchandiseSubtotal: subtotal,
        discountRate: rate,
        discountAmount: discount,
        discountedMerchandiseTotal: discounted,
        shippingCost: "0.00",
        shippingLimit: limit,
        orderTotal: discounted,
        allocations: [
          {
            warehouseId: warehouse("Paris").id,
            warehouseName: "Paris",
            quantity,
            distanceKm: 0,
          },
        ],
      });
      expect(body).toStrictEqual(expectedEstimate(quantity, AT_PARIS));
    });
  }
});

test.describe("POST /api/v1/orders/verify: invalid estimates are 200", () => {
  test("SHIPPING_EXCEEDS_LIMIT keeps every amount and allocation", async () => {
    // 1 unit from Hong Kong, ~9391.25073 km: 0.00365 x 9391.25073 = 34.2781 -> 34.28 > 22.50.
    const body = expectJson(await verify({ quantity: 1, ...FAR_AWAY }), 200);
    expect(body).toStrictEqual({
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      quantity: 1,
      destination: FAR_AWAY,
      unitPrice: "150.00",
      merchandiseSubtotal: "150.00",
      discountRate: "0.00",
      discountAmount: "0.00",
      discountedMerchandiseTotal: "150.00",
      shippingCost: "34.28",
      shippingLimit: "22.50",
      orderTotal: "184.28",
      allocations: [
        {
          warehouseId: warehouse("Hong Kong").id,
          warehouseName: "Hong Kong",
          quantity: 1,
          distanceKm: expect.closeTo(9391.250728720299, 6),
        },
      ],
    });
  });

  test("exact stock exhaustion (2556 at Paris) allocates every warehouse and exceeds the limit", async () => {
    // 306720.00 discounted; limit 46008.00; combined shipping 49066.60.
    const body = expectJson(await verify({ quantity: TOTAL_STOCK, ...AT_PARIS }), 200);
    expect(body).toMatchObject({
      valid: false,
      reason: "SHIPPING_EXCEEDS_LIMIT",
      merchandiseSubtotal: "383400.00",
      discountRate: "0.20",
      discountAmount: "76680.00",
      discountedMerchandiseTotal: "306720.00",
      shippingCost: "49066.60",
      shippingLimit: "46008.00",
      orderTotal: "355786.60",
    });
    expect(body).toStrictEqual(expectedEstimate(TOTAL_STOCK, AT_PARIS));
  });

  test("INSUFFICIENT_STOCK has merchandise amounts, null shipping/limit/total and no allocations", async () => {
    // `unitPrice` is a fact about the catalogue, so it survives a rejection;
    // `shippingLimit` does not, because nothing was planned to charge for.
    const body = expectJson(await verify({ quantity: TOTAL_STOCK + 1, ...AT_PARIS }), 200);
    expect(body).toStrictEqual({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      quantity: 2557,
      destination: AT_PARIS,
      unitPrice: "150.00",
      merchandiseSubtotal: "383550.00",
      discountRate: "0.20",
      discountAmount: "76710.00",
      discountedMerchandiseTotal: "306840.00",
      shippingCost: null,
      shippingLimit: null,
      orderTotal: null,
      allocations: [],
    });
  });

  test("MAX_QUANTITY is well-formed: INSUFFICIENT_STOCK with the largest amounts", async () => {
    const body = expectJson(await verify({ quantity: MAX_QUANTITY, ...AT_PARIS }), 200);
    expect(body).toMatchObject({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      unitPrice: "150.00",
      merchandiseSubtotal: "9999999900.00",
      discountRate: "0.20",
      discountAmount: "1999999980.00",
      discountedMerchandiseTotal: "7999999920.00",
      shippingCost: null,
      shippingLimit: null,
      orderTotal: null,
      allocations: [],
    });
  });
});

test.describe("POST /api/v1/orders/verify: coordinate endpoints are accepted", () => {
  const endpoints = [
    { latitude: 90, longitude: 180 },
    { latitude: -90, longitude: -180 },
    { latitude: 90, longitude: -180 },
    { latitude: -90, longitude: 180 },
    { latitude: 0, longitude: 180 },
    { latitude: 0, longitude: -180 },
  ];

  for (const testCase of endpoints) {
    const destination = testCase;
    test(formatTitle("(%o)", [testCase]), async () => {
      const body = expectJson(await verify({ quantity: 1, ...destination }), 200);
      expect(body).toStrictEqual(expectedEstimate(1, destination));
    });
  }

  test("north pole literal: Warsaw, 0.00365 x 4206.97324 = 15.3554 -> 15.36, valid", async () => {
    const body = expectJson(await verify({ quantity: 1, latitude: 90, longitude: 180 }), 200);
    expect(body).toMatchObject({
      valid: true,
      shippingCost: "15.36",
      shippingLimit: "22.50",
      orderTotal: "165.36",
      allocations: [{ warehouseId: warehouse("Warsaw").id, warehouseName: "Warsaw", quantity: 1 }],
    });
  });
});

test.describe("POST /api/v1/orders/verify: shipping limit boundary (1 unit, limit 22.50)", () => {
  // 15% of 150.00 = 22.50. Each destination is found and checked by the
  // independent oracle in ./support/oracle.ts: one warehouse, a distance in the
  // middle of the charge's rounding window, and every other warehouse >= 100 km
  // farther.
  const coordinates = ({ latitude, longitude }: LimitDestination) => ({ latitude, longitude });

  for (const testCase of [
    ["22.49 is below the limit: valid", BELOW_LIMIT, "22.49", "172.49", true],
    ["22.50 equals the limit: valid", AT_LIMIT, "22.50", "172.50", true],
    ["22.51 is above the limit: SHIPPING_EXCEEDS_LIMIT", ABOVE_LIMIT, "22.51", "172.51", false],
  ] as const) {
    const [_name, destination, shipping, total, valid] = testCase;
    test(formatTitle("%s", testCase), async () => {
      expect(destination.shippingCost).toBe(shipping);
      const body = expectJson(await verify({ quantity: 1, ...coordinates(destination) }), 200);
      expect(body).toStrictEqual({
        valid,
        reason: valid ? null : "SHIPPING_EXCEEDS_LIMIT",
        quantity: 1,
        destination: coordinates(destination),
        unitPrice: "150.00",
        merchandiseSubtotal: "150.00",
        discountRate: "0.00",
        discountAmount: "0.00",
        discountedMerchandiseTotal: "150.00",
        shippingCost: shipping,
        shippingLimit: "22.50",
        orderTotal: total,
        allocations: [
          {
            warehouseId: destination.warehouse.id,
            warehouseName: destination.warehouse.name,
            quantity: 1,
            distanceKm: expect.closeTo(destination.distanceKm, 6),
          },
        ],
      });
      expect(body).toStrictEqual(expectedEstimate(1, coordinates(destination)));
    });
  }
});

test.describe("POST /api/v1/orders/verify: a caller can re-derive the verdict from the body alone", () => {
  // This is what publishing `unitPrice` and `shippingLimit` is for. A client
  // holding nothing but the response — no seed data, no oracle, no knowledge
  // of the $150 catalogue price or of the discount tiers — can explain the
  // verdict to its own user: what the merchandise came to, what shipping was
  // allowed, and by how much the charge missed. The comparison
  // `shippingCost <= shippingLimit` needs no commercial rule at all, and it
  // agrees with the server on every cent because the published limit is
  // truncated rather than rounded.
  //
  // Everything below is exact integer cent arithmetic on the response strings:
  // parsing a Money amount as a JavaScript number would reintroduce the
  // rounding the string representation exists to avoid.

  /** A Money string ("1234.56") as a whole number of cents. */
  const cents = (money: string): bigint => {
    expect(money, "a Money amount").toMatch(/^\d{1,10}\.\d{2}$/);
    return BigInt(money.replace(".", ""));
  };

  interface PricedEstimate {
    valid: boolean;
    reason: string | null;
    quantity: number;
    unitPrice: string;
    merchandiseSubtotal: string;
    discountedMerchandiseTotal: string;
    shippingCost: string;
    shippingLimit: string;
    orderTotal: string;
  }

  /** The three identities a caller can check with only the body in hand. */
  function reDerive(body: PricedEstimate): { shipping: bigint; limit: bigint } {
    // The merchandise is quantity x the published unit price.
    expect(cents(body.merchandiseSubtotal)).toBe(BigInt(body.quantity) * cents(body.unitPrice));
    // The limit is 15% of the discounted total, truncated toward zero.
    const discounted = cents(body.discountedMerchandiseTotal);
    const limit = cents(body.shippingLimit);
    expect(limit).toBe((discounted * 15n) / 100n);
    // The total is the discounted merchandise plus the shipping charge.
    const shipping = cents(body.shippingCost);
    expect(cents(body.orderTotal)).toBe(discounted + shipping);
    return { shipping, limit };
  }

  test("SHIPPING_EXCEEDS_LIMIT: the body explains its own rejection", async () => {
    const body = expectJson(await verify({ quantity: 1, ...FAR_AWAY }), 200) as PricedEstimate;
    const { shipping, limit } = reDerive(body);

    expect(body.valid).toBe(false);
    expect(body.reason).toBe("SHIPPING_EXCEEDS_LIMIT");
    expect(shipping > limit).toBe(true);
    // 34.28 charged against a 22.50 allowance: 11.78 over.
    expect(shipping - limit).toBe(1178n);
  });

  test("a valid estimate: the charge is at or under the published limit", async () => {
    const body = expectJson(await verify({ quantity: 30, ...MANHATTAN }), 200) as PricedEstimate;
    const { shipping, limit } = reDerive(body);

    expect(body.valid).toBe(true);
    expect(body.reason).toBeNull();
    expect(shipping <= limit).toBe(true);
  });

  test("at the limit: shipping exactly equal to the limit is valid", async () => {
    const destination = { latitude: AT_LIMIT.latitude, longitude: AT_LIMIT.longitude };
    const body = expectJson(await verify({ quantity: 1, ...destination }), 200) as PricedEstimate;
    const { shipping, limit } = reDerive(body);

    // Equality is the boundary the server accepts, and the truncated limit
    // puts the caller's own comparison on exactly the same cent.
    expect(shipping).toBe(limit);
    expect(shipping <= limit).toBe(true);
    expect(body.valid).toBe(true);
    expect(body.reason).toBeNull();
  });
});
