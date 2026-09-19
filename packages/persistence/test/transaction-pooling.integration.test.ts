/**
 * The submission store under a transaction-mode pooler (#28, ADR 0005).
 *
 * Cloudflare Hyperdrive pools in transaction mode: a client holds one origin
 * connection only for a transaction (or a single statement outside one), and
 * the connection is reset when it returns to the pool, so session state does
 * not carry over to the next checkout. This file simulates that against real
 * PostgreSQL with {@link TransactionModePool}:
 *
 * - `max: 1` and no idle timeout, so every transaction and every statement
 *   runs on the same physical connection (the worst case: whatever one
 *   checkout leaves behind, the next one would see). Tests check this with
 *   `pg_backend_pid()`. One connection is right for catching leaks, but it
 *   cannot catch the opposite mistake: code that assumes two transactions
 *   share a backend (for example, relying on `pg_backend_pid()`) passes here
 *   and breaks under Hyperdrive. docs/cloudflare-deployment-design.md forbids
 *   that assumption.
 * - Every checkout resets the connection with `DISCARD ALL` before handing it
 *   out. Resetting at the next checkout is equivalent to resetting on return
 *   for whoever uses the connection next, and it needs no queries queued on a
 *   client pg-pool has already released (pg deprecates that).
 *
 * Why `DISCARD ALL` rather than `RESET ALL`: it is the stricter reset, a
 * superset of `RESET ALL` that also closes cursors, deallocates prepared
 * statements, drops temporary tables and releases session advisory locks.
 * Code that works after it relies on no session state a pooler could drop.
 * It also fails inside a transaction block, so a connection returned
 * mid-transaction fails the next checkout instead of going unnoticed. It could
 * only be too strict for named prepared statements, which Hyperdrive keeps.
 * PrismaPg names none (no `statementNameGenerator` is configured), and the
 * probe below counts them.
 *
 * Before the reset, each checkout of a used connection probes what the
 * previous checkout left behind: timeouts, default isolation, session
 * advisory locks, prepared statements and temporary tables. That is
 * instrumentation, not pooler behaviour. It shows any state that would
 * outlive a transaction on the origin connection, which the reset would
 * otherwise hide.
 *
 * The per-file database defaults to SERIALIZABLE, so READ COMMITTED inside
 * the store can only come from the transaction itself.
 *
 * @module
 */

import { TransientSubmissionError } from "@scos/core";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { type Prisma, type PrismaClient, createPrismaClient } from "../src/prisma";
import { seedWarehouses } from "../src/seed";
import { databaseErrorDetails } from "../src/submission-errors";
import {
  type PrismaSubmissionStoreOptions,
  createPrismaSubmissionStore,
} from "../src/submission-store";
import { createMigratedDatabase, type MigratedDatabase } from "./support/database";

/** Session state a transaction-mode pooler does not carry between checkouts. */
interface SessionState {
  readonly pid: number;
  readonly lockTimeout: string;
  readonly statementTimeout: string;
  readonly isolation: string;
  readonly advisoryLocks: number;
  readonly preparedStatements: number;
  readonly tempTables: number;
}

const SESSION_STATE_SQL = `SELECT pg_backend_pid() AS pid,
       current_setting('lock_timeout') AS "lockTimeout",
       current_setting('statement_timeout') AS "statementTimeout",
       current_setting('transaction_isolation') AS isolation,
       (SELECT count(*)::int FROM pg_locks
         WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS "advisoryLocks",
       (SELECT count(*)::int FROM pg_prepared_statements) AS "preparedStatements",
       (SELECT count(*)::int FROM pg_class
         WHERE relnamespace = pg_my_temp_schema()) AS "tempTables"`;

/** Store options whose settings display exactly as configured ("150ms"). */
const OPTIONS_A = { lockTimeoutMs: 150, timeoutMs: 4_750 } satisfies PrismaSubmissionStoreOptions;
const OPTIONS_B = { lockTimeoutMs: 250, timeoutMs: 3_250 } satisfies PrismaSubmissionStoreOptions;

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: PoolClient["release"],
) => void;

/**
 * A one-connection pg pool that behaves like a transaction-mode pooler: every
 * checkout (pg-pool's `query()` checks out through `connect()` too) probes and
 * then `DISCARD ALL`s the connection before use.
 */
