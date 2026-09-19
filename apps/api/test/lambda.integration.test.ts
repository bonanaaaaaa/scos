/**
 * The Lambda handlers (from source) against a real PostgreSQL database:
 * warm reuse of one connection per execution environment, the full
 * verify/submit paths through API Gateway v2 events, and the IAM token hook
 * with pg. The built artifacts are exercised in
 * lambda-artifacts.integration.test.ts.
 */
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { composeSubmitOrderApplication } from "../src/endpoints/submit-order/composition";
import { composeVerifyOrderApplication } from "../src/endpoints/verify-order/composition";
import { orderResponseSchema, verifyOrderResponseSchema } from "../src/index";
import { databaseLambda } from "../src/lambda/database";
import { iamPoolConfig } from "../src/lambda/pool";
import { type LambdaRuntime, initializeLambda } from "../src/lambda/runtime";
import { httpApiEvent, lambdaContext } from "../src/testing/lambda-events.test-support";
import { AT_PARIS, PARIS, silentLogger } from "./support/app";
import { type TestDatabase, createTestDatabase, stockById } from "./support/database";

let db: TestDatabase;
const runtimes: LambdaRuntime[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.reset();
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.composed.close()));
});

function withApplicationName(url: string, name: string): string {
  const tagged = new URL(url);
  tagged.searchParams.set("application_name", name);
  return tagged.toString();
}

function start(
  compose: typeof composeVerifyOrderApplication,
  applicationName: string,
): LambdaRuntime {
  const runtime = initializeLambda(
    databaseLambda((options) => compose({ ...options, logger: silentLogger })),
    { DATABASE_URL: withApplicationName(db.url, applicationName) },
  );
  runtimes.push(runtime);
  return runtime;
}

interface Backend {
  readonly pid: number;
  readonly backendStart: string;
}

/** The server backends of the handler's pool, found by application_name. */
async function backendsOf(applicationName: string): Promise<Backend[]> {
  const result = await db.pool.query<Backend>(
    `SELECT pid, backend_start::text AS "backendStart" FROM pg_stat_activity
     WHERE datname = current_database() AND application_name = $1`,
    [applicationName],
  );
  return result.rows;
}

