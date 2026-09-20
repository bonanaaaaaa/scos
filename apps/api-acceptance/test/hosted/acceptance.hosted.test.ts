/**
 * QA acceptance for the hosted Cloudflare demonstration (issue #33): health,
 * estimates, acceptance, rejection, retry and conflict, decimal serialization,
 * the OpenAPI document and the interactive docs, all over real `fetch` against
 * the deployed Worker named by `HOSTED_BASE_URL`.
 *
 * Nothing local is started and nothing is mocked. Expected amounts come from
 * this app's QA oracle (#test/support/oracle.ts), written from the PRD and
 * shared with the CI acceptance suite; that oracle is handed the inventory
 * ./support.ts reads from the deployment at runtime, never the seed constant
 * in #test/support/prd.ts.
 *
 * ## Stock budget
 *
 * The hosted inventory is shared, finite and never replenished, and issue #33
 * forbids resetting it, so this suite is written to be cheap enough to re-run
 * indefinitely: **one full run consumes exactly 1 unit of stock**, the single
 * accepted Order below. Every other scenario is free — verification stores
 * nothing, and business rejections, conflicts and malformed requests consume no
 * key and no stock (docs/adr/0004-deduplicate-accepted-orders.md) — and each of
 * those is asserted to have left the inventory untouched.
 *
 * The suite is not part of CI, `turbo run test` or `test:acceptance`: it needs
 * a live deployment those do not have, and it spends real stock. It has no
 * turbo task for the same reason. Run it with
 * `HOSTED_BASE_URL=... pnpm --filter @scos/api-acceptance run test:hosted`.
 *
 * ## Why this suite does not use this app's external (`API_BASE_URL`) mode
 *
 * `apps/api-acceptance` already has a mode that points the ordinary acceptance
 * suite at an already-running server. It must never be pointed at the hosted
 * demonstration, and this suite must never be wired into it. That mode
 * connects to `DATABASE_TEST_URL` and migrates, seeds and deletes every Order
 * and warehouse row between test files (test/global-setup.ts,
 * test/support/provision.ts, test/support/database.ts), which is why it is
 * guarded by `SCOS_CONFIRM_ACCEPTANCE_RESET`. Run against the live deployment
 * it would destroy the demonstration data and reset its stock, which issue #33
 * forbids outright ("without unsafe stock resets").
 *
 * So this suite is deliberately a different thing, and has to stay one:
 *
 * - it is a black box over HTTP only. It opens no database connection, not
 *   even optionally, and imports nothing from `#test/support/database`,
 *   `#test/support/provision` or `#test/support/environment`. The only
 *   support it shares is the pure part: the PRD constants, the oracle and the
 *   `fetch` helpers.
 * - it has no global setup, so `test/global-setup.ts` never loads. It is its
 *   own Playwright project (`hosted`), and ../../playwright.config.ts wires
 *   the global setup only when the `acceptance` project runs; the two
 *   projects are also kept apart by their file suffixes, because the
 *   acceptance project matches every `.acceptance.test.ts` file under `test`
 *   recursively and a subdirectory alone would not exclude these files.
 *   `playwright test --project=hosted --list` is the check that proves it.
 * - it reads `HOSTED_BASE_URL` and nothing else — not `API_BASE_URL`, not
 *   `DATABASE_TEST_URL`, not `SCOS_CONFIRM_ACCEPTANCE_RESET`. A variable whose
 *   meaning elsewhere is "you may wipe the database behind this URL" must not
 *   be able to reach the hosted deployment by meaning something else here.
 * - it reads the live stock at runtime and never resets it or assumes a level.
 *
 * Do not "simplify" this by merging it into the external mode. That would be a
 * data-loss bug, not a refactor.
 *
 * @module
 */

import { expect, test } from "@playwright/test";

