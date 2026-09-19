/**
 * Smoke test of the built Lambda artifacts (`pnpm build`, then
 * `package:lambda`): each zip is checked against the manifest, repackaged to
 * prove determinism, extracted outside the workspace (no node_modules can be
 * resolved there), loaded by a fresh Node.js process with the flags Lambda's
 * Node.js runtime applies, and invoked with API Gateway v2 events. Health
 * runs with no environment; verify and submit run against a migrated test
 * database; iam mode's TLS runs against a fake PostgreSQL front end.
 *
 * Needs the `unzip` and `openssl` binaries.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { orderResponseSchema, verifyOrderResponseSchema } from "../src/index";
import { httpApiEvent, lambdaContext } from "../src/testing/lambda-events.test-support";
import {
  type TestCertificate,
  createTestCertificate,
  startFakePostgres,
} from "../src/testing/fake-postgres.test-support";
import { AT_PARIS, PARIS } from "./support/app";
import { type TestDatabase, createTestDatabase, stockById } from "./support/database";

const execFileAsync = promisify(execFile);

const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const lambdaDist = join(apiDirectory, "dist/lambda");
const FUNCTIONS = ["health", "verify-order", "submit-order"] as const;
// Lambda's nodejs24.x runtime disables these (see the Lambda Node.js docs).
const LAMBDA_NODE_FLAGS = ["--no-experimental-require-module", "--no-experimental-detect-module"];

interface ManifestFunction {
  readonly name: string;
  readonly artifact: string;
  readonly handler: string;
  readonly runtime: string;
  readonly architecture: string;
  readonly files: readonly string[];
  readonly bytes: number;
  readonly sha256: string;
  readonly sha256Base64: string;
}

interface Manifest {
  readonly schemaVersion: number;
  readonly gitSha: string | null;
  readonly runtime: string;
  readonly architecture: string;
  readonly functions: readonly ManifestFunction[];
}

interface Invocation {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let manifest: Manifest;
let workspace: string;
let db: TestDatabase;

const DRIVER = `
const [directory, eventsJson, contextJson] = process.argv.slice(2);
const { handler } = await import(new URL(\`./\${directory}/index.mjs\`, import.meta.url).href);
const results = [];
for (const event of JSON.parse(eventsJson)) {
  results.push(await handler(event, JSON.parse(contextJson)));
}
process.stdout.write(JSON.stringify(results));
process.exit(0);
`;

async function invoke(
  name: (typeof FUNCTIONS)[number],
  environment: Record<string, string>,
  events: readonly unknown[],
): Promise<{ results: Invocation[]; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      ...LAMBDA_NODE_FLAGS,
      "driver.mjs",
      name,
      JSON.stringify(events),
      JSON.stringify(lambdaContext(`scos-${name}`)),
    ],
    // Only what Lambda would set: no NODE_PATH, no workspace variables.
    { cwd: workspace, env: { PATH: process.env.PATH ?? "", ...environment }, timeout: 60_000 },
  );
  return { results: JSON.parse(stdout) as Invocation[], stderr };
}

async function failedInit(name: (typeof FUNCTIONS)[number], environment: Record<string, string>) {
  const error = await invoke(name, environment, []).then(
    () => undefined,
    (thrown: unknown) => thrown as { code: number; stdout: string; stderr: string },
  );
  expect(error, "initialization should fail").toBeDefined();
  return error as { code: number; stdout: string; stderr: string };
}

beforeAll(async () => {
  try {
    manifest = JSON.parse(await readFile(join(lambdaDist, "manifest.json"), "utf8")) as Manifest;
  } catch {
    throw new Error("dist/lambda/manifest.json is missing: run `pnpm package:lambda` first");
  }
  workspace = await mkdtemp(join(tmpdir(), "scos-lambda-smoke-"));
  for (const name of FUNCTIONS) {
    await execFileAsync("unzip", [
      "-q",
      join(lambdaDist, `${name}.zip`),
      "-d",
      join(workspace, name),
    ]);
  }
  await writeFile(join(workspace, "driver.mjs"), DRIVER);
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
  }
});

describe("the Lambda artifacts", () => {
  test("match the manifest: handler, runtime, architecture, size and sha256", async () => {
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      runtime: "nodejs24.x",
      architecture: "arm64",
    });
    expect(manifest.functions.map((fn) => fn.name)).toStrictEqual([...FUNCTIONS]);
    for (const fn of manifest.functions) {
      const zip = await readFile(join(lambdaDist, fn.artifact));
      const digest = createHash("sha256").update(zip).digest();
      expect(fn).toMatchObject({
        artifact: `${fn.name}.zip`,
        handler: "index.handler",
        runtime: "nodejs24.x",
        architecture: "arm64",
        files: ["index.mjs", "index.mjs.map"],
        bytes: zip.length,
        sha256: digest.toString("hex"),
        sha256Base64: digest.toString("base64"),
      });
    }
  });

  test("are deterministic: a clean rebuild and repackage give identical bytes", async () => {
    // Rebuilds dist/ in place (build.mjs starts by deleting it) and packages
    // again, which also restores the zips and manifest. The smoke tests below
    // use the copies extracted in beforeAll.
    await execFileAsync(process.execPath, ["build.mjs"], { cwd: apiDirectory });
    await execFileAsync(process.execPath, ["scripts/package-lambda.mjs"], { cwd: apiDirectory });
    const again = JSON.parse(await readFile(join(lambdaDist, "manifest.json"), "utf8")) as Manifest;
    expect(again.functions.map((fn) => [fn.name, fn.sha256, fn.bytes])).toStrictEqual(
      manifest.functions.map((fn) => [fn.name, fn.sha256, fn.bytes]),
    );
  }, 120_000);

  test("are extracted where no package can be resolved", async () => {
    const attempt = execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", "await import('pg')"],
      { cwd: join(workspace, "verify-order"), env: { PATH: process.env.PATH ?? "" } },
    );
    await expect(attempt).rejects.toMatchObject({
      stderr: expect.stringContaining("ERR_MODULE_NOT_FOUND"),
    });
  });
});

describe("the built health handler", () => {
  test("answers without any environment or database", async () => {
    const { results } = await invoke("health", {}, [
      httpApiEvent("GET", "/health"),
      httpApiEvent("GET", "/api/v1/orders"),
    ]);
    expect(results.map((result) => [result.statusCode, JSON.parse(result.body)])).toStrictEqual([
      [200, { status: "ok" }],
      [404, { error: { code: "NOT_FOUND", message: expect.any(String) } }],
    ]);
  });
});

describe("the built verify and submit handlers against PostgreSQL", () => {
  beforeEach(async () => {
    await db.reset();
  });

  test("verify: estimates from current stock, including Prisma's bundled query compiler", async () => {
    const { results } = await invoke("verify-order", { DATABASE_URL: db.url }, [
      httpApiEvent("POST", "/api/v1/orders/verify", { body: { quantity: 10, ...AT_PARIS } }),
      httpApiEvent("POST", "/api/v1/orders/verify", { body: { quantity: 0, ...AT_PARIS } }),
    ]);
    expect(results[0]?.statusCode, results[0]?.body).toBe(200);
    expect(verifyOrderResponseSchema.parse(JSON.parse(results[0]?.body ?? ""))).toMatchObject({
      valid: true,
      allocations: [{ warehouseId: PARIS, quantity: 10 }],
    });
    expect(results[1]?.statusCode).toBe(400);
  });

  test("submit: accepts, replays byte-identically, and deducts stock once", async () => {
    const before = await stockById(db.pool);
    const event = httpApiEvent("POST", "/api/v1/orders", {
      body: { submissionId: "lambda-artifact-1", quantity: 10, ...AT_PARIS },
    });
    const { results } = await invoke("submit-order", { DATABASE_URL: db.url }, [event, event]);
    expect(results[0]?.statusCode, results[0]?.body).toBe(201);
    expect(orderResponseSchema.parse(JSON.parse(results[0]?.body ?? ""))).toMatchObject({
      submissionId: "lambda-artifact-1",
      quantity: 10,
    });
    expect(results[1]?.statusCode).toBe(201);
    expect(results[1]?.body).toBe(results[0]?.body);
    expect((await stockById(db.pool))[PARIS]).toBe((before[PARIS] ?? 0) - 10);
  });
});

describe("TLS in the built iam-mode handler", () => {
  // Placeholder credentials: tokens are signed locally and only ever sent to
  // the fake server on this machine.
  const iamEnvironment = (port: number, extra: Record<string, string> = {}) => ({
    DATABASE_URL: `postgresql://scos_app@localhost:${port}/scos`,
    DATABASE_AUTH_MODE: "iam",
    AWS_REGION: "ap-southeast-1",
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ...extra,
  });
  const verifyEvent = () =>
    httpApiEvent("POST", "/api/v1/orders/verify", { body: { quantity: 1, ...AT_PARIS } });
  let certificates: string;
  let localhost: TestCertificate;
  let otherName: TestCertificate;

  beforeAll(async () => {
    certificates = await mkdtemp(join(tmpdir(), "scos-lambda-tls-"));
    localhost = createTestCertificate(certificates, "localhost", "DNS:localhost");
    otherName = createTestCertificate(certificates, "other", "DNS:db.other.example");
  });

  afterAll(async () => {
    await rm(certificates, { recursive: true, force: true });
  });

  test("a server that declines TLS is refused and receives no token", async () => {
    const server = await startFakePostgres();
    try {
      const { results } = await invoke("verify-order", iamEnvironment(server.port), [
        verifyEvent(),
      ]);
      expect(results[0]?.statusCode).toBe(500);
      expect(server.sslRequests).toBeGreaterThanOrEqual(1);
      expect(server.passwords).toStrictEqual([]);
    } finally {
      await server.close();
    }
  });

  test("a trusted certificate for the host completes TLS and a fresh token is sent per connection", async () => {
    const server = await startFakePostgres({ tls: localhost });
    try {
      const { results } = await invoke(
        "verify-order",
        // A test CA added the way Lambda adds extra CAs; the default store
        // stays in use.
        iamEnvironment(server.port, { NODE_EXTRA_CA_CERTS: localhost.certPath }),
        [verifyEvent(), verifyEvent()],
      );
      // The fake server refuses the login after recording the token.
      expect(results.map((result) => result.statusCode)).toStrictEqual([500, 500]);
      expect(server.tlsSessions).toBe(2);
      expect(server.passwords).toHaveLength(2);
      for (const token of server.passwords) {
        const url = new URL(`https://${token}`);
        expect(url.host).toBe(`localhost:${server.port}`);
        expect(url.searchParams.get("Action")).toBe("connect");
        expect(url.searchParams.get("DBUser")).toBe("scos_app");
        expect(url.searchParams.get("X-Amz-Credential")).toMatch(/\/ap-southeast-1\/rds-db\//);
      }
    } finally {
      await server.close();
    }
  });

  test("a trusted certificate for another host name is rejected and receives no token", async () => {
    const server = await startFakePostgres({ tls: otherName });
    try {
      const { results, stderr } = await invoke(
        "verify-order",
        iamEnvironment(server.port, { NODE_EXTRA_CA_CERTS: otherName.certPath }),
        [verifyEvent()],
      );
      expect(results[0]?.statusCode).toBe(500);
      // Node.js's host name check (Prisma wraps the error, dropping its code).
      expect(stderr).toMatch(/does not match certificate's altnames/);
      expect(server.sslRequests).toBe(1);
      expect(server.tlsSessions).toBe(0);
      expect(server.passwords).toStrictEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("initialization of the built database handlers", () => {
  test.each(["verify-order", "submit-order"] as const)(
    "%s fails initialization on an invalid environment without printing values",
    async (name) => {
      const missing = await failedInit(name, {});
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("LambdaConfigurationError: DATABASE_URL: is required");

      const secret = "do-not-print-me";
      const invalid = await failedInit(name, {
        DATABASE_URL: `postgresql://scos_app:${secret}@proxy.example.com/scos`,
        DATABASE_AUTH_MODE: "iam",
      });
      expect(invalid.stderr).toContain(
        "AWS_REGION: is required when DATABASE_AUTH_MODE is iam\nDATABASE_URL: must not include a password when DATABASE_AUTH_MODE is iam",
      );
      expect(invalid.stderr).not.toContain(secret);

      const unparseable = await failedInit(name, {
        DATABASE_URL: `postgresql://scos_app:${secret}@/scos`,
        DATABASE_AUTH_MODE: "iam",
        AWS_REGION: "ap-southeast-1",
      });
      expect(unparseable.stderr).toContain(
        "LambdaConfigurationError: DATABASE_URL: must be a postgres:// or postgresql:// URL with a host",
      );
      expect(`${unparseable.stdout}${unparseable.stderr}`).not.toContain(secret);
    },
  );
});