/** Terminates the handler's connection, as RDS Proxy closes an idle client. */
async function terminate(applicationName: string): Promise<void> {
  const [backend] = await backendsOf(applicationName);
  expect(backend, "the warm connection").toBeDefined();
  await db.pool.query("SELECT pg_terminate_backend($1)", [backend?.pid]);
  for (let attempt = 0; (await backendsOf(applicationName)).length > 0; attempt += 1) {
    expect(attempt, "backend still present").toBeLessThan(100);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const verifyEvent = () =>
  httpApiEvent("POST", "/api/v1/orders/verify", { body: { quantity: 10, ...AT_PARIS } });

describe("Lambda handlers against PostgreSQL", () => {
  test("verify: warm invocations reuse the same server backend", async () => {
    const { handler } = start(composeVerifyOrderApplication, "scos-lambda-verify");
    const seen: Backend[][] = [];
    for (let invocation = 0; invocation < 3; invocation += 1) {
      const result = await handler(verifyEvent(), lambdaContext("scos-verify-order"));
      expect(result.statusCode, result.body).toBe(200);
      expect(verifyOrderResponseSchema.parse(JSON.parse(result.body))).toMatchObject({
        valid: true,
        quantity: 10,
      });
      seen.push(await backendsOf("scos-lambda-verify"));
    }
    // One backend, and the same one (pid and start time) every time.
    expect(seen[0]).toHaveLength(1);
    expect(seen[1]).toStrictEqual(seen[0]);
    expect(seen[2]).toStrictEqual(seen[0]);
  });

  test("submit: accepts once, replays the same Order, deducts stock once, one connection", async () => {
    const { handler } = start(composeSubmitOrderApplication, "scos-lambda-submit");
    const before = await stockById(db.pool);
    const event = httpApiEvent("POST", "/api/v1/orders", {
      body: { submissionId: "lambda-integration-1", quantity: 10, ...AT_PARIS },
    });

    const first = await handler(event, lambdaContext("scos-submit-order"));
    expect(first.statusCode, first.body).toBe(201);
    const order = orderResponseSchema.parse(JSON.parse(first.body));
    expect(order.allocations).toStrictEqual([{ warehouseId: PARIS, quantity: 10 }]);

    const replay = await handler(event, lambdaContext("scos-submit-order"));
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(first.body);

    const after = await stockById(db.pool);
    expect(after[PARIS]).toBe((before[PARIS] ?? 0) - 10);
    expect(await backendsOf("scos-lambda-submit")).toHaveLength(1);
  });
});

describe("a warm connection closed by the server (as by RDS Proxy's idle timeout)", () => {
  // The process must survive (an unhandled pool error would fail this run)
  // and the environment must recover on a new connection. Verify has no
  // retry: the request racing the close may fail (500). Retrying verify is a
  // #16 measurement item, not behaviour tested here.
  test("verify: the process survives and the next request succeeds on a new backend", async () => {
    const { handler } = start(composeVerifyOrderApplication, "scos-lambda-verify-closed");
    expect((await handler(verifyEvent(), lambdaContext())).statusCode).toBe(200);
    const [before] = await backendsOf("scos-lambda-verify-closed");
    await terminate("scos-lambda-verify-closed");

    const racing = await handler(verifyEvent(), lambdaContext());
    // Observed: 500 when pg hands out the closed connection before noticing
    // the close; 200 when it noticed first.
    expect([200, 500]).toContain(racing.statusCode);
    const next = await handler(verifyEvent(), lambdaContext());
    expect(next.statusCode, next.body).toBe(200);
    const after = await backendsOf("scos-lambda-verify-closed");
    expect(after).toHaveLength(1);
    expect(after[0]?.pid).not.toBe(before?.pid);
  });

  test("submit: SubmitOrder's retry recovers; the Order is stored once", async () => {
    const { handler } = start(composeSubmitOrderApplication, "scos-lambda-submit-closed");
    const warm = httpApiEvent("POST", "/api/v1/orders", {
      body: { submissionId: "lambda-closed-warm", quantity: 1, ...AT_PARIS },
    });
    expect((await handler(warm, lambdaContext())).statusCode).toBe(201);
    const before = await stockById(db.pool);
    await terminate("scos-lambda-submit-closed");

    const event = httpApiEvent("POST", "/api/v1/orders", {
      body: { submissionId: "lambda-closed-1", quantity: 10, ...AT_PARIS },
    });
    const racing = await handler(event, lambdaContext());
    expect([201, 500, 503]).toContain(racing.statusCode);
    // A client retries with the same submissionId after any failure.
    const retried = racing.statusCode === 201 ? racing : await handler(event, lambdaContext());
    expect(retried.statusCode, retried.body).toBe(201);
    const replay = await handler(event, lambdaContext());
    expect(replay.body).toBe(retried.body);
    expect((await stockById(db.pool))[PARIS]).toBe((before[PARIS] ?? 0) - 10);
  });
});

describe("the IAM token hook with PostgreSQL", () => {
  test("each new physical connection authenticates with a newly minted token", async () => {
    const url = new URL(db.url);
    const getAuthToken = vi.fn(async () => decodeURIComponent(url.password));
    const config = iamPoolConfig(
      {
        mode: "iam",
        hostname: url.hostname,
        port: Number(url.port),
        username: decodeURIComponent(url.username),
        database: db.name,
        region: "ap-southeast-1",
      },
      { connectionTimeoutMillis: 5_000 },
      () => ({ getAuthToken }),
    );
    // The local server has no TLS; TLS enforcement is tested in the unit
    // tests and against the built artifacts.
    const pool = new Pool({ ...config, ssl: false });
    try {
      const first = await pool.connect();
      await first.query("SELECT 1");
      first.release();
      const reused = await pool.connect();
      await reused.query("SELECT 1");
      expect(getAuthToken).toHaveBeenCalledTimes(1);
      // Destroy it, as a dropped connection would be; the next one is new.
      reused.release(true);
      const fresh = await pool.connect();
      await fresh.query("SELECT 1");
      fresh.release();
      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(pool.totalCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