import { formatTitle } from "#test/support/each";
import {
  type ApiUnderTest,
  type HttpResult,
  type RawRequest,
  expectErrorEnvelope,
  expectJson,
  get,
  postJson,
  request,
} from "#test/support/http";
import { expectedEstimate, expectedOrder } from "#test/support/oracle";
import {
  AT_PARIS,
  FAR_AWAY,
  MANHATTAN,
  MAX_QUANTITY,
  ORDER_KEYS,
  ORDER_NUMBER,
  type Warehouse,
  warehouse,
} from "#test/support/prd";

import {
  HEALTH,
  HTTP_METHODS,
  type JsonRecord,
  ESTIMATE_ONLY_MONEY,
  MONEY_FIELDS,
  type Method,
  SUBMIT,
  type ServedSpec,
  VERIFY,
  applyAcceptedOrder,
  dig,
  expectConforms,
  expectDecimalStrings,
  freshSubmissionId,
  hostedApi,
  loadServedSpec,
  operation,
  readStock,
  stableRead,
  totalStock,
} from "./support";

/**
 * The scenarios below observe one deployment in order, and several of them
 * read state a hook or an earlier scenario left in this module — above all the
 * single accepted Order. Playwright retries a failed test in a **fresh worker
 * process**, which re-imports this file and re-runs only the hooks enclosing
 * that one test; serial mode instead replays the whole file from the start, so
 * the state is rebuilt in order. The replay costs no stock: this run's
 * submissionIds are stable (./support.ts, `SCOS_HOSTED_RUN_ID`), so the
 * re-submission is a replay of the same Order rather than a second one.
 */
test.describe.configure({ mode: "serial" });

let api: ApiUnderTest;
let spec: ServedSpec;

// Nothing to tear down: `ApiUnderTest` is only a base URL, and the deployment
// is not this suite's to stop.
test.beforeAll(async () => {
  api = hostedApi();
  spec = await loadServedSpec(api);
});

const verify = (body: unknown) => postJson(api, VERIFY, body);
const submit = (body: unknown) => postJson(api, SUBMIT, body);

/**
 * The single Order this run creates, shared by the acceptance, retry, conflict
 * and serialization scenarios, so the whole suite costs one unit. Its
 * submissionId is fresh, so re-runs never collide with each other. 1 unit is
 * the smallest order that demonstrates acceptance; Manhattan rather than a
 * warehouse's own coordinates, so shipping is a real rounded charge.
 */
const acceptedSubmissionId = freshSubmissionId("accept");
const acceptedRequest = { submissionId: acceptedSubmissionId, quantity: 1, ...MANHATTAN };
let stockAtAcceptance: readonly Warehouse[];
let accepted: HttpResult;

test.describe("GET /health", () => {
  test('200 {"status":"ok"} as JSON', async () => {
    const response = await get(api, HEALTH);
    expect(expectJson(response, 200)).toStrictEqual({ status: "ok" });
    expect(response.text).toBe('{"status":"ok"}');
    expectConforms(spec, HEALTH, "get", response);
  });
});

