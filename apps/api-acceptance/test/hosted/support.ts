/**
 * QA support for the hosted acceptance suite: the deployment under test, a
 * runtime reading of its inventory, the raw-text checks for decimal
 * serialization, and the served OpenAPI document compiled for conformance.
 *
 * Expected amounts still come from this app's own QA oracle
 * (#test/support/oracle.ts), written from the PRD and shared with the CI
 * acceptance suite. The PRD's `WAREHOUSES` constant (#test/support/prd.ts)
 * carries *seed* stock, which the hosted deployment left behind long ago, so
 * every oracle call here is handed a runtime reading instead.
 *
 * Nothing here touches the database-backed support modules; see the note in
 * ./acceptance.hosted.test.ts on why this suite does not use external mode.
 *
 * ## Reading the inventory without touching it
 *
 * The hosted demonstration is shared, finite and never replenished
 * (packages/persistence/src/seed.ts: "A rerun never replenishes consumed
 * stock"), and issue #33 forbids resetting it. Nothing here may therefore
 * assume, hardcode or restore a stock level. Everything is derived at runtime
 * through `POST /api/v1/orders/verify`, which stores nothing, reserves nothing
 * and consumes nothing:
 *
 * - A quantity above the available total is reported as `INSUFFICIENT_STOCK`,
 *   so an exponential probe followed by a bisection finds the exact total in
 *   about twenty-five round trips.
 * - One verification for exactly that total, destined for a warehouse, must
 *   allocate every warehouse's whole remaining stock, so its `allocations` are
 *   the per-warehouse breakdown.
 *
 * A derived reading is cached, because deriving it is the expensive part. A
 * cached reading is reconfirmed in two requests (its total is still
 * satisfiable, one more unit is not) and falls back to a full derivation when
 * the deployment has moved.
 *
 * ## Tolerating a shared deployment
 *
 * Other clients (an evaluator, a concurrency probe) may consume stock between
 * any two requests. {@link stableRead} therefore brackets a read-only
 * interaction with two inventory readings and retries it until both agree, so
 * an assertion against the oracle is only ever made over a window in which the
 * inventory demonstrably did not move. When no stable window can be obtained
 * the helper fails loudly rather than weakening the assertion.
 *
 * @module
 */

import SwaggerParser from "@apidevtools/swagger-parser";
import { expect } from "@playwright/test";
import addFormatsModule from "ajv-formats";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { OpenAPI } from "openapi-types";

import { type ApiUnderTest, type HttpResult, get, postJson } from "#test/support/http";
import { afterDeducting } from "#test/support/oracle";
import { AT_PARIS, MAX_QUANTITY, WAREHOUSES, type Warehouse } from "#test/support/prd";

// ajv-formats is CommonJS; its default export arrives wrapped under ESM.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as typeof addFormatsModule;

export const VERIFY = "/api/v1/orders/verify";
export const SUBMIT = "/api/v1/orders";
export const HEALTH = "/health";

// ---------------------------------------------------------------------------
// The deployment under test
// ---------------------------------------------------------------------------

/**
 * The deployed base URL.
 *
 * Its own variable on purpose. `API_BASE_URL`, which this app reads in
 * #test/support/environment.ts, additionally means "migrate, seed and wipe
 * `DATABASE_TEST_URL`"; reusing it would let that machinery be aimed at the
 * hosted deployment by accident. Nothing in this suite reads it.
 *
 * It follows the rule the rest of the app follows for its own variables
 * (#test/support/environment.ts): a missing or unusable value fails the run
 * instead of quietly passing it, because docs/acceptance-evidence.md counts a
 * missing check as missing, never as a pass.
 */
