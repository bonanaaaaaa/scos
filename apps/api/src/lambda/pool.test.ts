import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { Signer } from "@aws-sdk/rds-signer";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  type FakePostgres,
  type TestCertificate,
  createTestCertificate,
  startFakePostgres,
} from "../testing/fake-postgres.test-support";
import type { IamDatabaseAuthentication, LambdaDatabaseConfig } from "./config";
import {
  type AuthTokenSignerOptions,
  LAMBDA_POOL_OPTIONS,
  createRdsAuthTokenSigner,
  iamPoolConfig,
  lambdaPoolFactory,
} from "./pool";

const iam: IamDatabaseAuthentication = {
  mode: "iam",
  hostname: "scos.proxy-abcdefghijkl.ap-southeast-1.rds.amazonaws.com",
  port: 5432,
  username: "scos_app",
  database: "scos",
  region: "ap-southeast-1",
};
const timeouts = { connectionTimeoutMillis: 2_000 };

/** A signer that returns a distinct token per call and records its options. */
function countingSigner() {
  const created: AuthTokenSignerOptions[] = [];
  const getAuthToken = vi.fn(async () => `token-${getAuthToken.mock.calls.length}`);
  const createSigner = vi.fn((options: AuthTokenSignerOptions) => {
    created.push(options);
    return { getAuthToken };
  });
  return { created, getAuthToken, createSigner };
}

// -- Tests --------------------------------------------------------------------