test.describe("POST /api/v1/orders/verify: estimates match the independent oracle", () => {
  test("30 units to Manhattan: every amount and allocation", async () => {
    const { stock, value: response } = await stableRead(api, () =>
      verify({ quantity: 30, ...MANHATTAN }),
    );
    const body = expectJson(response, 200);
    expect(body).toStrictEqual(expectedEstimate(30, MANHATTAN, stock));
    expectConforms(spec, VERIFY, "post", response);
  });

  test("a destination at the Paris warehouse ships for 0.00", async () => {
    const { stock, value: response } = await stableRead(api, () =>
      verify({ quantity: 1, ...AT_PARIS }),
    );
    const paris = stock.find(({ id }) => id === warehouse("Paris").id) as Warehouse;
    expect(
      paris.stock,
      "the Paris warehouse is empty, so the zero-distance case cannot be shown from it",
    ).toBeGreaterThan(0);

    const body = expectJson(response, 200);
    expect(body).toStrictEqual(expectedEstimate(1, AT_PARIS, stock));
    expect(body).toMatchObject({
      valid: true,
      shippingCost: "0.00",
      orderTotal: "150.00",
      allocations: [{ warehouseId: warehouse("Paris").id, quantity: 1, distanceKm: 0 }],
    });
  });

  // The PRD tier boundaries. Merchandise amounts depend on quantity alone, so
  // they are asserted literally as well as through the oracle, and they hold
  // whether or not that many units are still available.
  for (const testCase of [
    // quantity, subtotal, rate, discount, discounted
    [24, "3600.00", "0.00", "0.00", "3600.00"],
    [25, "3750.00", "0.05", "187.50", "3562.50"],
    [49, "7350.00", "0.05", "367.50", "6982.50"],
    [50, "7500.00", "0.10", "750.00", "6750.00"],
    [99, "14850.00", "0.10", "1485.00", "13365.00"],
    [100, "15000.00", "0.15", "2250.00", "12750.00"],
    [249, "37350.00", "0.15", "5602.50", "31747.50"],
    [250, "37500.00", "0.20", "7500.00", "30000.00"],
  ] as const) {
    const [quantity, subtotal, rate, discount, discounted] = testCase;
    test(
      formatTitle("%i units at Paris: %s subtotal at a %s discount rate", testCase),
      async () => {
        const { stock, value: response } = await stableRead(api, () =>
          verify({ quantity, ...AT_PARIS }),
        );
        const body = expectJson(response, 200);
        expect(body).toMatchObject({
          quantity,
          merchandiseSubtotal: subtotal,
          discountRate: rate,
          discountAmount: discount,
          discountedMerchandiseTotal: discounted,
        });
        expect(body).toStrictEqual(expectedEstimate(quantity, AT_PARIS, stock));
      },
    );
  }

  test("more units than exist is INSUFFICIENT_STOCK with null shipping and total", async () => {
    // Stock is never replenished, so one more than any earlier reading of the
    // total is still more than the deployment has.
    const total = totalStock(await readStock(api));
    const { stock, value: response } = await stableRead(api, () =>
      verify({ quantity: total + 1, ...AT_PARIS }),
    );
    const body = expectJson(response, 200);
    expect(body).toMatchObject({
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    });
    expect(body).toStrictEqual(expectedEstimate(total + 1, AT_PARIS, stock));
    expectConforms(spec, VERIFY, "post", response);
  });

  test("a destination far from every warehouse is SHIPPING_EXCEEDS_LIMIT", async () => {
    const { stock, value: response } = await stableRead(api, () =>
      verify({ quantity: 1, ...FAR_AWAY }),
    );
    const body = expectJson(response, 200);
    expect(body).toMatchObject({ valid: false, reason: "SHIPPING_EXCEEDS_LIMIT" });
    expect(body).toStrictEqual(expectedEstimate(1, FAR_AWAY, stock));
  });
});