export function requireHostedBaseUrl(): string {
  const configured = process.env.HOSTED_BASE_URL;
  if (configured === undefined || configured.trim() === "") {
    throw new Error(
      "HOSTED_BASE_URL must point at the deployed API, for example https://scos-api.example.workers.dev",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`HOSTED_BASE_URL is not an absolute URL: ${configured}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`HOSTED_BASE_URL must be an http(s) URL: ${configured}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`HOSTED_BASE_URL must carry no query or fragment: ${configured}`);
  }
  // `request` appends an absolute path, so drop any trailing slash.
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * The deployment as an {@link ApiUnderTest}, so `request`, `get`, `postJson`,
 * `expectJson` and `expectErrorEnvelope` from #test/support/http are reused
 * unchanged. That interface is only a base URL, so there is nothing here to
 * start or stop: the server is not ours.
 */
export function hostedApi(): ApiUnderTest {
  return { baseUrl: requireHostedBaseUrl() };
}

/**
 * One identifier for this whole run, so a submissionId is fresh between runs
 * but **stable within one** — including across a worker that Playwright starts
 * for a retry, which is a new process that would otherwise mint a new id and
 * so buy a second Order out of a finite, never-replenished inventory.
 * ../../playwright.config.ts seeds it in the main process; every worker
 * inherits it through the environment.
 */
const RUN_ID = (() => {
  const seeded = process.env.SCOS_HOSTED_RUN_ID;
  if (seeded === undefined || seeded === "") {
    // Never fall back to a fresh id. ../../playwright.config.ts always seeds
    // this, so an empty value means the suite is running some other way — and
    // minting one here is the single path that could submit a second Order and
    // spend another unit of an inventory that is never replenished. Fail
    // instead, loudly, before any request is made.
    throw new Error(
      "SCOS_HOSTED_RUN_ID is not set. Run this suite through its Playwright " +
        "config (pnpm --filter @scos/api-acceptance run test:hosted), which seeds it.",
    );
  }
  return seeded;
})();

/**
 * A submissionId no earlier run can have used, so re-running this suite never
 * collides with its own history. Only a scenario that deliberately tests replay
 * or conflict reuses one — and a retry of this run reuses the same one, which
 * makes it a replay rather than a second Order.
 */
export function freshSubmissionId(label: string): string {
  return `qa-hosted-${label}-${RUN_ID}`;
}

// ---------------------------------------------------------------------------
// Inventory, derived at runtime
// ---------------------------------------------------------------------------

interface EstimateBody {
  readonly reason: string | null;
  readonly allocations: readonly { warehouseId: string; quantity: number }[];
}

/** Verification is free: it stores nothing and consumes no stock. */
async function estimateAt(api: ApiUnderTest, quantity: number): Promise<EstimateBody> {
  const response = await postJson(api, VERIFY, { quantity, ...AT_PARIS });
  expect(response.status, response.text).toBe(200);
  return response.json() as EstimateBody;
}

async function exceedsStock(api: ApiUnderTest, quantity: number): Promise<boolean> {
  return (await estimateAt(api, quantity)).reason === "INSUFFICIENT_STOCK";
}

export function totalStock(stock: readonly Warehouse[]): number {
  return stock.reduce((sum, { stock: units }) => sum + units, 0);
}

function sameStock(left: readonly Warehouse[], right: readonly Warehouse[]): boolean {
  return left.length === right.length && left.every((w, index) => w.stock === right[index]?.stock);
}

/**
 * The per-warehouse stock behind an estimate for exactly `total` units, or null
 * when the estimate does not account for all of them (the inventory moved
 * between the two requests, so the reading is not trustworthy).
 */
function breakdown(estimate: EstimateBody, total: number): Warehouse[] | null {
  if (estimate.reason === "INSUFFICIENT_STOCK") {
    return null;
  }
  const units = new Map<string, number>();
  for (const { warehouseId, quantity } of estimate.allocations) {
    units.set(warehouseId, (units.get(warehouseId) ?? 0) + quantity);
  }
  if ([...units.values()].reduce((sum, quantity) => sum + quantity, 0) !== total) {
    return null;
  }
  const known = new Set(WAREHOUSES.map(({ id }) => id));
  for (const warehouseId of units.keys()) {
    expect(
      known.has(warehouseId),
      `the deployment allocated unknown warehouse ${warehouseId}`,
    ).toBe(true);
  }
  return WAREHOUSES.map((w) => ({ ...w, stock: units.get(w.id) ?? 0 }));
}

/** Exponential probe, then bisection, then one breakdown request. */
async function deriveStock(api: ApiUnderTest): Promise<Warehouse[]> {
  let available = 0;
  let exceeded = MAX_QUANTITY + 1;
  for (let probe = 1; probe <= MAX_QUANTITY; probe *= 2) {
    if (await exceedsStock(api, probe)) {
      exceeded = probe;
      break;
    }
    available = probe;
  }
  while (exceeded - available > 1) {
    const middle = available + Math.floor((exceeded - available) / 2);
    if (await exceedsStock(api, middle)) {
      exceeded = middle;
    } else {
      available = middle;
    }
  }
  expect(available, "the hosted deployment has no stock left to demonstrate with").toBeGreaterThan(
    0,
  );
  const reading = breakdown(await estimateAt(api, available), available);
  if (reading === null) {
    throw new Error(
      `Could not read the hosted inventory: ${available} units did not allocate cleanly`,
    );
  }
  return reading;
}

/** Two requests that either reconfirm a cached reading exactly or reject it. */
async function reconfirmStock(
  api: ApiUnderTest,
  previous: readonly Warehouse[],
): Promise<Warehouse[] | null> {
  const total = totalStock(previous);
  if (total === 0) {
    return null;
  }
  const reading = breakdown(await estimateAt(api, total), total);
  if (reading === null || !(await exceedsStock(api, total + 1))) {
    return null;
  }
  return reading;
}

let cachedStock: Warehouse[] | null = null;

/** The deployment's current per-warehouse stock. Consumes none of it. */
export async function readStock(api: ApiUnderTest): Promise<Warehouse[]> {
  if (cachedStock !== null) {
    const reconfirmed = await reconfirmStock(api, cachedStock);
    if (reconfirmed !== null) {
      cachedStock = reconfirmed;
      return reconfirmed;
    }
  }
  cachedStock = await deriveStock(api);
  return cachedStock;
}

/**
 * Keeps the cached reading current after this suite's own accepted Order, so
 * the next reading costs two requests rather than a full derivation.
 */
export function applyAcceptedOrder(
  allocations: readonly { warehouseId: string; quantity: number }[],
): void {
  if (cachedStock !== null) {
    cachedStock = afterDeducting(cachedStock, allocations);
  }
}

/** Attempts at a window in which the shared inventory demonstrably held still. */
const STABLE_ATTEMPTS = 4;

export interface StableReading<T> {
  /** The inventory, identical before and after `read` ran. */
  readonly stock: readonly Warehouse[];
  readonly value: T;
}

/**
 * Runs a read-only interaction between two inventory readings and returns it
 * only once both readings agree, retrying while another client is consuming
 * stock. `read` must therefore be safe to repeat: a verification, a rejected
 * submission, a malformed request or a replay of an already accepted
 * submissionId. It must not assert, so that a moved inventory costs a retry
 * rather than a misleading failure.
 */
export async function stableRead<T>(
  api: ApiUnderTest,
  read: () => Promise<T>,
): Promise<StableReading<T>> {
  for (let attempt = 1; attempt <= STABLE_ATTEMPTS; attempt += 1) {
    const before = await readStock(api);
    const value = await read();
    const after = await readStock(api);
    if (sameStock(before, after)) {
      return { stock: before, value };
    }
  }
  throw new Error(
    `Another client consumed hosted stock during all ${STABLE_ATTEMPTS} attempts, so no assertion could be made over a stable inventory. Re-run when the deployment is idle.`,
  );
}

// ---------------------------------------------------------------------------
// Decimal serialization, checked on the raw response text
// ---------------------------------------------------------------------------

/** The monetary fields of an estimate and of an accepted Order. */
export const MONEY_FIELDS = [
  "unitPrice",
  "merchandiseSubtotal",
  "discountAmount",
  "discountedMerchandiseTotal",
  "shippingCost",
  "orderTotal",
] as const;

const MONEY_TEXT = /^"\d{1,10}\.\d{2}"$/;
const DISCOUNT_RATE_TEXT = /^"(?:0\.\d{2}|1\.00)"$/;

/**
 * The raw JSON text of every `"field":` value in a body. Money and rates never
 * contain a separator, so the value ends at the next `,`, `}` or `]`.
 */
export function rawValues(text: string, field: string): string[] {
  return [...text.matchAll(new RegExp(`"${field}":([^,}\\]]*)`, "g"))].map(
    (match) => match[1] as string,
  );
}

export interface DecimalExpectation {
  /** Fields whose value may be the JSON literal `null` in this response. */
  readonly nullable?: readonly string[];
}

/**
 * Every named field is a JSON *string* of digits with exactly two fraction
 * digits (`discountRate` in its documented `0.nn`/`1.00` form). The check reads
 * the response text rather than the parsed object on purpose: `JSON.parse`
 * turns `1.5e3` and `1500.0` into numbers indistinguishable from a correctly
 * serialized amount, so a lost-precision regression would pass unnoticed.
 */
export function expectDecimalStrings(
  text: string,
  fields: readonly string[],
  { nullable = [] }: DecimalExpectation = {},
): void {
  for (const field of fields) {
    const values = rawValues(text, field);
    expect(values, `${field} is missing from ${text}`).not.toHaveLength(0);
    for (const value of values) {
      if (nullable.includes(field) && value === "null") {
        continue;
      }
      const pattern = field === "discountRate" ? DISCOUNT_RATE_TEXT : MONEY_TEXT;
      expect(value, `${field} in ${text}`).toMatch(pattern);
    }
  }
}

// ---------------------------------------------------------------------------
// The served OpenAPI document
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Follows `path` through nested objects, failing loudly if any step is missing. */
export function dig(value: unknown, ...path: string[]): JsonRecord {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      throw new Error(`The served document has no ${path.join(" > ")} (missing "${key}")`);
    }
    current = current[key];
  }
  if (!isRecord(current)) {
    throw new Error(`${path.join(" > ")} is not an object`);
  }
  return current;
}

