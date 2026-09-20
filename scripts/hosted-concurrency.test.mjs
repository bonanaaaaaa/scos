/**
 * Tests for the hosted concurrency probe.
 *
 * **No test here makes a network call or consumes stock.** Every request goes
 * through a fake `fetch` that models a deployment in memory, and every line of
 * output goes to a recording `log`. The probe's real target is a shared,
 * finite demonstration whose stock is never replenished, so exercising it from
 * a test suite would spend it permanently.
 */

import { expect, test } from "vitest";

import {
  DEFAULT_BASE_URL,
  HEALTH_PATH,
  SUBMIT_PATH,
  VERIFY_PATH,
  allocatedPerWarehouse,
  classify,
  consumedPerWarehouse,
  counted,
  createIo,
  fireTogether,
  main,
  ms,
  parsed,
  percentile,
  readInventory,
  readOptions,
  readTotal,
  reportCorrectness,
  reportLatency,
  reportSamples,
  runCli,
  sameCounts,
  stats,
  submitOne,
  timedGet,
  timedPost,
  verify,
} from "./hosted-concurrency.mjs";

const BASE = "https://example.test";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** An io whose network and output are captured, never performed. */
function recordingIo(fetch) {
  const lines = [];
  const errors = [];
  const io = createIo({
    fetch,
    log: (line) => lines.push(String(line)),
    error: (line) => errors.push(String(line)),
  });
  return { io, lines, errors, output: () => lines.join("\n") };
}