test.describe("POST /api/v1/orders: acceptance, retry and conflict", () => {
  test.beforeAll(async () => {
    stockAtAcceptance = await readStock(api);
    accepted = await submit(acceptedRequest);
    if (accepted.status === 201) {
      const { allocations } = accepted.json() as {
        allocations: { warehouseId: string; quantity: number }[];
      };
      // Keep the cached reading current, so later readings cost two requests.
      applyAcceptedOrder(allocations);
    }
  });

  test("201 with the documented key set, an order number and the oracle's amounts", () => {
    const body = expectJson(accepted, 201) as JsonRecord;
    expect(Object.keys(body).sort()).toStrictEqual(ORDER_KEYS);
    expect(body.orderNumber).toMatch(ORDER_NUMBER);
    expect(body).toStrictEqual(
      expectedOrder(acceptedSubmissionId, 1, MANHATTAN, stockAtAcceptance),
    );
    // The internal database id is never exposed.
    expect(accepted.text).not.toMatch(/"id"/);
    expectConforms(spec, SUBMIT, "post", accepted);
  });

  test("the accepted Order deducted its allocation from the warehouse it named", async () => {
    const { allocations } = accepted.json() as {
      allocations: { warehouseId: string; quantity: number }[];
    };
    const after = await readStock(api);
    for (const before of stockAtAcceptance) {
      const taken = allocations
        .filter(({ warehouseId }) => warehouseId === before.id)
        .reduce((sum, { quantity }) => sum + quantity, 0);
      const now = after.find(({ id }) => id === before.id) as Warehouse;
      // The deployment is shared and stock is only ever deducted, never
      // replenished, so "at most what this Order left" is the strongest claim
      // that holds against a concurrent client.
      expect(now.stock, `${before.name} after the accepted Order`).toBeLessThanOrEqual(
        before.stock - taken,
      );
    }
    expect(totalStock(after)).toBeLessThanOrEqual(totalStock(stockAtAcceptance) - 1);
  });

  test("replaying the same submissionId returns the same Order and deducts nothing", async () => {
    // A replay is idempotent, so `stableRead` may repeat it while looking for a
    // window in which no other client moved the inventory.
    const { value: replay } = await stableRead(api, () => submit(acceptedRequest));
    expect(replay.status, replay.text).toBe(201);

    const original = accepted.json() as { orderNumber: string };
    const repeated = replay.json() as { orderNumber: string };
    expect(repeated.orderNumber).toBe(original.orderNumber);
    // The contract promises a byte-identical body, not merely an equal one.
    expect(replay.text).toBe(accepted.text);
    expectConforms(spec, SUBMIT, "post", replay);
    // `stableRead` returned, so the readings either side of the replay were
    // identical: the replay deducted nothing.
  });

  test("the same submissionId with a different quantity is 409 SUBMISSION_ID_CONFLICT", async () => {
    const { value: conflict } = await stableRead(api, () =>
      submit({ ...acceptedRequest, quantity: 2 }),
    );
    expectErrorEnvelope(conflict, 409, "SUBMISSION_ID_CONFLICT", { issues: "absent" });
    // ADR 0004: the existing Order is unchanged and not disclosed.
    const { orderNumber } = accepted.json() as { orderNumber: string };
    expect(conflict.text).not.toContain(orderNumber);
    expectConforms(spec, SUBMIT, "post", conflict);
  });

  test("the same submissionId with a different destination is also a conflict", async () => {
    const { value: conflict } = await stableRead(api, () =>
      submit({ ...acceptedRequest, ...AT_PARIS }),
    );
    expectErrorEnvelope(conflict, 409, "SUBMISSION_ID_CONFLICT", { issues: "absent" });
    expectConforms(spec, SUBMIT, "post", conflict);
  });
});

