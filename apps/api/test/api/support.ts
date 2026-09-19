/**
 * QA-owned support for the black-box API acceptance tests.
 *
 * The API runs as a real HTTP listener (`startServer` with @hono/node-server on
 * an ephemeral port) over an isolated, migrated and seeded database, and every
 * request goes through `fetch`. Expected amounts come from an independent
 * oracle written from the PRD rules (docs/prd/scos-ordering.md), not from
 * `@scos/core`: $150 per unit, 0/5/10/15/20% at 25/50/100/250 units,
 * nearest-first allocation (ties by warehouse ID), shipping 0.365 kg x
 * $0.01/kg/km x great-circle km summed and rounded once half-up to cents, and a
 * limit of 15% of the discounted merchandise total.
 *
 * @module
 */

import { serve } from "@hono/node-server";
import { expect } from "vitest";

import { composeApplication } from "../../src/composition/node";
import { parseHealthConfig } from "../../src/endpoints/health/config";
import { startServer } from "../../src/entrypoints/node";
import { createTelemetryRuntime } from "../../src/telemetry/node/sdk";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface RunningApi {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

const silentLogger = { error: () => undefined };

/** Telemetry off and logs silent: these tests assert HTTP behaviour only. */
function quietTelemetry() {
  const parsed = parseHealthConfig({ OTEL_SDK_DISABLED: "true", LOG_LEVEL: "silent" });
  if (!parsed.success) {
    throw new Error(parsed.errors.join("; "));
  }
  return parsed.config.telemetry;
}

/** Starts the real Node.js listener on an ephemeral port. */
export async function startApi(databaseUrl: string): Promise<RunningApi> {
  let resolvePort: (port: number) => void = () => undefined;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const running = startServer(
    { databaseUrl, port: 0, telemetry: quietTelemetry() },
    {
      serve: (options, onListening) =>
        serve(options, (info) => {
          onListening(info);
          resolvePort(info.port);
        }),
      compose: (options) => composeApplication({ ...options, logger: silentLogger }),
      startTelemetry: (config) => createTelemetryRuntime(config),
    },
  );
  const port = await listening;
  return { baseUrl: `http://127.0.0.1:${port}`, stop: () => running.shutdown() };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Headers;
  readonly text: string;
  json(): unknown;
}

export interface RawRequest {
  readonly method?: string;
  /** A string is sent as-is; a Uint8Array is sent with no implicit Content-Type. */
  readonly body?: string | Uint8Array<ArrayBuffer>;
  /** `null` sends no Content-Type header at all. Defaults to application/json. */
  readonly contentType?: string | null;
}

export async function request(
  api: RunningApi,
  path: string,
  { method = "POST", body, contentType = "application/json" }: RawRequest = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = body;
  }
  const response = await fetch(`${api.baseUrl}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    headers: response.headers,
    text,
    json: () => JSON.parse(text) as unknown,
  };
}

export function postJson(api: RunningApi, path: string, body: unknown): Promise<HttpResult> {
  return request(api, path, { body: JSON.stringify(body) });
}

export function get(api: RunningApi, path: string): Promise<HttpResult> {
  return request(api, path, { method: "GET", contentType: null });
}

/** Every response body is JSON sent as application/json. */
export function expectJson(result: HttpResult, status: number): unknown {
  expect(result.status, result.text).toBe(status);
  expect(result.contentType).toMatch(/^application\/json(\s*;\s*charset=utf-8)?$/i);
  return result.json();
}

/** The documented error envelope, exactly: `{ error: { code, message[, issues] } }`. */
export function expectErrorEnvelope(
  result: HttpResult,
  status: number,
  code: string,
  { issues }: { issues: "present" | "absent" | "any" } = { issues: "any" },
): { code: string; message: string; issues?: { path: (string | number)[]; message: string }[] } {
  const body = expectJson(result, status) as { error: Record<string, unknown> };
  expect(Object.keys(body)).toStrictEqual(["error"]);
  const error = body.error;
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe("string");
  expect(error.message).not.toBe("");
  const keys = Object.keys(error).sort();
  if (issues === "present") {
    expect(keys).toStrictEqual(["code", "issues", "message"]);
  } else if (issues === "absent") {
    expect(keys).toStrictEqual(["code", "message"]);
  } else {
    expect(["code,message", "code,issues,message"]).toContain(keys.join(","));
  }
  if (error.issues !== undefined) {
    expect(Array.isArray(error.issues)).toBe(true);
    expect((error.issues as unknown[]).length).toBeGreaterThan(0);
    for (const issue of error.issues as Record<string, unknown>[]) {
      expect(Object.keys(issue).sort()).toStrictEqual(["message", "path"]);
      expect(Array.isArray(issue.path)).toBe(true);
      for (const segment of issue.path as unknown[]) {
        expect(["string", "number"]).toContain(typeof segment);
      }
      expect(typeof issue.message).toBe("string");
    }
  }
  return error as never;
}

// ---------------------------------------------------------------------------
// PRD data (docs/prd/scos-ordering.md, "Seed data")
// ---------------------------------------------------------------------------

export interface Warehouse {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly stock: number;
}

export const WAREHOUSES: readonly Warehouse[] = [
  {
    id: "01996000-0000-7000-8000-000000000001",
    name: "Los Angeles",
    latitude: 33.9425,
    longitude: -118.408056,
    stock: 355,
  },
  {
    id: "01996000-0000-7000-8000-000000000002",
    name: "New York",
    latitude: 40.639722,
    longitude: -73.778889,
    stock: 578,
  },
  {
    id: "01996000-0000-7000-8000-000000000003",
    name: "São Paulo",
    latitude: -23.435556,
    longitude: -46.473056,
    stock: 265,
  },
  {
    id: "01996000-0000-7000-8000-000000000004",
    name: "Paris",
    latitude: 49.009722,
    longitude: 2.547778,
    stock: 694,
  },
  {
    id: "01996000-0000-7000-8000-000000000005",
    name: "Warsaw",
    latitude: 52.165833,
    longitude: 20.967222,
    stock: 245,
  },
  {
    id: "01996000-0000-7000-8000-000000000006",
    name: "Hong Kong",
    latitude: 22.308889,
    longitude: 113.914444,
    stock: 419,
  },
];

export const TOTAL_STOCK = WAREHOUSES.reduce((sum, { stock }) => sum + stock, 0); // 2556

export function warehouse(name: string): Warehouse {
  const found = WAREHOUSES.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`No warehouse ${name}`);
  }
  return found;
}

/** Exactly the Paris warehouse coordinates: zero shipping distance. */
export const AT_PARIS = { latitude: 49.009722, longitude: 2.547778 } as const;
/** Manhattan: New York is nearest, a short non-zero distance. */
export const MANHATTAN = { latitude: 40.7128, longitude: -74.006 } as const;
/** South of New Zealand: every warehouse is thousands of kilometres away. */
export const FAR_AWAY = { latitude: -45, longitude: 170 } as const;

/** core MAX_QUANTITY: floor(9 999 999 999.99 / 150). */
export const MAX_QUANTITY = 66_666_666;

// ---------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------

/** Mean Earth radius used for the great-circle distance (IUGG R1, km). */
const EARTH_RADIUS_KM = 6371.0088;

export function greatCircleKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLon = rad(to.longitude - from.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** An exact decimal n / 10^scale from a JavaScript number's shortest string. */
function exactDecimal(value: number): { n: bigint; scale: number } {
  const [mantissa = "0", exponentText = "0"] = String(value).toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole = "0", fraction = ""] = mantissa.split(".");
  let n = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    n *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { n, scale };
}

function formatCents(cents: bigint): string {
  const text = cents.toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** Discount percentage for a quantity (PRD tiers). */
export function discountPercent(quantity: number): number {
  if (quantity >= 250) return 20;
  if (quantity >= 100) return 15;
  if (quantity >= 50) return 10;
  if (quantity >= 25) return 5;
  return 0;
}

export interface Merchandise {
  merchandiseSubtotal: string;
  discountRate: string;
  discountAmount: string;
  discountedMerchandiseTotal: string;
}

export function merchandiseFor(quantity: number): Merchandise & { discountedCents: bigint } {
  const percent = BigInt(discountPercent(quantity));
  const subtotal = BigInt(quantity) * 15_000n;
  const discount = (subtotal * percent) / 100n; // exact: 150 * percent cents per unit
  const discounted = subtotal - discount;
  return {
    merchandiseSubtotal: formatCents(subtotal),
    discountRate: `0.${percent.toString().padStart(2, "0")}`,
    discountAmount: formatCents(discount),
    discountedMerchandiseTotal: formatCents(discounted),
    discountedCents: discounted,
  };
}

/** Combined shipping, summed exactly and rounded once half-up to cents. */
export function shippingCents(allocations: readonly { quantity: number; distanceKm: number }[]) {
  const parts = allocations.map(({ quantity, distanceKm }) => ({
    quantity,
    ...exactDecimal(distanceKm),
  }));
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  // 0.365 kg x 0.01 $/kg/km = 365 / 10^5 $ per unit-km.
  const numerator = parts.reduce(
    (sum, part) => sum + BigInt(part.quantity) * 365n * part.n * 10n ** BigInt(scale - part.scale),
    0n,
  );
  const denominator = 10n ** BigInt(5 + scale);
  // dollars = numerator / denominator; cents rounded half-up.
  return (numerator * 200n + denominator) / (2n * denominator);
}

export interface PlannedAllocation {
  warehouseId: string;
  quantity: number;
  distanceKm: number;
}

/** Nearest-first allocation, ties by warehouse ID; null when stock is short. */
export function allocate(
  quantity: number,
  destination: { latitude: number; longitude: number },
  stock: readonly Warehouse[] = WAREHOUSES,
): PlannedAllocation[] | null {
  if (stock.reduce((sum, w) => sum + w.stock, 0) < quantity) {
    return null;
  }
  const ranked = stock
    .filter((w) => w.stock > 0)
    .map((w) => ({ w, distanceKm: greatCircleKm(w, destination) }))
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.w.id < b.w.id ? -1 : 1));
  const plan: PlannedAllocation[] = [];
  let remaining = quantity;
  for (const { w, distanceKm } of ranked) {
    if (remaining === 0) break;
    const take = Math.min(remaining, w.stock);
    plan.push({ warehouseId: w.id, quantity: take, distanceKm });
    remaining -= take;
  }
  return plan;
}

/**
 * The expected `/api/v1/orders/verify` body for a request against the given stock.
 * Distances are matched to 1e-6 km; amounts are exact strings.
 */
export function expectedEstimate(
  quantity: number,
  destination: { latitude: number; longitude: number },
  stock: readonly Warehouse[] = WAREHOUSES,
): Record<string, unknown> {
  const { discountedCents, ...merchandise } = merchandiseFor(quantity);
  const plan = allocate(quantity, destination, stock);
  if (plan === null) {
    return {
      valid: false,
      reason: "INSUFFICIENT_STOCK",
      quantity,
      destination: { latitude: destination.latitude, longitude: destination.longitude },
      ...merchandise,
      shippingCost: null,
      orderTotal: null,
      allocations: [],
    };
  }
  const shipping = shippingCents(plan);
  // shipping <= 0.15 x discounted  <=>  100 x shipping <= 15 x discounted
  const withinLimit = shipping * 100n <= discountedCents * 15n;
  return {
    valid: withinLimit,
    reason: withinLimit ? null : "SHIPPING_EXCEEDS_LIMIT",
    quantity,
    destination: { latitude: destination.latitude, longitude: destination.longitude },
    ...merchandise,
    shippingCost: formatCents(shipping),
    orderTotal: formatCents(discountedCents + shipping),
    allocations: plan.map(({ warehouseId, quantity: units, distanceKm }) => ({
      warehouseId,
      quantity: units,
      distanceKm: expect.closeTo(distanceKm, 6),
    })),
  };
}

export const ORDER_NUMBER = /^SO-[0-9A-HJKMNP-TV-Z]{12}$/;

/** The exact key set of an accepted Order response (no internal id). */
export const ORDER_KEYS = [
  "allocations",
  "destination",
  "discountAmount",
  "discountRate",
  "discountedMerchandiseTotal",
  "merchandiseSubtotal",
  "orderNumber",
  "orderTotal",
  "quantity",
  "shippingCost",
  "submissionId",
  "unitPrice",
];

/** The expected 201 body for an accepted submission (orderNumber by pattern). */
export function expectedOrder(
  submissionId: string,
  quantity: number,
  destination: { latitude: number; longitude: number },
  stock: readonly Warehouse[] = WAREHOUSES,
): Record<string, unknown> {
  const estimate = expectedEstimate(quantity, destination, stock);
  if (estimate.valid !== true) {
    throw new Error(`Oracle: ${String(estimate.reason)} for ${quantity} units`);
  }
  return {
    orderNumber: expect.stringMatching(ORDER_NUMBER),
    submissionId,
    quantity,
    destination: estimate.destination,
    unitPrice: "150.00",
    merchandiseSubtotal: estimate.merchandiseSubtotal,
    discountRate: estimate.discountRate,
    discountAmount: estimate.discountAmount,
    discountedMerchandiseTotal: estimate.discountedMerchandiseTotal,
    shippingCost: estimate.shippingCost,
    orderTotal: estimate.orderTotal,
    allocations: (estimate.allocations as PlannedAllocation[]).map(
      ({ warehouseId, quantity: units }) => ({
        warehouseId,
        quantity: units,
      }),
    ),
  };
}

/** Stock remaining after deducting accepted allocations, for follow-up oracles. */
export function afterDeducting(
  stock: readonly Warehouse[],
  allocations: readonly { warehouseId: string; quantity: number }[],
): Warehouse[] {
  return stock.map((w) => {
    const taken = allocations
      .filter((a) => a.warehouseId === w.id)
      .reduce((sum, a) => sum + a.quantity, 0);
    return { ...w, stock: w.stock - taken };
  });
}
