import { afterEach, describe, expect, test, vi } from "vitest";

// Spy on the adapter factories while keeping their real behaviour.
vi.mock("@scos/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scos/persistence")>();
  return {
    ...actual,
    createDatabasePool: vi.fn(actual.createDatabasePool),
    createPrismaClient: vi.fn(actual.createPrismaClient),
    createPrismaInventoryReader: vi.fn(actual.createPrismaInventoryReader),
    createPrismaSubmissionStore: vi.fn(actual.createPrismaSubmissionStore),
  };
});

const persistence = await import("@scos/persistence");
const {
  composeApplication,
  composeHealthApplication,
  composeSubmitOrderApplication,
  composeVerifyOrderApplication,
} = await import("./composition");
const { parseDatabaseConfig, parseHealthConfig } = await import("./config");

const spies = {
  pool: vi.mocked(persistence.createDatabasePool),
  prisma: vi.mocked(persistence.createPrismaClient),
  inventoryReader: vi.mocked(persistence.createPrismaInventoryReader),
  submissionStore: vi.mocked(persistence.createPrismaSubmissionStore),
};

// Nothing listens on port 1; building a composition must not connect.
const databaseUrl = "postgresql://scos:secret@127.0.0.1:1/scos";

afterEach(() => {
  vi.clearAllMocks();
});

function calls() {
  return Object.fromEntries(
    Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]),
  );
}

describe("per-endpoint compositions build only what their endpoint needs", () => {
  test("health: no configuration, no pool and no adapters", async () => {
    expect(parseHealthConfig({})).toStrictEqual({ success: true, config: {} });
    const composed = composeHealthApplication();
    const response = await composed.app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: "ok" });
    expect((await composed.app.request("/orders", { method: "POST" })).status).toBe(404);
    await composed.close();
    expect(calls()).toStrictEqual({ pool: 0, prisma: 0, inventoryReader: 0, submissionStore: 0 });
  });

  test("verify: pool, Prisma and inventory reader; never a submission store", async () => {
    const composed = composeVerifyOrderApplication({ databaseUrl, connectionTimeoutMs: 250 });
    try {
      expect(calls()).toStrictEqual({ pool: 1, prisma: 1, inventoryReader: 1, submissionStore: 0 });
      expect(spies.pool).toHaveBeenCalledWith(databaseUrl, { connectionTimeoutMillis: 250 });
      expect((await composed.app.request("/health")).status).toBe(404);
      expect((await composed.app.request("/orders", { method: "POST" })).status).toBe(404);
    } finally {
      await composed.close();
      await composed.close();
    }
  });

  test("submit: pool, Prisma and submission store with its options; never an inventory reader", async () => {
    const decorate = vi.fn((store) => store);
    const options = { lockTimeoutMs: 100, timeoutMs: 200 };
    const composed = composeSubmitOrderApplication({
      databaseUrl,
      submissionStore: options,
      decorateSubmissionStore: decorate,
      maxSubmissionAttempts: 2,
    });
    try {
      expect(calls()).toStrictEqual({ pool: 1, prisma: 1, inventoryReader: 0, submissionStore: 1 });
      expect(spies.submissionStore.mock.calls[0]?.[1]).toBe(options);
      expect(decorate).toHaveBeenCalledOnce();
      expect((await composed.app.request("/health")).status).toBe(404);
      expect((await composed.app.request("/orders/verify", { method: "POST" })).status).toBe(404);
    } finally {
      await composed.close();
    }
  });

  test("combined: one pool shared by both adapters", async () => {
    const composed = composeApplication({ databaseUrl });
    try {
      expect(calls()).toStrictEqual({ pool: 1, prisma: 1, inventoryReader: 1, submissionStore: 1 });
      expect((await composed.app.request("/health")).status).toBe(200);
    } finally {
      await composed.close();
    }
  });

  test("a construction failure ends the pool it opened and rethrows", async () => {
    const createPool = spies.pool.getMockImplementation();
    if (createPool === undefined) {
      throw new Error("createDatabasePool spy has no implementation");
    }
    /** Creates the next pool for real, with a spy on its `end`. */
    const watchNextPool = () => {
      let end: ReturnType<typeof vi.fn> | undefined;
      spies.pool.mockImplementationOnce((...args) => {
        const pool = createPool(...args);
        end = vi.spyOn(pool, "end") as unknown as ReturnType<typeof vi.fn>;
        return pool;
      });
      return () => end;
    };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    const failures: (() => unknown)[] = [
      () => composeSubmitOrderApplication({ databaseUrl, maxSubmissionAttempts: 0 }),
      () => composeApplication({ databaseUrl, maxSubmissionAttempts: 0 }),
      () => {
        spies.inventoryReader.mockImplementationOnce(() => {
          throw new Error("reader failed");
        });
        return composeVerifyOrderApplication({ databaseUrl });
      },
    ];
    for (const failure of failures) {
      const endOf = watchNextPool();
      expect(failure).toThrow();
      await flush();
      expect(endOf()).toHaveBeenCalledOnce();
    }
  });
});

describe("per-runtime configuration", () => {
  test("verify and submit require DATABASE_URL only", () => {
    expect(parseDatabaseConfig({ DATABASE_URL: databaseUrl, PORT: "not-a-port" })).toStrictEqual({
      success: true,
      config: { databaseUrl },
    });
    expect(parseDatabaseConfig({})).toStrictEqual({
      success: false,
      errors: ["DATABASE_URL: is required"],
    });
    const invalid = parseDatabaseConfig({ DATABASE_URL: "mysql://u:secret@h/d" });
    expect(invalid.success).toBe(false);
    expect(JSON.stringify(invalid)).not.toContain("secret");
  });

  test("health ignores every variable", () => {
    expect(parseHealthConfig({ DATABASE_URL: "garbage", PORT: "x" })).toStrictEqual({
      success: true,
      config: {},
    });
  });
});