export interface ServedSpec {
  /** Exactly what `GET /openapi.json` returned, parsed. */
  readonly raw: JsonRecord;
  /** A copy with every `$ref` resolved (swagger-parser). */
  readonly resolved: JsonRecord;
  compile(schema: JsonRecord): ValidateFunction;
}

/**
 * The document the deployment serves, dereferenced and compiled with Ajv's
 * JSON Schema 2020-12 dialect (the OpenAPI 3.1 dialect). Nothing is taken from
 * the Zod contracts in src: the hosted document is the black box under test.
 */
export async function loadServedSpec(api: ApiUnderTest): Promise<ServedSpec> {
  const response = await get(api, "/openapi.json");
  expect(response.status, response.text).toBe(200);
  const raw = response.json() as JsonRecord;
  const resolved = (await SwaggerParser.dereference(
    structuredClone(raw) as unknown as OpenAPI.Document,
  )) as unknown as JsonRecord;
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const cache = new Map<JsonRecord, ValidateFunction>();
  return {
    raw,
    resolved,
    compile(schema) {
      let validate = cache.get(schema);
      if (validate === undefined) {
        validate = ajv.compile(schema);
        cache.set(schema, validate);
      }
      return validate;
    },
  };
}

export type Method = "get" | "post";

export function operation(spec: ServedSpec, path: string, method: Method): JsonRecord {
  return dig(spec.resolved, "paths", path, method);
}