function response(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/**
 * A deployment in memory: verification allocates greedily and writes nothing,
 * submission takes one unit from the first warehouse that has any.
 */
function fakeDeployment({
  warehouses = [
    ["wh-0001", 3],
    ["wh-0002", 5],
  ],
  submit,
} = {}) {
  const stock = new Map(warehouses);
  const calls = { health: 0, verify: 0, submit: 0 };

  const total = () => [...stock.values()].reduce((sum, units) => sum + units, 0);

  const estimate = (quantity) => {
    if (quantity > total()) {
      return response(200, { valid: false, reason: "INSUFFICIENT_STOCK", allocations: [] });
    }
    const allocations = [];
    let left = quantity;
    for (const [warehouseId, units] of stock) {
      if (left === 0) {
        break;
      }
      const taken = Math.min(left, units);
      if (taken > 0) {
        allocations.push({ warehouseId, quantity: taken });
        left -= taken;
      }
    }
    return response(200, { valid: true, reason: null, allocations });
  };

  const accept = () => {
    for (const [warehouseId, units] of stock) {
      if (units > 0) {
        stock.set(warehouseId, units - 1);
        return response(201, {
          orderNumber: `SO-${String(calls.submit).padStart(12, "0")}`,
          allocations: [{ warehouseId, quantity: 1 }],
        });
      }
    }
    return response(422, { error: { code: "INSUFFICIENT_STOCK" } });
  };

  /** Every submission body the probe sent, so a test can assert what it asked for. */
  const submitted = [];

  const fetch = (url, init) => {
    const { pathname } = new URL(url);
    if (init === undefined) {
      calls.health += 1;
      return Promise.resolve(response(200, { status: "ok" }));
    }
    const body = JSON.parse(init.body);
    if (pathname === VERIFY_PATH) {
      calls.verify += 1;
      return Promise.resolve(estimate(body.quantity));
    }
    if (pathname === SUBMIT_PATH) {
      calls.submit += 1;
      submitted.push(body);
      const overridden = submit?.(calls.submit, stock);
      return Promise.resolve(overridden ?? accept());
    }
    throw new Error(`unexpected path ${pathname}`);
  };

  return { fetch, stock, calls, total, submitted };
}

function reading(entries) {
  const perWarehouse = new Map(entries);
  return {
    total: [...perWarehouse.values()].reduce((sum, units) => sum + units, 0),
    perWarehouse,
  };
}

function acceptedOrders(...orders) {
  return orders.map(([orderNumber, warehouseId]) => ({
    body: { orderNumber, allocations: [{ warehouseId, quantity: 1 }] },
  }));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test("percentile uses nearest rank and never falls below the first sample", () => {
  const ascending = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  expect(percentile(ascending, 50)).toBe(50);
  expect(percentile(ascending, 90)).toBe(90);
  expect(percentile(ascending, 99)).toBe(100);
  expect(percentile(ascending, 0)).toBe(10);
  expect(percentile([7], 99)).toBe(7);
});

test("stats summarises an unsorted sample and reports nothing for an empty one", () => {
  expect(stats([])).toBeNull();
  expect(stats([300, 100, 200])).toStrictEqual({
    n: 3,
    min: 100,
    p50: 200,
    p90: 300,
    p99: 300,
    max: 300,
    mean: 200,
    spread: 200,
  });
});

test("ms rounds to whole milliseconds", () => {
  expect(ms(0)).toBe("0 ms");
  expect(ms(123.4)).toBe("123 ms");
  expect(ms(123.6)).toBe("124 ms");
});

test("reportLatency prints the percentiles, or says there were no samples", () => {
  const { io, lines } = recordingIo();
  reportLatency(io, "label", null);
  expect(lines[0]).toBe("label: no samples");

  reportLatency(io, "burst", stats([100, 200, 300]));
  expect(lines[1]).toContain("(n=3)");
  expect(lines[1]).toContain("min 100 ms");
  expect(lines[1]).toContain("max 300 ms");
  expect(lines[1]).toContain("spread 200 ms");
});

test("reportSamples prints the ascending burst and the step between neighbours", () => {
  const { io, lines } = recordingIo();
  reportSamples(io, "submit burst", [300, 100, 200]);
  expect(lines).toStrictEqual([
    "  submit burst ascending (ms): 100, 200, 300",
    "  submit burst steps (ms):     100, 100",
  ]);
});

test("reportSamples prints no step line for one sample and nothing at all beyond 32", () => {
  const { io, lines } = recordingIo();
  reportSamples(io, "one", [42]);
  expect(lines).toStrictEqual(["  one ascending (ms): 42"]);

  reportSamples(io, "none", []);
  reportSamples(
    io,
    "huge",
    Array.from({ length: 33 }, (_unused, index) => index),
  );
  expect(lines).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Classification and aggregation
// ---------------------------------------------------------------------------

test("classify names every outcome #33 asks to be counted separately", () => {
  expect(classify({ status: 0 })).toBe("transport error");
  expect(classify({ status: 201 })).toBe("201 accepted");
  expect(classify({ status: 409 })).toBe("409 conflict");
  expect(classify({ status: 422 })).toBe("422 rejected");
  expect(classify({ status: 500 })).toBe("500 server error");
  expect(classify({ status: 503 })).toBe("503 server error");
  expect(classify({ status: 400 })).toBe("400 other");
});

test("counted tallies outcomes and orders them by name", () => {
  expect(counted(["b", "a", "b", "c", "b"])).toStrictEqual([
    ["a", 1],
    ["b", 3],
    ["c", 1],
  ]);
  expect(counted([])).toStrictEqual([]);
});

test("allocatedPerWarehouse sums the accepted orders' own allocations", () => {
  const accepted = [
    { body: { allocations: [{ warehouseId: "a", quantity: 1 }] } },
    { body: { allocations: [{ warehouseId: "a", quantity: 2 }] } },
    { body: { allocations: [{ warehouseId: "b", quantity: 3 }] } },
    { body: null },
    {},
  ];
  expect([...allocatedPerWarehouse(accepted)]).toStrictEqual([
    ["a", 3],
    ["b", 3],
  ]);
});

test("consumedPerWarehouse reports only warehouses whose stock moved", () => {
  const before = reading([
    ["a", 10],
    ["b", 5],
    ["c", 1],
  ]);
  const after = reading([
    ["a", 8],
    ["b", 5],
  ]);
  expect([...consumedPerWarehouse(before, after)]).toStrictEqual([
    ["a", 2],
    ["c", 1],
  ]);
});

test("sameCounts compares two tallies including keys only one of them has", () => {
  expect(sameCounts(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
  expect(sameCounts(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
  expect(sameCounts(new Map([["a", 1]]), new Map())).toBe(false);
  expect(sameCounts(new Map(), new Map())).toBe(true);
});

// ---------------------------------------------------------------------------
// The correctness verdict — it must be able to fail
// ---------------------------------------------------------------------------

test("reportCorrectness passes a run whose accepted units equal the stock consumed", () => {
  const findings = [];
  const { io, output } = recordingIo();
  reportCorrectness(
    io,
    findings,
    acceptedOrders(["SO-1", "wh-0001"], ["SO-2", "wh-0001"]),
    reading([["wh-0001", 10]]),
    reading([["wh-0001", 8]]),
  );
  expect(findings).toStrictEqual([]);
  expect(output()).toContain("OK: accepted units == stock consumed (no oversell, no lost update)");
  expect(output()).toContain("OK: 2 distinct orderNumbers for 2 orders");
  expect(output()).toContain("OK: per-warehouse allocations match per-warehouse consumption");
  expect(output()).toContain("allocated by orders 0001:2");
});

test("reportCorrectness detects an oversell: stock fell further than the units accepted", () => {
  const findings = [];
  const { io, output } = recordingIo();
  reportCorrectness(
    io,
    findings,
    acceptedOrders(["SO-1", "wh-0001"]),
    reading([["wh-0001", 10]]),
    reading([["wh-0001", 7]]),
  );
  expect(findings[0]).toMatch(/^OVERSELL OR THIRD-PARTY CONSUMPTION: stock fell by 3 while 1 /);
  expect(output()).not.toContain("no oversell");
});

test("reportCorrectness detects a lost update: more accepted than the stock consumed", () => {
  const findings = [];
  const { io, output } = recordingIo();
  reportCorrectness(
    io,
    findings,
    acceptedOrders(["SO-1", "wh-0001"], ["SO-2", "wh-0001"], ["SO-3", "wh-0001"]),
    reading([["wh-0001", 10]]),
    reading([["wh-0001", 9]]),
  );
  expect(findings).toContain("LOST UPDATE: 3 units were accepted while stock fell by only 1");
  expect(output()).not.toContain("no lost update");
});

test("reportCorrectness detects duplicate orderNumbers", () => {
  const findings = [];
  const { io } = recordingIo();
  reportCorrectness(
    io,
    findings,
    acceptedOrders(["SO-1", "wh-0001"], ["SO-1", "wh-0001"]),
    reading([["wh-0001", 10]]),
    reading([["wh-0001", 8]]),
  );
  expect(findings).toStrictEqual([
    "DUPLICATE ORDER NUMBERS: 2 accepted orders carried 1 distinct orderNumbers",
  ]);
});

test("reportCorrectness detects allocations that do not match what each warehouse lost", () => {
  const findings = [];
  const { io, output } = recordingIo();
  reportCorrectness(
    io,
    findings,
    acceptedOrders(["SO-1", "wh-0001"], ["SO-2", "wh-0001"]),
    reading([
      ["wh-0001", 10],
      ["wh-0002", 10],
    ]),
    reading([
      ["wh-0001", 9],
      ["wh-0002", 9],
    ]),
  );
  expect(findings).toStrictEqual([
    "ALLOCATION MISMATCH: the accepted orders' allocations do not match the per-warehouse stock consumption",
  ]);
  expect(output()).toContain("consumed by stock   0001:1 0002:1");
});

test("reportCorrectness prints (none) when nothing was accepted and nothing moved", () => {
  const findings = [];
  const { io, output } = recordingIo();
  reportCorrectness(io, findings, [], reading([["wh-0001", 10]]), reading([["wh-0001", 10]]));
  expect(findings).toStrictEqual([]);
  expect(output()).toContain("allocated by orders (none)");
  expect(output()).toContain("consumed by stock   (none)");
});

// ---------------------------------------------------------------------------
// HTTP, against the fake deployment only
// ---------------------------------------------------------------------------

test("timedPost returns the status, body, timing and Retry-After header", async () => {
  const { io } = recordingIo(() =>
    Promise.resolve(response(503, { error: "busy" }, { "retry-after": "1" })),
  );
  const result = await timedPost(io, BASE, SUBMIT_PATH, { quantity: 1 });
  expect(result.status).toBe(503);
  expect(result.retryAfter).toBe("1");
  expect(parsed(result)).toStrictEqual({ error: "busy" });
  expect(result.ms).toBeGreaterThanOrEqual(0);
});

test("timedPost reports a transport failure as status 0 rather than throwing", async () => {
  const { io } = recordingIo(() => Promise.reject(new Error("connection reset")));
  const result = await timedPost(io, BASE, SUBMIT_PATH, {});
  expect(result.status).toBe(0);
  expect(result.text).toBe("connection reset");
  expect(classify(result)).toBe("transport error");
});

test("timedPost stringifies a non-Error rejection", async () => {
  const { io } = recordingIo(() => Promise.reject("socket hang up"));
  expect((await timedPost(io, BASE, SUBMIT_PATH, {})).text).toBe("socket hang up");
});

test("timedGet reads a body, and reports a transport failure as status 0", async () => {
  const deployment = fakeDeployment();
  const { io } = recordingIo(deployment.fetch);
  const healthy = await timedGet(io, BASE, HEALTH_PATH);
  expect(healthy.status).toBe(200);
  expect(healthy.retryAfter).toBeNull();
  expect(deployment.calls.health).toBe(1);

  const { io: broken } = recordingIo(() => Promise.reject(new Error("dns failure")));
  const failed = await timedGet(broken, BASE, HEALTH_PATH);
  expect(failed.status).toBe(0);
  expect(failed.text).toBe("dns failure");

  const { io: odd } = recordingIo(() => Promise.reject(42));
  expect((await timedGet(odd, BASE, HEALTH_PATH)).text).toBe("42");
});

test("parsed returns null for a body that is not JSON", () => {
  expect(parsed({ text: "not json" })).toBeNull();
  expect(parsed({ text: '{"ok":true}' })).toStrictEqual({ ok: true });
});

test("verify counts itself and rejects a response that is not a 200 JSON estimate", async () => {
  const deployment = fakeDeployment();
  const { io } = recordingIo(deployment.fetch);
  const estimate = await verify(io, BASE, 1);
  expect(estimate.body.valid).toBe(true);
  expect(io.verifications).toBe(1);
  expect(deployment.total()).toBe(8);

  const { io: failing } = recordingIo(() => Promise.resolve(response(500, "boom")));
  await expect(verify(failing, BASE, 1)).rejects.toThrow(/verify\(1\) returned 500: boom/);

  const { io: garbled } = recordingIo(() => Promise.resolve(response(200, "<html>")));
  await expect(verify(garbled, BASE, 1)).rejects.toThrow(/unparseable JSON/);
});

// ---------------------------------------------------------------------------
// Reading the inventory
// ---------------------------------------------------------------------------

test("readTotal bisects to the exact number of available units", async () => {
  const deployment = fakeDeployment({
    warehouses: [
      ["wh-0001", 40],
      ["wh-0002", 53],
    ],
  });
  const { io } = recordingIo(deployment.fetch);
  expect(await readTotal(io, BASE, undefined)).toBe(93);
  expect(io.verifications).toBeGreaterThan(2);
  expect(deployment.total()).toBe(93);
});

test("readTotal confirms a still-valid hint in exactly two verifications", async () => {
  const deployment = fakeDeployment({ warehouses: [["wh-0001", 8]] });
  const { io } = recordingIo(deployment.fetch);
  expect(await readTotal(io, BASE, 8)).toBe(8);
  expect(io.verifications).toBe(2);
});

test("readTotal falls back to a full derivation when the hint is stale", async () => {
  const deployment = fakeDeployment({ warehouses: [["wh-0001", 8]] });
  const { io } = recordingIo(deployment.fetch);
  expect(await readTotal(io, BASE, 20)).toBe(8);
  expect(io.verifications).toBeGreaterThan(2);
});

test("readTotal reports zero when nothing is left", async () => {
  const deployment = fakeDeployment({ warehouses: [["wh-0001", 0]] });
  const { io } = recordingIo(deployment.fetch);
  expect(await readTotal(io, BASE, 0)).toBe(0);
});

test("readInventory returns the per-warehouse breakdown, and an empty one at zero", async () => {
  const deployment = fakeDeployment({
    warehouses: [
      ["wh-0001", 3],
      ["wh-0002", 5],
    ],
  });
  const { io } = recordingIo(deployment.fetch);
  const inventory = await readInventory(io, BASE, undefined);
  expect(inventory.total).toBe(8);
  expect([...inventory.perWarehouse]).toStrictEqual([
    ["wh-0001", 3],
    ["wh-0002", 5],
  ]);

  const empty = fakeDeployment({ warehouses: [["wh-0001", 0]] });
  const { io: emptyIo } = recordingIo(empty.fetch);
  expect(await readInventory(emptyIo, BASE, undefined)).toStrictEqual({
    total: 0,
    perWarehouse: new Map(),
  });
});

test("readInventory refuses a reading whose allocations do not account for the total", async () => {
  // A deployment whose breakdown is always short by one: the inventory moved
  // between the two requests, so the reading must not be trusted.
  const { io } = recordingIo((url, init) => {
    const quantity = JSON.parse(init.body).quantity;
    if (quantity > 8) {
      return Promise.resolve(
        response(200, { valid: false, reason: "INSUFFICIENT_STOCK", allocations: [] }),
      );
    }
    return Promise.resolve(
      response(200, {
        valid: true,
        reason: null,
        allocations: [{ warehouseId: "wh-0001", quantity: quantity - 1 }],
      }),
    );
  });
  await expect(readInventory(io, BASE, undefined)).rejects.toThrow(
    /Could not read the hosted inventory in 3 attempts/,
  );
});

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

test("submitOne sends one unit under a fresh submissionId every time", async () => {
  const deployment = fakeDeployment();
  const { io } = recordingIo(deployment.fetch);
  const first = await submitOne(io, BASE);
  const second = await submitOne(io, BASE);

  expect(first.status).toBe(201);
  expect(first.submissionId).toMatch(/^hosted-probe-[0-9a-f-]{36}$/);
  expect(second.submissionId).not.toBe(first.submissionId);
  expect(first.body.orderNumber).not.toBe(second.body.orderNumber);
  expect(deployment.total()).toBe(6);
});

test("fireTogether starts the requested width and passes each its index", async () => {
  const started = [];
  const results = await fireTogether(3, (index) => {
    started.push(index);
    return Promise.resolve(index * 2);
  });
  expect(started).toStrictEqual([0, 1, 2]);
  expect(results).toStrictEqual([0, 2, 4]);
  expect(await fireTogether(0, () => Promise.reject(new Error("never")))).toStrictEqual([]);
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test("readOptions defaults to one sequential submission against the hosted deployment", () => {
  const previous = process.env.HOSTED_BASE_URL;
  delete process.env.HOSTED_BASE_URL;
  try {
    expect(readOptions([])).toStrictEqual({
      baseUrl: DEFAULT_BASE_URL,
      concurrency: 1,
      submissions: 1,
      verifySamples: 10,
      dryRun: false,
      stockHint: undefined,
    });
  } finally {
    if (previous !== undefined) {
      process.env.HOSTED_BASE_URL = previous;
    }
  }
});

test("readOptions takes HOSTED_BASE_URL when no --base-url is given", () => {
  const previous = process.env.HOSTED_BASE_URL;
  process.env.HOSTED_BASE_URL = BASE;
  try {
    expect(readOptions([]).baseUrl).toBe(BASE);
  } finally {
    if (previous === undefined) {
      delete process.env.HOSTED_BASE_URL;
    } else {
      process.env.HOSTED_BASE_URL = previous;
    }
  }
});

test("readOptions reads every flag", () => {
  expect(
    readOptions([
      "--base-url",
      BASE,
      "--concurrency",
      "15",
      "--submissions",
      "15",
      "--verify-samples",
      "12",
      "--max-units",
      "15",
      "--stock-hint",
      "2360",
    ]),
  ).toStrictEqual({
    baseUrl: BASE,
    concurrency: 15,
    submissions: 15,
    verifySamples: 12,
    dryRun: false,
    stockHint: 2360,
  });
});

test("readOptions refuses a run that would consume more than --max-units", () => {
  expect(() => readOptions(["--concurrency", "20", "--submissions", "20"])).toThrow(
    /would consume more than --max-units 15 units of finite, unreplenishable demonstration stock/,
  );
  expect(() => readOptions(["--submissions", "20", "--max-units", "20"])).not.toThrow();
});

test("a dry run is exempt from --max-units, because it consumes nothing", () => {
  const options = readOptions(["--dry-run", "--submissions", "500"]);
  expect(options.dryRun).toBe(true);
  expect(options.submissions).toBe(500);
});

test("readOptions rejects values that are not positive integers", () => {
  expect(() => readOptions(["--concurrency", "0"])).toThrow(
    /--concurrency must be a positive integer, got 0/,
  );
  expect(() => readOptions(["--submissions=-1"])).toThrow(/--submissions must be/);
  expect(() => readOptions(["--verify-samples", "2.5"])).toThrow(/--verify-samples must be/);
  expect(() => readOptions(["--max-units", "many"])).toThrow(/--max-units must be/);
});

// ---------------------------------------------------------------------------
// End to end, against the fake deployment
// ---------------------------------------------------------------------------

test("a dry run measures latency, submits nothing and says so", async () => {
  const deployment = fakeDeployment();
  const { io, output } = recordingIo(deployment.fetch);
  const code = await main(
    readOptions([
      "--base-url",
      `${BASE}/`,
      "--dry-run",
      "--concurrency",
      "3",
      "--verify-samples",
      "4",
    ]),
    io,
  );

  expect(code).toBe(0);
  expect(deployment.calls.submit).toBe(0);
  expect(deployment.total()).toBe(8);
  expect(output()).toContain("Stock consumed: 0 units.");
  expect(output()).toContain("0 (dry run: verifications only, consumes nothing)");
  expect(output()).toContain(
    `Dry run: no submission was made. Verifications this run: ${io.verifications}.`,
  );
  expect(output()).toContain(`  target        ${BASE}`);
  expect(output()).not.toContain("Correctness under contention");
});

test("a healthy burst consumes exactly what it accepted and reports no finding", async () => {
  const deployment = fakeDeployment({
    warehouses: [
      ["wh-0001", 4],
      ["wh-0002", 6],
    ],
  });
  const { io, output } = recordingIo(deployment.fetch);
  const code = await main(
    readOptions([
      "--base-url",
      BASE,
      "--concurrency",
      "3",
      "--submissions",
      "6",
      "--verify-samples",
      "2",
    ]),
    io,
  );

  expect(code).toBe(0);
  expect(deployment.calls.submit).toBe(6);
  expect(deployment.total()).toBe(4);
  expect(output()).toContain("Submissions (1 unit each, fresh submissionId, 2 burst(s))");
  expect(output()).toContain("  201 accepted: 6");
  expect(output()).toContain("  stock before        10");
  expect(output()).toContain("  stock after         4");
  expect(output()).toContain("OK: accepted units == stock consumed (no oversell, no lost update)");
  expect(output()).toContain("Stock consumed by this run: 6 unit(s).");
  expect(output()).toContain("No finding.");
});

test("a 503 is reported as a finding and never retried away", async () => {
  const deployment = fakeDeployment({
    submit: (call) =>
      call === 2
        ? response(503, { error: { code: "SERVICE_UNAVAILABLE" } }, { "retry-after": "1" })
        : undefined,
  });
  const { io, output } = recordingIo(deployment.fetch);
  const code = await main(
    readOptions([
      "--base-url",
      BASE,
      "--concurrency",
      "3",
      "--submissions",
      "3",
      "--verify-samples",
      "1",
    ]),
    io,
  );

  expect(code).toBe(1);
  expect(output()).toContain("  503 server error: 1");
  expect(output()).toContain("  201 accepted: 2");
  expect(output()).toContain(
    "  responses carrying Retry-After (503 after every internal retry failed): 1",
  );
  expect(output()).toContain("FINDINGS");
  expect(output()).toContain("503 server error for hosted-probe-");
  // The two that were accepted still balance against the stock they consumed.
  expect(output()).toContain("OK: accepted units == stock consumed (no oversell, no lost update)");
});

test("a transport failure during a burst is a finding, not a retry", async () => {
  let submissions = 0;
  const deployment = fakeDeployment();
  const { io, output } = recordingIo((url, init) => {
    if (init !== undefined && new URL(url).pathname === SUBMIT_PATH) {
      submissions += 1;
      if (submissions === 1) {
        return Promise.reject(new Error("socket hang up"));
      }
    }
    return deployment.fetch(url, init);
  });

  const code = await main(
    readOptions([
      "--base-url",
      BASE,
      "--concurrency",
      "2",
      "--submissions",
      "2",
      "--verify-samples",
      "1",
    ]),
    io,
  );

  expect(code).toBe(1);
  expect(output()).toContain("  transport error: 1");
  expect(output()).toContain("transport error for hosted-probe-");
  expect(output()).toContain("socket hang up");
});

test("main refuses to submit more units than the deployment has left", async () => {
  const deployment = fakeDeployment({ warehouses: [["wh-0001", 2]] });
  const { io } = recordingIo(deployment.fetch);
  await expect(
    main(
      readOptions([
        "--base-url",
        BASE,
        "--submissions",
        "5",
        "--concurrency",
        "5",
        "--verify-samples",
        "1",
      ]),
      io,
    ),
  ).rejects.toThrow("Only 2 units remain; refusing to submit 5.");
  expect(deployment.calls.submit).toBe(0);
});

test("runCli runs a dry run and turns a bad option into one message and exit 1", async () => {
  const deployment = fakeDeployment();
  const { io, output } = recordingIo(deployment.fetch);
  expect(
    await runCli(
      ["--base-url", BASE, "--dry-run", "--concurrency", "2", "--verify-samples", "1"],
      io,
    ),
  ).toBe(0);
  expect(output()).toContain("Stock consumed: 0 units.");

  const { io: bad, errors } = recordingIo(deployment.fetch);
  expect(await runCli(["--concurrency", "nope"], bad)).toBe(1);
  expect(errors).toStrictEqual(["--concurrency must be a positive integer, got nope"]);
  expect(deployment.calls.submit).toBe(0);
});

test("every submission asks for exactly one unit, whatever the burst shape", async () => {
  // `quantity: 1` is the whole reason --max-units is a unit budget rather than
  // a request budget. If a submission ever asked for more, every stock figure
  // in docs/hosted-demonstration.md would understate what a run costs, and the
  // budget would silently stop bounding the damage.
  const deployment = fakeDeployment({ warehouses: [["wh-0001", 9]] });
  const { io } = recordingIo(deployment.fetch);

  const code = await main(
    readOptions(["--base-url", BASE, "--concurrency", "2", "--submissions", "4"]),
    io,
  );

  expect(code).toBe(0);
  expect(deployment.submitted).toHaveLength(4);
  for (const body of deployment.submitted) {
    expect(body.quantity).toBe(1);
  }
  // Distinct submissionIds, or a replay would be deduplicated into one Order.
  expect(new Set(deployment.submitted.map((body) => body.submissionId)).size).toBe(4);
  expect(deployment.total()).toBe(5);
});

test("a burst never exceeds the remaining submissions when the two do not divide", async () => {
  // 7 submissions at width 3 is 3 + 3 + 1, not 3 + 3 + 3. Without the clamp the
  // last burst would overshoot by 2 units, past --max-units, and those units do
  // not come back.
  const deployment = fakeDeployment({ warehouses: [["wh-0001", 20]] });
  const { io, output } = recordingIo(deployment.fetch);

  const code = await main(
    readOptions([
      "--base-url",
      BASE,
      "--concurrency",
      "3",
      "--submissions",
      "7",
      "--max-units",
      "7",
    ]),
    io,
  );

  expect(code).toBe(0);
  expect(deployment.calls.submit).toBe(7);
  expect(deployment.submitted).toHaveLength(7);
  expect(deployment.total()).toBe(13);
  expect(output()).toContain("Stock consumed by this run: 7 unit(s).");
});