class TransactionModePool extends Pool {
  /** What each checkout of a used connection found, before resetting it. */
  readonly leftovers: SessionState[] = [];
  /** Probe or reset failures, for example a connection still in a transaction. */
  readonly resetErrors: unknown[] = [];
  readonly #used = new WeakSet<PoolClient>();

  constructor(connectionString: string) {
    super({ connectionString, max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 5_000 });
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const checkout = this.#checkout();
    if (callback === undefined) {
      return checkout;
    }
    checkout.then(
      (client) => callback(undefined, client, client.release),
      (error: Error) => callback(error, undefined, () => {}),
    );
  }

  async #checkout(): Promise<PoolClient> {
    const client = await super.connect();
    try {
      if (this.#used.has(client)) {
        const { rows } = await client.query<SessionState>(SESSION_STATE_SQL);
        this.leftovers.push(...rows);
      }
      await client.query("DISCARD ALL");
    } catch (error) {
      this.resetErrors.push(error);
      // Releasing with an error destroys the connection.
      client.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    this.#used.add(client);
    return client;
  }

  /**
   * Checks the connection out for one statement and returns what the previous
   * checkout left on it (before this checkout's reset) and the state after
   * the reset.
   */
  async nextCheckout(): Promise<{ leftover: SessionState; afterReset: SessionState }> {
    const before = this.leftovers.length;
    const { rows } = await this.query<SessionState>(SESSION_STATE_SQL);
    const leftover = this.leftovers[before];
    const afterReset = rows[0];
    if (
      leftover === undefined ||
      afterReset === undefined ||
      this.leftovers.length !== before + 1
    ) {
      throw new Error("Expected exactly one probe of a used connection");
    }
    return { leftover, afterReset };
  }
}

/**
 * Wraps the client so a test can run SQL on the store's own transaction:
 * the store's `$transaction` callback receives the same `tx`, recorded here
 * while it runs. Nothing else about the client changes.
 */