test.describe("POST /api/v1/orders: rejections store nothing and consume no stock", () => {
  test("INSUFFICIENT_STOCK: 422 with the estimate that caused it", async () => {
    const total = totalStock(await readStock(api));
    const { stock, value: rejected } = await stableRead(api, () =>
      submit({ submissionId: freshSubmissionId("short"), quantity: total + 1, ...AT_PARIS }),
    );
    const body = expectJson(rejected, 422) as JsonRecord;
    expect(Object.keys(body).sort()).toStrictEqual(["error", "estimate"]);
    expect(dig(body, "error").code).toBe("INSUFFICIENT_STOCK");
    expect(typeof dig(body, "error").message).toBe("string");
    expect(body.estimate).toStrictEqual(expectedEstimate(total + 1, AT_PARIS, stock));
    expectConforms(spec, SUBMIT, "post", rejected);
  });

  test("SHIPPING_EXCEEDS_LIMIT: 422 with every amount of the estimate", async () => {
    const { stock, value: rejected } = await stableRead(api, () =>
      submit({ submissionId: freshSubmissionId("far"), quantity: 1, ...FAR_AWAY }),
    );
    const body = expectJson(rejected, 422) as JsonRecord;
    expect(Object.keys(body).sort()).toStrictEqual(["error", "estimate"]);
    expect(dig(body, "error").code).toBe("SHIPPING_EXCEEDS_LIMIT");
    expect(body.estimate).toStrictEqual(expectedEstimate(1, FAR_AWAY, stock));
    expectConforms(spec, SUBMIT, "post", rejected);
  });

  test("malformed requests are 400 INVALID_REQUEST and store nothing", async () => {
    const submissionId = freshSubmissionId("malformed");
    const cases: [string, RawRequest][] = [
      [
        "a quantity sent as a string",
        { body: JSON.stringify({ submissionId, quantity: "1", ...AT_PARIS }) },
      ],
      [
        "a latitude sent as a string",
        { body: JSON.stringify({ submissionId, quantity: 1, latitude: "0", longitude: 0 }) },
      ],
      [
        "an unknown field",
        { body: JSON.stringify({ submissionId, quantity: 1, ...AT_PARIS, giftWrap: true }) },
      ],
      [
        "an out-of-range latitude",
        { body: JSON.stringify({ submissionId, quantity: 1, latitude: 90.5, longitude: 0 }) },
      ],
      ["a missing submissionId", { body: JSON.stringify({ quantity: 1, ...AT_PARIS }) }],
      ["malformed JSON", { body: '{"quantity": 1,' }],
      [
        "no Content-Type",
        { body: JSON.stringify({ submissionId, quantity: 1, ...AT_PARIS }), contentType: null },
      ],
    ];

    const { value: results } = await stableRead(api, async () => {
      const responses: [string, HttpResult][] = [];
      for (const [name, raw] of cases) {
        responses.push([name, await request(api, SUBMIT, raw)]);
      }
      return responses;
    });

    for (const [name, response] of results) {
      expect(response.status, `${name}: ${response.text}`).toBe(400);
      expectErrorEnvelope(response, 400, "INVALID_REQUEST");
      expectConforms(spec, SUBMIT, "post", response);
    }
    // `stableRead` returned, so none of them moved the inventory.
  });
});

test.describe("decimal serialization: money is a two-decimal JSON string, never a number", () => {
  // An estimate carries every amount an Order does, including `unitPrice`,
  // plus the shipping limit the charge was tested against.
  const ESTIMATE_MONEY = [...MONEY_FIELDS, ...ESTIMATE_ONLY_MONEY];
  // A quantity above the remaining stock nulls shipping, its limit and the
  // order total.
  const NULLABLE = { nullable: ["shippingCost", "shippingLimit", "orderTotal"] };

  test("a valid estimate", async () => {
    const response = await verify({ quantity: 30, ...MANHATTAN });
    expectJson(response, 200);
    expectDecimalStrings(response.text, [...ESTIMATE_MONEY, "discountRate"]);
  });

  test("an estimate at a discount tier, where the rate is not 0.00", async () => {
    const response = await verify({ quantity: 250, ...AT_PARIS });
    expectJson(response, 200);
    expect(response.text).toContain('"discountRate":"0.20"');
    expectDecimalStrings(response.text, [...ESTIMATE_MONEY, "discountRate"], NULLABLE);
  });

  test("an INSUFFICIENT_STOCK estimate sends JSON null, never 0 or a number", async () => {
    const total = totalStock(await readStock(api));
    const response = await verify({ quantity: total + 1, ...AT_PARIS });
    expectJson(response, 200);
    expect(response.text).toContain('"shippingCost":null');
    expect(response.text).toContain('"shippingLimit":null');
    expect(response.text).toContain('"orderTotal":null');
    expectDecimalStrings(response.text, [...ESTIMATE_MONEY, "discountRate"], NULLABLE);
  });

  test("the accepted Order, including unitPrice", () => {
    expectJson(accepted, 201);
    expect(accepted.text).toContain('"unitPrice":"150.00"');
    expectDecimalStrings(accepted.text, [...MONEY_FIELDS, "discountRate"]);
  });

  test("the largest amounts the contract allows are still plain decimal strings", async () => {
    const response = await verify({ quantity: MAX_QUANTITY, ...AT_PARIS });
    expectJson(response, 200);
    expect(response.text).toContain('"merchandiseSubtotal":"9999999900.00"');
    // No exponent form anywhere in the body, inside a string or out of one.
    expect(response.text).not.toMatch(/\d[eE][+-]?\d/);
    expectDecimalStrings(response.text, [...ESTIMATE_MONEY, "discountRate"], NULLABLE);
  });
});

