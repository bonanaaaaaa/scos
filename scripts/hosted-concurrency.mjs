/**
 * Concurrency, correctness and latency probe against the hosted deployment
 * (issue #33: "Devops verifies lock contention and correctness under
 * representative concurrent requests through Hyperdrive").
 *
 * What it does, in one run, at one concurrency level:
 *
 * 1. Reads the inventory, per warehouse, through `POST /api/v1/orders/verify`.
 *    Verification stores nothing and consumes nothing, so every reading here
 *    is free.
 * 2. Measures a read-only latency baseline: sequential verifications, then a
 *    concurrent burst of verifications at the same width as the submission
 *    burst. Verifications are single statements that take no row lock, so the
 *    concurrent verify burst is the control: it carries the same network,
 *    Worker and Hyperdrive cost as a submission burst without the warehouse
 *    row locks.
 * 3. Fires `--submissions` one-unit submissions in bursts of `--concurrency`,
 *    each with a fresh `crypto.randomUUID()` submissionId, and times every one.
 * 4. Reads the inventory again and asserts the two properties that matter:
 *    units accepted equals the stock actually consumed (no oversell and no
 *    lost update), and the per-warehouse consumption equals the accepted
 *    orders' own allocations.
 *
 * ## Stock is finite, shared and never replenished
 *
 * The demonstration's stock is seeded once and never restored
 * (`packages/persistence/src/seed.ts`), and #33 forbids resetting it. Every
 * accepted order permanently reduces it. This probe therefore submits one unit
 * at a time, never more than `--max-units` per run (a guard that must be raised
 * deliberately), reads the stock at runtime rather than assuming it, and
 * offers `--dry-run`, which measures latency with verifications only and
 * consumes nothing.
 *
 * ## What it cannot see
 *
 * Everything here is client-side: wall-clock timings from one machine over the
 * public internet, and response bodies. Origin connection counts, Hyperdrive
 * queueing and pool saturation are not observable from a client and are not
 * reported. The retries the API makes internally for a lock timeout or a
 * serialization failure (`55P03`, `40001`; `MAX_SUBMISSION_ATTEMPTS` = 3 in
 * `packages/core/src/application/submit-order.ts`) are invisible from outside
 * except as latency, or as a `503 SERVICE_UNAVAILABLE` with `Retry-After` when
 * every attempt failed.
 *
 * ## Structure
 *
 * Every side effect — the network, stdout, stderr — arrives through an
 * {@link createIo} seam that the tests replace, so importing this module runs
 * nothing and the test suite makes no request and consumes no stock. The entry
 * point at the bottom runs only when the file is executed directly.
 *
 * Usage:
 *
 *   node scripts/hosted-concurrency.mjs --dry-run
 *   node scripts/hosted-concurrency.mjs --concurrency 5 --submissions 5
 *   node scripts/hosted-concurrency.mjs --concurrency 15 --submissions 15 --max-units 15
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_BASE_URL = "https://scos-api.bonanaaaaaa-scos.workers.dev";

export const VERIFY_PATH = "/api/v1/orders/verify";
export const SUBMIT_PATH = "/api/v1/orders";
export const HEALTH_PATH = "/health";

/**
 * Exactly the Paris warehouse's coordinates, so shipping distance is zero and
 * a one-unit order is never rejected for exceeding the shipping limit. Every
 * submission still locks all six warehouse rows, so contention does not depend
 * on this choice.
 */
export const DESTINATION = { latitude: 49.009722, longitude: 2.547778 };

/** core's MAX_QUANTITY: the largest quantity the API will estimate. */
export const MAX_QUANTITY = 66_666_666;

/** Attempts at a stock reading before giving up, for a moving inventory. */
export const READING_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// The side-effect seam
// ---------------------------------------------------------------------------

/**
 * Everything this probe does to the outside world, in one injectable object:
 * the network, stdout, stderr, and the running count of verifications (which
 * consume no stock and are reported so a reader can see what a run cost).
 */
export function createIo({
  fetch = defaultFetch(),
  log = console.log,
  error = console.error,
} = {}) {
  return { fetch, log, error, verifications: 0 };
}