describe("iamPoolConfig", () => {
  test("one connection, never evicted, bounded connect, explicit fields and verified TLS", () => {
    const { created, createSigner, getAuthToken } = countingSigner();
    const config = iamPoolConfig(iam, timeouts, createSigner);
    expect(config).toStrictEqual({
      connectionTimeoutMillis: 2_000,
      max: 1,
      idleTimeoutMillis: 0,
      host: iam.hostname,
      port: 5432,
      user: "scos_app",
      database: "scos",
      ssl: { rejectUnauthorized: true },
      password: expect.any(Function),
    });
    expect(config).not.toHaveProperty("connectionString");
    expect(created).toStrictEqual([
      { hostname: iam.hostname, port: 5432, username: "scos_app", region: "ap-southeast-1" },
    ]);
    // Building the configuration mints nothing.
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  test("the password hook mints a new token on every call, never caching one", async () => {
    const { createSigner, getAuthToken } = countingSigner();
    const password = iamPoolConfig(iam, timeouts, createSigner).password as () => Promise<string>;
    expect(await password()).toBe("token-1");
    expect(await password()).toBe("token-2");
    expect(getAuthToken).toHaveBeenCalledTimes(2);
  });
});

describe("the IAM pool with pg", () => {
  let server: FakePostgres;

  beforeAll(async () => {
    server = await startFakePostgres();
  });

  afterAll(async () => {
    await server.close();
  });

  test("pg asks for a fresh token for each new physical connection (TLS off for this server)", async () => {
    const { createSigner, getAuthToken } = countingSigner();
    const config = iamPoolConfig(
      { ...iam, hostname: "127.0.0.1", port: server.port },
      timeouts,
      createSigner,
    );
    // TLS is covered below; this server speaks plain PostgreSQL.
    const pool = new Pool({ ...config, ssl: false });
    pool.on("error", () => undefined);
    try {
      await expect(pool.connect()).rejects.toThrow("recorded");
      await expect(pool.connect()).rejects.toThrow("recorded");
    } finally {
      await pool.end();
    }
    expect(server.connections).toBe(2);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect(server.passwords).toStrictEqual(["token-1", "token-2"]);
  });
});

describe("TLS in iam mode (in process: the default trust store only)", () => {
  let directory: string;
  let selfSigned: TestCertificate;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "scos-tls-"));
    selfSigned = createTestCertificate(directory, "localhost", "DNS:localhost,IP:127.0.0.1");
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("a certificate outside the trust store is rejected before any token is minted", async () => {
    const tlsServer = await startFakePostgres({ tls: selfSigned });
    const { createSigner, getAuthToken } = countingSigner();
    const pool = new Pool(
      iamPoolConfig(
        { ...iam, hostname: "localhost", port: tlsServer.port },
        timeouts,
        createSigner,
      ),
    );
    pool.on("error", () => undefined);
    try {
      await expect(pool.connect()).rejects.toThrow(/self-signed certificate/);
    } finally {
      await pool.end();
      await tlsServer.close();
    }
    expect(tlsServer.sslRequests).toBe(1);
    expect(tlsServer.passwords).toStrictEqual([]);
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  test("a server that declines TLS is refused before any token is minted", async () => {
    const plain = await startFakePostgres();
    const { createSigner, getAuthToken } = countingSigner();
    const pool = new Pool(
      iamPoolConfig({ ...iam, hostname: "127.0.0.1", port: plain.port }, timeouts, createSigner),
    );
    pool.on("error", () => undefined);
    try {
      await expect(pool.connect()).rejects.toThrow();
    } finally {
      await pool.end();
      await plain.close();
    }
    expect(plain.sslRequests).toBe(1);
    expect(plain.passwords).toStrictEqual([]);
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  // Trusted certificates with matching and mismatched host names are
  // exercised against the built artifact (NODE_EXTRA_CA_CERTS must be set
  // before Node.js starts): test/lambda-artifacts.integration.test.ts.

  test("Node.js's bundled trust store includes the Amazon Trust Services roots", () => {
    const subjects = rootCertificates.map((pem) => new X509Certificate(pem).subject);
    for (const name of [
      "Amazon Root CA 1",
      "Amazon Root CA 2",
      "Amazon Root CA 3",
      "Amazon Root CA 4",
      "Starfield Services Root Certificate Authority - G2",
    ]) {
      expect(
        subjects.some((subject) => subject.includes(`CN=${name}`)),
        name,
      ).toBe(true);
    }
  });
});

describe("createRdsAuthTokenSigner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("builds the SDK signer and mints a token locally from static credentials", async () => {
    // Credentials from the environment, as Lambda provides them; these are
    // placeholders, and signing is local, so nothing is sent anywhere.
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    vi.stubEnv("AWS_PROFILE", "");
    const signer = createRdsAuthTokenSigner({
      hostname: iam.hostname,
      port: iam.port,
      username: iam.username,
      region: iam.region,
    });
    expect(signer).toBeInstanceOf(Signer);
    const token = await signer.getAuthToken();
    const url = new URL(`https://${token}`);
    expect(url.host).toBe(`${iam.hostname}:5432`);
    expect(url.searchParams.get("Action")).toBe("connect");
    expect(url.searchParams.get("DBUser")).toBe("scos_app");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(
      /^AKIAIOSFODNN7EXAMPLE\/\d{8}\/ap-southeast-1\/rds-db\/aws4_request$/,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(await signer.getAuthToken()).toMatch(/[?&]X-Amz-Signature=[0-9a-f]{64}(&|$)/);
  });
});

describe("lambdaPoolFactory", () => {
  test("password mode: the connection string with one connection per environment", async () => {
    const config: LambdaDatabaseConfig = {
      databaseUrl: "postgresql://scos:secret@127.0.0.1:1/scos",
      authentication: { mode: "password" },
    };
    const pool = lambdaPoolFactory(config)(timeouts);
    try {
      expect(pool.options).toMatchObject({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 2_000,
        ...LAMBDA_POOL_OPTIONS,
      });
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  });

  test("iam mode: builds the signer but connects and mints nothing", async () => {
    const { created, createSigner, getAuthToken } = countingSigner();
    const pool = lambdaPoolFactory(
      { databaseUrl: "unused", authentication: iam },
      createSigner,
    )(timeouts);
    try {
      expect(pool.options).toMatchObject({ host: iam.hostname, max: 1, idleTimeoutMillis: 0 });
      expect(created).toHaveLength(1);
      expect(getAuthToken).not.toHaveBeenCalled();
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