test.describe("GET /openapi.json", () => {
  test("200 JSON and an OpenAPI 3.1 document", async () => {
    const response = await get(api, "/openapi.json");
    const document = expectJson(response, 200) as JsonRecord;
    expect(document.openapi).toMatch(/^3\.1\.\d+$/);
    expect(dig(document, "info").title).toBeTruthy();
    // loadServedSpec dereferenced this same document in beforeAll, which is
    // where an unresolvable $ref would already have failed the run.
    expect(Object.keys(dig(spec.resolved, "paths")).length).toBeGreaterThan(0);
  });

  test("is stable across requests", async () => {
    const first = await get(api, "/openapi.json");
    const second = await get(api, "/openapi.json");
    expect(second.text).toBe(first.text);
  });

  test("describes the routes the deployment actually serves", async () => {
    const paths = dig(spec.raw, "paths");
    const documented: [string, Method][] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, definition] of Object.entries(item as JsonRecord)) {
        if (!HTTP_METHODS.includes(method)) {
          continue;
        }
        expect(Object.keys(dig(definition, "responses")).length).toBeGreaterThan(0);
        documented.push([path, method as Method]);
      }
    }
    expect(documented.length).toBeGreaterThan(0);

    for (const [path, method] of documented) {
      // An empty body is invalid for both POST operations, and 400 is a
      // documented outcome, so this probes every route without consuming stock.
      const response = method === "get" ? await get(api, path) : await postJson(api, path, {});
      expect(response.status, `${method.toUpperCase()} ${path}: ${response.text}`).not.toBe(404);
      expectConforms(spec, path, method, response);
    }
  });

  test("every documented response is JSON under a status the contract allows", () => {
    for (const [path, method] of [
      [HEALTH, "get"],
      [VERIFY, "post"],
      [SUBMIT, "post"],
    ] as [string, Method][]) {
      const responses = dig(operation(spec, path, method), "responses");
      expect(Object.keys(responses).length, `${path} responses`).toBeGreaterThan(0);
      for (const [status, response] of Object.entries(responses)) {
        expect(Number(status), `${path} ${status}`).toBeGreaterThanOrEqual(200);
        expect(Object.keys(dig(response, "content")), `${path} ${status}`).toStrictEqual([
          "application/json",
        ]);
      }
    }
  });

  test("an undocumented route is the documented 404 envelope", async () => {
    const response = await get(api, "/api/v1/no-such-route");
    expectErrorEnvelope(response, 404, "NOT_FOUND", { issues: "absent" });
  });
});

test.describe("GET /docs", () => {
  test("200 text/html booting Swagger UI", async () => {
    const response = await get(api, "/docs");
    expect(response.status, response.text).toBe(200);
    expect(response.contentType).toMatch(/^text\/html/i);
    const html = response.text;
    expect(html).toMatch(/<html/i);
    expect(html).toContain('id="swagger-ui"');
    expect(html).toMatch(/<script[^>]+src="[^"]*swagger-ui-bundle\.js"/);
    expect(html).toMatch(/<link[^>]+href="[^"]*swagger-ui\.css"/);
    expect(html).toContain("dom_id: '#swagger-ui'");
  });

  test("the specification it loads is the one the deployment serves", async () => {
    const html = (await get(api, "/docs")).text;
    const url = /url:\s*['"]([^'"]+)['"]/.exec(html)?.[1];
    expect(url, "the page does not point Swagger UI at a specification").toBeDefined();
    const loaded = await get(api, url as string);
    expect(loaded.status, loaded.text).toBe(200);
    expect(loaded.json()).toStrictEqual(spec.raw);
  });
});