/**
 * The real network, unless we are under a test runner or in CI.
 *
 * This script's own suite (`scripts/hosted-concurrency.test.mjs`) lives under
 * the root Vitest project, so CI runs it on every push. Every test injects a
 * fake `fetch`, but that safety would rest on each future test remembering
 * to: one omission would let CI submit real orders against the live
 * deployment, whose stock is finite and never replenished. So a test that
 * forgets fails loudly here instead of silently spending the demonstration.
 * Pass an explicit `fetch` to {@link createIo} to reach the network on
 * purpose.
 */
function defaultFetch() {
  if (process.env.VITEST !== undefined || process.env.CI !== undefined) {
    return () => {
      throw new Error(
        "Refusing to use the real network under a test runner or CI: this probe " +
          "consumes finite hosted stock. Inject a fake fetch with createIo({ fetch }).",
      );
    };
  }
  return globalThis.fetch;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One timed request. A transport failure is returned as status 0, never
 * thrown: it is a finding, and {@link classify} counts it.
 */
export async function timedPost(io, baseUrl, path, body) {
  const startedAt = performance.now();
  try {
    const response = await io.fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      ms: performance.now() - startedAt,
      status: response.status,
      text,
      retryAfter: response.headers.get("retry-after"),
    };
  } catch (error) {
    return {
      ms: performance.now() - startedAt,
      status: 0,
      text: error instanceof Error ? error.message : String(error),
      retryAfter: null,
    };
  }
}

/** One timed GET, with the same never-throws contract as {@link timedPost}. */
export async function timedGet(io, baseUrl, path) {
  const startedAt = performance.now();
  try {
    const response = await io.fetch(`${baseUrl}${path}`);
    const text = await response.text();
    return { ms: performance.now() - startedAt, status: response.status, text, retryAfter: null };
  } catch (error) {
    return {
      ms: performance.now() - startedAt,
      status: 0,
      text: error instanceof Error ? error.message : String(error),
      retryAfter: null,
    };
  }
}