function observeTransactions(prisma: PrismaClient) {
  let current: Prisma.TransactionClient | undefined;
  const transaction = (
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: Parameters<PrismaClient["$transaction"]>[1],
  ) =>
    prisma.$transaction(async (tx) => {
      current = tx;
      try {
        return await work(tx);
      } finally {
        current = undefined;
      }
    }, options);

  const client = new Proxy(prisma, {
    get(target, property) {
      if (property === "$transaction") {
        return transaction;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const inTransaction = () => {
    if (current === undefined) {
      throw new Error("Must be called inside runInTransaction");
    }
    return current;
  };

  return {
    client,
    /** The session state inside the store's running transaction. */
    async state(): Promise<SessionState> {
      const [row] = await inTransaction().$queryRawUnsafe<SessionState[]>(SESSION_STATE_SQL);
      if (row === undefined) {
        throw new Error("The session state query returned no row");
      }
      return row;
    },
    /** Runs SQL on the store's running transaction. */
    async query(sql: string): Promise<unknown> {
      return inTransaction().$queryRawUnsafe(sql);
    },
  };
}

/** Asserts a transient submission failure caused by the given SQLSTATE. */
function expectTransient(error: unknown, sqlState: string): void {
  expect(error, `expected TransientSubmissionError, got ${String(error)}`).toBeInstanceOf(
    TransientSubmissionError,
  );
  expect(databaseErrorDetails((error as Error).cause)?.sqlState).toBe(sqlState);
}

let db: MigratedDatabase;
/** The server's session defaults for this database, from an unpooled connection. */
let defaults: Omit<SessionState, "pid">;
let pool: TransactionModePool;
let prisma: PrismaClient;

/** Holds every warehouse row lock on a separate connection until released. */
async function holdWarehouseLocks(): Promise<{ pid: number; release(): Promise<void> }> {
  const holder = new Client({ connectionString: db.url, connectionTimeoutMillis: 5_000 });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    const locked = await holder.query("SELECT id FROM warehouses ORDER BY id FOR UPDATE");
    expect(locked.rowCount).toBe(6);
    const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    let released = false;
    return {
      pid: rows[0]?.pid ?? -1,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await holder.query("ROLLBACK");
        } finally {
          await holder.end();
        }
      },
    };
  } catch (error) {
    await holder.end();
    throw error;
  }
}

/** Waits until another backend is blocked on a lock held by `holderPid`. */
async function waitForLockWaiter(holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const { rows } = await db.pool.query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))) AS waiting",
      [holderPid],
    );
    if (rows[0]?.waiting) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No backend started waiting for the locks of ${holderPid}`);
}

describe("submission store under transaction-mode pooling", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = await createMigratedDatabase();
    // Applies to sessions opened from now on, including the pooler's.
    await db.pool.query(
      `ALTER DATABASE "${db.name}" SET default_transaction_isolation = 'serializable'`,
    );
    await db.pool.query("DELETE FROM warehouses");
    expect(await seedWarehouses(db.pool)).toStrictEqual({ inserted: 6, existing: 0 });

    const baseline = new Client({ connectionString: db.url, connectionTimeoutMillis: 5_000 });
    await baseline.connect();
    try {
      const { rows } = await baseline.query<SessionState>(SESSION_STATE_SQL);
      const { pid: _pid, ...state } = rows[0] as SessionState;
      defaults = state;
    } finally {
      await baseline.end();
    }
    // The configured values must differ from the defaults, or the checks
    // below could pass without the store setting anything.
    expect(defaults).toMatchObject({
      isolation: "serializable",
      advisoryLocks: 0,
      preparedStatements: 0,
      tempTables: 0,
    });
    for (const options of [OPTIONS_A, OPTIONS_B]) {
      expect(defaults.lockTimeout).not.toBe(`${options.lockTimeoutMs}ms`);
      expect(defaults.statementTimeout).not.toBe(`${options.timeoutMs}ms`);
    }
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(() => {
    pool = new TransactionModePool(db.url);
    prisma = createPrismaClient(pool);
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await pool.end();
    // Every checkout reset cleanly: no connection came back mid-transaction.
    expect(pool.resetErrors).toStrictEqual([]);
  });

  test("timeouts and READ COMMITTED hold inside the transaction and do not outlive commit or rollback", async () => {
    const observed = observeTransactions(prisma);
    const store = createPrismaSubmissionStore(observed.client, OPTIONS_A);

    // Committed.
    const committed = await store.runInTransaction(async (tx) => {
      await tx.lockInventory();
      return observed.state();
    });
    expect(committed).toStrictEqual({
      ...defaults,
      pid: committed.pid,
      lockTimeout: "150ms",
      statementTimeout: "4750ms",
      isolation: "read committed",
    });
    expect(await pool.nextCheckout()).toStrictEqual({
      leftover: { pid: committed.pid, ...defaults },
      afterReset: { pid: committed.pid, ...defaults },
    });

    // Rolled back by an error of the work itself.
    const failure = new Error("work failed after reading its session state");
    let rolledBack: SessionState | undefined;
    await expect(
      store.runInTransaction(async (tx) => {
        await tx.lockInventory();
        rolledBack = await observed.state();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(rolledBack).toStrictEqual(committed);
    expect(await pool.nextCheckout()).toStrictEqual({
      leftover: { pid: committed.pid, ...defaults },
      afterReset: { pid: committed.pid, ...defaults },
    });
  });

  test("timeouts apply on a connection whose session state was just reset", async () => {
    // Session-level values set on the pooled connection are gone at the next
    // checkout, so the store cannot be relying on anything set earlier.
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    try {
      await client.query("SET lock_timeout = '9s'");
      await client.query("SET statement_timeout = '9s'");
    } finally {
      client.release();
    }
    expect(await pool.nextCheckout()).toStrictEqual({
      leftover: { ...defaults, pid, lockTimeout: "9s", statementTimeout: "9s" },
      afterReset: { pid, ...defaults },
    });

    const observed = observeTransactions(prisma);
    const store = createPrismaSubmissionStore(observed.client, {
      lockTimeoutMs: 100,
      timeoutMs: 1_250,
    });

    // lock_timeout fires on the reset connection.
    const holder = await holdWarehouseLocks();
    try {
      let inside: SessionState | undefined;
      const started = performance.now();
      const locked: unknown = await store
        .runInTransaction(async (tx) => {
          inside = await observed.state();
          return tx.lockInventory();
        })
        .catch((error: unknown) => error);
      expectTransient(locked, "55P03");
      expect(performance.now() - started).toBeLessThan(1_250);
      expect(inside).toStrictEqual({
        ...defaults,
        pid,
        lockTimeout: "100ms",
        statementTimeout: "1250ms",
        isolation: "read committed",
      });
    } finally {
      await holder.release();
    }

    // statement_timeout fires on the reset connection: PostgreSQL cancels the
    // statement server-side (57014) instead of letting it sleep for 5 s.
    //
    // The store applies timeoutMs as both Prisma's transaction timeout and
    // statement_timeout; the options cannot set them apart, and overriding
    // statement_timeout here would stop testing the store's own value. 57014
    // still wins deterministically, although Prisma's timer (started once
    // BEGIN returns) fires a few milliseconds before the server's (started
    // when pg_sleep does): on expiry Prisma only marks the transaction
    // timed out and issues ROLLBACK, which pg queues behind the in-flight
    // pg_sleep on the same client. It does not abort that query, so the query
    // rejects with the server's 57014, and $transaction rethrows the
    // callback's error while swallowing its own failed rollback (Prisma 7.10).
    // A P2028 here would mean the query was never dispatched in time.
    const started = performance.now();
    const cancelled: unknown = await store
      .runInTransaction(() => observed.query("SELECT pg_sleep(5)"))
      .catch((error: unknown) => error);
    expectTransient(cancelled, "57014");
    expect(performance.now() - started).toBeLessThan(3_000);
    expect((await pool.nextCheckout()).leftover).toStrictEqual({ pid, ...defaults });
  });

  test("FOR UPDATE serializes with another connection's row locks through the pooler", async () => {
    const store = createPrismaSubmissionStore(prisma, OPTIONS_A);
    const holder = await holdWarehouseLocks();
    try {
      // While the locks are held, the submission fails with the transient
      // lock-timeout classification the store uses for retries.
      const blocked: unknown = await store
        .runInTransaction((tx) => tx.lockInventory())
        .catch((error: unknown) => error);
      expectTransient(blocked, "55P03");

      // With a lock timeout longer than the hold, it waits for the holder and
      // then proceeds: the locks serialize rather than fail.
      const patient = createPrismaSubmissionStore(prisma, {
        lockTimeoutMs: 5_000,
        timeoutMs: 10_000,
      });
      const waiting = patient.runInTransaction(async (tx) => {
        const snapshot = await tx.lockInventory();
        return { snapshot, lockedAt: performance.now() };
      });
      await waitForLockWaiter(holder.pid);
      const releasedAt = performance.now();
      await holder.release();
      const { snapshot, lockedAt } = await waiting;
      expect(snapshot).toHaveLength(6);
      expect(lockedAt).toBeGreaterThanOrEqual(releasedAt);
    } finally {
      await holder.release();
    }

    // Once released, a submission with the original timeouts succeeds too.
    await expect(store.runInTransaction((tx) => tx.lockInventory())).resolves.toHaveLength(6);
  });

  test("sequential transactions on the one pooled connection each get their own settings", async () => {
    const observed = observeTransactions(prisma);
    const storeA = createPrismaSubmissionStore(observed.client, OPTIONS_A);
    const storeB = createPrismaSubmissionStore(observed.client, OPTIONS_B);

    const read = (store: typeof storeA) =>
      store.runInTransaction(async (tx) => {
        await tx.lockInventory();
        return observed.state();
      });
    const first = await read(storeA);
    const second = await read(storeB);
    const third = await read(storeA);

    const inTransaction = { ...defaults, pid: first.pid, isolation: "read committed" };
    expect([first, second, third]).toStrictEqual([
      { ...inTransaction, lockTimeout: "150ms", statementTimeout: "4750ms" },
      { ...inTransaction, lockTimeout: "250ms", statementTimeout: "3250ms" },
      { ...inTransaction, lockTimeout: "150ms", statementTimeout: "4750ms" },
    ]);
    // Each transaction left the defaults behind for the next checkout.
    expect(pool.leftovers).toStrictEqual([
      { pid: first.pid, ...defaults },
      { pid: first.pid, ...defaults },
    ]);
    expect((await pool.nextCheckout()).leftover).toStrictEqual({ pid: first.pid, ...defaults });
  });
});