/** The HTTP methods an OpenAPI path item may carry. */
export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

/**
 * Asserts a real hosted response matches what the served document declares for
 * `method path` and the response's own status: the status is documented, the
 * body is JSON matching that status's schema, and every required response
 * header is present and matches its schema.
 */
export function expectConforms(
  spec: ServedSpec,
  path: string,
  method: Method,
  result: HttpResult,
): unknown {
  const responses = dig(operation(spec, path, method), "responses");
  const documented = responses[String(result.status)];
  expect(
    isRecord(documented),
    `${method.toUpperCase()} ${path} returned ${result.status}, which the document does not list (${Object.keys(responses).join(", ")}): ${result.text}`,
  ).toBe(true);
  const response = documented as JsonRecord;

  const content = dig(response, "content");
  expect(Object.keys(content)).toStrictEqual(["application/json"]);
  expect(result.contentType).toMatch(/^application\/json(\s*;\s*charset=utf-8)?$/i);

  const body = result.json();
  const validate = spec.compile(dig(content, "application/json", "schema"));
  const errors = () => JSON.stringify(validate.errors ?? [], null, 2);
  expect(validate(body), `${result.status} body ${result.text}\n${errors()}`).toBe(true);

  const headers = isRecord(response.headers) ? response.headers : {};
  for (const [name, header] of Object.entries(headers)) {
    if (!isRecord(header) || header.required !== true) {
      continue;
    }
    const value = result.headers.get(name);
    expect(value, `required header ${name}`).not.toBeNull();
    const headerSchema = dig(header, "schema");
    const typed =
      headerSchema.type === "integer" || headerSchema.type === "number" ? Number(value) : value;
    const validateHeader = spec.compile(headerSchema);
    expect(validateHeader(typed), `${name}: ${value}`).toBe(true);
  }
  return body;
}