/** The parsed body, or null when the response was not JSON. */
export function parsed(result) {
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

/** A verification. Stores nothing, reserves nothing, consumes nothing. */
export async function verify(io, baseUrl, quantity) {
  const result = await timedPost(io, baseUrl, VERIFY_PATH, { quantity, ...DESTINATION });
  io.verifications += 1;
  if (result.status !== 200) {
    throw new Error(`verify(${quantity}) returned ${result.status}: ${result.text}`);
  }
  const body = parsed(result);
  if (body === null) {
    throw new Error(`verify(${quantity}) returned unparseable JSON: ${result.text}`);
  }
  return { ...result, body };
}

// ---------------------------------------------------------------------------
// Reading the inventory without touching it
// ---------------------------------------------------------------------------

/**
 * The exact number of units available, found by an exponential probe and a
 * bisection on `INSUFFICIENT_STOCK`. `hint` (the previous reading) is confirmed
 * in two requests when it still holds, which is the common case between two
 * bursts of this probe.
 */
export async function readTotal(io, baseUrl, hint) {
  if (hint !== undefined && hint > 0) {
    const stillFits = (await verify(io, baseUrl, hint)).body.reason !== "INSUFFICIENT_STOCK";
    const oneMoreDoesNot =
      (await verify(io, baseUrl, hint + 1)).body.reason === "INSUFFICIENT_STOCK";
    if (stillFits && oneMoreDoesNot) {
      return hint;
    }
  }

  let available = 0;
  let exceeded = MAX_QUANTITY + 1;
  for (let probe = 1; probe <= MAX_QUANTITY; probe *= 2) {
    if ((await verify(io, baseUrl, probe)).body.reason === "INSUFFICIENT_STOCK") {
      exceeded = probe;
      break;
    }
    available = probe;
  }
  while (exceeded - available > 1) {
    const middle = available + Math.floor((exceeded - available) / 2);
    if ((await verify(io, baseUrl, middle)).body.reason === "INSUFFICIENT_STOCK") {
      exceeded = middle;
    } else {
      available = middle;
    }
  }
  return available;
}

/**
 * Total and per-warehouse stock. One verification for exactly the total must
 * allocate every warehouse's whole remaining stock, so its allocations are the
 * breakdown; a sum that does not match means another client moved the
 * inventory between the two requests, and the reading is retried rather than
 * trusted.
 */
export async function readInventory(io, baseUrl, hint) {
  let candidate = hint;
  for (let attempt = 1; attempt <= READING_ATTEMPTS; attempt += 1) {
    const total = await readTotal(io, baseUrl, candidate);
    if (total === 0) {
      return { total: 0, perWarehouse: new Map() };
    }
    const estimate = await verify(io, baseUrl, total);
    const perWarehouse = new Map();
    for (const allocation of estimate.body.allocations ?? []) {
      perWarehouse.set(
        allocation.warehouseId,
        (perWarehouse.get(allocation.warehouseId) ?? 0) + allocation.quantity,
      );
    }
    const allocated = [...perWarehouse.values()].reduce((sum, units) => sum + units, 0);
    if (allocated === total) {
      return { total, perWarehouse };
    }
    candidate = undefined;
  }
  throw new Error(
    `Could not read the hosted inventory in ${READING_ATTEMPTS} attempts: another client is consuming stock. Re-run when the deployment is idle.`,
  );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over an ascending sample. */
export function percentile(ascending, p) {
  const rank = Math.max(1, Math.ceil((p / 100) * ascending.length));
  return ascending[rank - 1];
}

/** min/p50/p90/p99/max/mean/spread, or null for an empty sample. */
export function stats(samples) {
  if (samples.length === 0) {
    return null;
  }
  const ascending = [...samples].sort((a, b) => a - b);
  const sum = ascending.reduce((total, value) => total + value, 0);
  return {
    n: ascending.length,
    min: ascending[0],
    p50: percentile(ascending, 50),
    p90: percentile(ascending, 90),
    p99: percentile(ascending, 99),
    max: ascending[ascending.length - 1],
    mean: sum / ascending.length,
    spread: ascending[ascending.length - 1] - ascending[0],
  };
}

export function ms(value) {
  return `${value.toFixed(0)} ms`;
}

/**
 * The burst's own samples, ascending, with the step between neighbours. If
 * submissions serialize on the warehouse row locks, a burst's sorted latencies
 * rise in roughly equal steps, each step being one serialized transaction; a
 * burst that does not serialize has no such progression.
 */
export function reportSamples(io, label, samples) {
  if (samples.length === 0 || samples.length > 32) {
    return;
  }
  const ascending = [...samples].sort((a, b) => a - b);
  const steps = ascending.slice(1).map((value, index) => value - ascending[index]);
  io.log(`  ${label} ascending (ms): ${ascending.map((value) => value.toFixed(0)).join(", ")}`);
  if (steps.length > 0) {
    io.log(`  ${label} steps (ms):     ${steps.map((value) => value.toFixed(0)).join(", ")}`);
  }
}

export function reportLatency(io, label, summary) {
  if (summary === null) {
    io.log(`${label}: no samples`);
    return;
  }
  io.log(
    `${label} (n=${summary.n}): min ${ms(summary.min)} | p50 ${ms(summary.p50)} | p90 ${ms(summary.p90)} | p99 ${ms(summary.p99)} | max ${ms(summary.max)} | mean ${ms(summary.mean)} | spread ${ms(summary.spread)}`,
  );
}

// ---------------------------------------------------------------------------
// Bursts
// ---------------------------------------------------------------------------

/** Classifies one response the way #33 asks: by outcome, never retried away. */
export function classify(result) {
  if (result.status === 0) {
    return "transport error";
  }
  if (result.status >= 500) {
    return `${result.status} server error`;
  }
  if (result.status === 201) {
    return "201 accepted";
  }
  if (result.status === 409) {
    return "409 conflict";
  }
  if (result.status === 422) {
    return "422 rejected";
  }
  return `${result.status} other`;
}

/** `width` requests started together; each one's wall clock is its own. */
export function fireTogether(width, request) {
  return Promise.all(Array.from({ length: width }, (_unused, index) => request(index)));
}

/** One one-unit submission under a submissionId no other run can have used. */
export async function submitOne(io, baseUrl) {
  const submissionId = `hosted-probe-${randomUUID()}`;
  const result = await timedPost(io, baseUrl, SUBMIT_PATH, {
    submissionId,
    quantity: 1,
    ...DESTINATION,
  });
  return { ...result, submissionId, body: parsed(result) };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** `[value, count]` pairs, by value. */
export function counted(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Accepted orders' own allocations, aggregated per warehouse. */
export function allocatedPerWarehouse(accepted) {
  const units = new Map();
  for (const response of accepted) {
    for (const allocation of response.body?.allocations ?? []) {
      units.set(
        allocation.warehouseId,
        (units.get(allocation.warehouseId) ?? 0) + allocation.quantity,
      );
    }
  }
  return units;
}

/** Per-warehouse stock that actually disappeared between two readings. */
export function consumedPerWarehouse(before, after) {
  const consumed = new Map();
  for (const [warehouseId, units] of before.perWarehouse) {
    const remaining = after.perWarehouse.get(warehouseId) ?? 0;
    if (units - remaining !== 0) {
      consumed.set(warehouseId, units - remaining);
    }
  }
  return consumed;
}

export function sameCounts(left, right) {
  const ids = new Set([...left.keys(), ...right.keys()]);
  return [...ids].every((id) => (left.get(id) ?? 0) === (right.get(id) ?? 0));
}

/**
 * The correctness verdict, appended to `findings` and printed. This is the
 * function that certifies "no oversell and no lost update", so it must be able
 * to fail: a stock delta larger than the units accepted is an oversell (or
 * another client), a delta smaller than them is a lost update, and neither is
 * ever reported as a pass.
 */
export function reportCorrectness(io, findings, accepted, before, after) {
  const unitsAccepted = accepted.length;
  const delta = before.total - after.total;
  io.log("");
  io.log("Correctness under contention");
  io.log(`  stock before        ${before.total}`);
  io.log(`  stock after         ${after.total}`);
  io.log(`  stock consumed      ${delta}`);
  io.log(`  units accepted      ${unitsAccepted}`);

  if (delta === unitsAccepted) {
    io.log("  OK: accepted units == stock consumed (no oversell, no lost update)");
  } else {
    findings.push(
      delta > unitsAccepted
        ? `OVERSELL OR THIRD-PARTY CONSUMPTION: stock fell by ${delta} while ${unitsAccepted} units were accepted`
        : `LOST UPDATE: ${unitsAccepted} units were accepted while stock fell by only ${delta}`,
    );
  }

  const orderNumbers = new Set(accepted.map((response) => response.body?.orderNumber));
  if (orderNumbers.size === unitsAccepted) {
    io.log(`  OK: ${orderNumbers.size} distinct orderNumbers for ${unitsAccepted} orders`);
  } else {
    findings.push(
      `DUPLICATE ORDER NUMBERS: ${unitsAccepted} accepted orders carried ${orderNumbers.size} distinct orderNumbers`,
    );
  }

  const allocated = allocatedPerWarehouse(accepted);
  const consumed = consumedPerWarehouse(before, after);
  const show = (units) =>
    [...units.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, quantity]) => `${id.slice(-4)}:${quantity}`)
      .join(" ") || "(none)";
  io.log(`  allocated by orders ${show(allocated)}`);
  io.log(`  consumed by stock   ${show(consumed)}`);
  if (sameCounts(allocated, consumed)) {
    io.log("  OK: per-warehouse allocations match per-warehouse consumption");
  } else {
    findings.push(
      "ALLOCATION MISMATCH: the accepted orders' allocations do not match the per-warehouse stock consumption",
    );
  }
}

/** Runs one probe. Returns the process exit code: 0 when nothing was found. */
export async function main(options, io = createIo()) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const findings = [];
  const startedAt = new Date().toISOString();

  io.log(`Hosted concurrency probe  ${startedAt}`);
  io.log(`  target        ${baseUrl}`);
  io.log(`  concurrency   ${options.concurrency}`);
  io.log(
    `  submissions   ${options.dryRun ? "0 (dry run: verifications only, consumes nothing)" : options.submissions}`,
  );
  io.log(`  verify samples ${options.verifySamples}`);
  io.log(
    "  timings are client-side wall clock from this machine over the public internet; they include round-trip latency and are not a server-side benchmark",
  );

  const health = await timedGet(io, baseUrl, HEALTH_PATH);
  io.log(`  warm-up GET ${HEALTH_PATH}: ${health.status} in ${ms(health.ms)}`);

  // --- Read-only latency -----------------------------------------------------
  const sequential = [];
  for (let index = 0; index < options.verifySamples; index += 1) {
    sequential.push((await verify(io, baseUrl, 1)).ms);
  }
  io.log("");
  io.log("Latency, read-only (verify: one statement, no row lock, writes nothing)");
  reportLatency(io, "  sequential, concurrency 1  ", stats(sequential));

  const verifyBurst = await fireTogether(options.concurrency, () => verify(io, baseUrl, 1));
  const verifySamples = verifyBurst.map((result) => result.ms);
  reportLatency(io, `  concurrent burst, width ${options.concurrency}`, stats(verifySamples));
  reportSamples(io, "verify burst", verifySamples);

  if (options.dryRun) {
    io.log("");
    io.log(`Dry run: no submission was made. Verifications this run: ${io.verifications}.`);
    io.log("Stock consumed: 0 units.");
    return 0;
  }

  // --- The submission burst --------------------------------------------------
  const before = await readInventory(io, baseUrl, options.stockHint);
  if (before.total < options.submissions) {
    throw new Error(
      `Only ${before.total} units remain; refusing to submit ${options.submissions}.`,
    );
  }

  const responses = [];
  const bursts = Math.ceil(options.submissions / options.concurrency);
  for (let burst = 0; burst < bursts; burst += 1) {
    const width = Math.min(options.concurrency, options.submissions - responses.length);
    responses.push(...(await fireTogether(width, () => submitOne(io, baseUrl))));
  }

  const accepted = responses.filter((response) => response.status === 201);
  // The expected reading, confirmed in two requests when it holds and derived
  // from scratch when it does not — which is itself the oversell check.
  const after = await readInventory(io, baseUrl, before.total - accepted.length);

  // --- Report ----------------------------------------------------------------
  io.log("");
  io.log(`Submissions (1 unit each, fresh submissionId, ${bursts} burst(s))`);
  const submitSamples = responses.map((response) => response.ms);
  reportLatency(io, `  burst width ${options.concurrency}          `, stats(submitSamples));
  reportSamples(io, "submit burst", submitSamples);
  for (const [outcome, count] of counted(responses.map(classify))) {
    io.log(`  ${outcome}: ${count}`);
  }
  const retryAfter = responses.filter((response) => response.retryAfter !== null);
  io.log(
    `  responses carrying Retry-After (503 after every internal retry failed): ${retryAfter.length}`,
  );

  for (const response of responses) {
    if (response.status >= 500 || response.status === 0) {
      findings.push(`${classify(response)} for ${response.submissionId}: ${response.text}`);
    }
  }

  reportCorrectness(io, findings, accepted, before, after);

  io.log("");
  io.log(`Stock consumed by this run: ${accepted.length} unit(s).`);
  io.log(`Verifications this run (free): ${io.verifications}.`);

  if (findings.length === 0) {
    io.log("No finding.");
    return 0;
  }
  io.log("");
  io.log("FINDINGS");
  for (const finding of findings) {
    io.log(`  - ${finding}`);
  }
  return 1;
}

/**
 * The command line. `--max-units` is a deliberate guard on finite,
 * unreplenishable demonstration stock, not a tuning knob.
 */
export function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string", default: process.env.HOSTED_BASE_URL ?? DEFAULT_BASE_URL },
      concurrency: { type: "string", default: "1" },
      submissions: { type: "string", default: "1" },
      "verify-samples": { type: "string", default: "10" },
      "max-units": { type: "string", default: "15" },
      "stock-hint": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const integer = (name, raw) => {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`--${name} must be a positive integer, got ${raw}`);
    }
    return value;
  };

  const concurrency = integer("concurrency", values.concurrency);
  const submissions = integer("submissions", values.submissions);
  const maxUnits = integer("max-units", values["max-units"]);
  if (!values["dry-run"] && submissions > maxUnits) {
    throw new Error(
      `--submissions ${submissions} would consume more than --max-units ${maxUnits} units of finite, unreplenishable demonstration stock. Raise --max-units deliberately if that is intended.`,
    );
  }

  return {
    baseUrl: values["base-url"],
    concurrency,
    submissions,
    verifySamples: integer("verify-samples", values["verify-samples"]),
    dryRun: values["dry-run"],
    stockHint: values["stock-hint"] === undefined ? undefined : Number(values["stock-hint"]),
  };
}

/** Parses, runs, and turns any failure into an exit code and one message. */
export async function runCli(argv = process.argv.slice(2), io = createIo()) {
  try {
    return await main(readOptions(argv), io);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
