import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { ComposedApplication } from "./composition";
import { startBlackHole } from "./testing/black-hole.test-support";
import { type ServerRuntime, main, nodeRuntime, startServer } from "./server";

function fakeRuntime(overrides: Partial<ServerRuntime> = {}) {
  const signals = new Map<string, () => void>();
  const composed = {
    app: { fetch: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as ComposedApplication & { close: ReturnType<typeof vi.fn> };
  const closeServer = vi.fn((callback?: (error?: Error) => void) => callback?.());
  const mocks = {
    serve: vi.fn((options: { port: number }, onListening: (info: { port: number }) => void) => {
      onListening({ port: options.port });
      return { close: closeServer };
    }),
    compose: vi.fn(() => composed),
    log: vi.fn(),
    logError: vi.fn(),
    exit: vi.fn(),
    onSignal: vi.fn((signal: string, handler: () => void) => {
      signals.set(signal, handler);
    }),
  } satisfies ServerRuntime;
  const runtime: ServerRuntime = { ...mocks, ...overrides };
  return { runtime, mocks, signals, composed, closeServer };
}

describe("main (in process)", () => {
  test("invalid configuration exits 1 before composing or listening", () => {
    const { runtime, mocks } = fakeRuntime();

    expect(main({ PORT: "abc" }, runtime)).toBeUndefined();

    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(mocks.serve).not.toHaveBeenCalled();
    expect(mocks.logError.mock.calls.map(([message]) => message)).toStrictEqual([
      "SCOS API not started: invalid configuration.",
      "  DATABASE_URL: is required",
      "  PORT: must be an integer between 0 and 65535",
    ]);
  });

  test("valid configuration composes over DATABASE_URL and listens on PORT", () => {
    const { runtime, mocks, composed } = fakeRuntime();

    const running = main({ DATABASE_URL: "postgresql://h/db", PORT: "4321" }, runtime);

    expect(running?.config).toStrictEqual({ databaseUrl: "postgresql://h/db", port: 4321 });
    expect(mocks.compose).toHaveBeenCalledExactlyOnceWith({ databaseUrl: "postgresql://h/db" });
    expect(mocks.serve.mock.calls[0]?.[0]).toStrictEqual({ fetch: composed.app.fetch, port: 4321 });
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith(
      "SCOS API listening on http://localhost:4321",
    );
    expect(mocks.onSignal.mock.calls.map(([signal]) => signal)).toStrictEqual([
      "SIGINT",
      "SIGTERM",
    ]);
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  test("a signal closes the listener, then the database clients, then exits 0", async () => {
    const { runtime, mocks, signals, composed, closeServer } = fakeRuntime();
    main({ DATABASE_URL: "postgresql://h/db" }, runtime);

    signals.get("SIGTERM")?.();
    signals.get("SIGINT")?.();
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0));

    expect(closeServer).toHaveBeenCalledOnce();
    expect(composed.close).toHaveBeenCalledOnce();
    expect(closeServer.mock.invocationCallOrder[0]).toBeLessThan(
      composed.close.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("a failed shutdown still closes the clients and exits 1", async () => {
    const failure = new Error("close failed");
    const { runtime, mocks, signals, composed } = fakeRuntime({
      serve: (_options, onListening) => {
        onListening({ port: 1 });
        return { close: (callback) => callback?.(failure) };
      },
    });
    main({ DATABASE_URL: "postgresql://h/db" }, runtime);

    signals.get("SIGINT")?.();
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));

    expect(composed.close).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith("SCOS API shutdown failed.", failure);
  });

  test("startServer can be used without main", async () => {
    const { runtime, composed } = fakeRuntime();
    const running = startServer({ databaseUrl: "postgresql://h/db", port: 0 }, runtime);

    await running.shutdown();
    await running.shutdown();
    expect(composed.close).toHaveBeenCalledOnce();
  });

  test("the node runtime logs to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      nodeRuntime.log("hello");
      nodeRuntime.logError("plain");
      nodeRuntime.logError("with cause", "cause");
      expect(log).toHaveBeenCalledWith("hello");
      expect(error.mock.calls).toStrictEqual([["plain"], ["with cause", "cause"]]);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The real entrypoint as a subprocess
// ---------------------------------------------------------------------------

const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

interface Launched {
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
}

function launch(environment: Record<string, string>): Launched {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: apiDirectory,
    // Only what the process needs: no inherited DATABASE_URL or PORT.
    env: { PATH: process.env.PATH ?? "", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

/**
 * Port 1 (tcpmux) is privileged and unused on developer and CI machines, so a
 * connection is refused. An ephemeral port that was just closed could be
 * reused by another process in the meantime.
 */
const CLOSED_PORT = 1;

async function waitForListening(launched: Launched): Promise<string> {
  await vi.waitFor(() => expect(launched.stdout()).toMatch(/listening on http:\/\/localhost:\d+/), {
    timeout: 20_000,
    interval: 50,
  });
  const listening = /localhost:(\d+)/.exec(launched.stdout())?.[1];
  return `http://127.0.0.1:${listening}`;
}

describe("server entrypoint (subprocess)", { timeout: 30_000 }, () => {
  test.each([
    ["DATABASE_URL is missing", {}, "DATABASE_URL", undefined],
    [
      "DATABASE_URL is not a PostgreSQL URL",
      { DATABASE_URL: "mysql://leaky-user:leaky-password@db.example/scos" },
      "DATABASE_URL",
      "leaky",
    ],
    [
      "DATABASE_URL is not a URL",
      { DATABASE_URL: "leaky-password-not-a-url" },
      "DATABASE_URL",
      "leaky",
    ],
    [
      "PORT is invalid",
      { DATABASE_URL: "postgresql://leaky-user:leaky-password@127.0.0.1/scos", PORT: "70123" },
      "PORT",
      "70123",
    ],
  ] as const)(
    "exits nonzero without listening when %s",
    async (_name, environment, variable, secret) => {
      const launched = launch({ ...environment });

      const code = await launched.exited;

      expect(code).not.toBe(0);
      expect(code).not.toBeNull();
      expect(launched.stderr()).toContain(variable);
      expect(launched.stdout()).not.toContain("listening");
      if (secret !== undefined) {
        expect(launched.stderr()).not.toContain(secret);
        expect(launched.stdout()).not.toContain(secret);
      }
    },
  );

  test("valid configuration listens; /health is 200 while the database is unreachable", async () => {
    const launched = launch({
      DATABASE_URL: `postgresql://scos:leaky-password@127.0.0.1:${CLOSED_PORT}/scos`,
      PORT: "0",
    });
    const base = await waitForListening(launched);

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toStrictEqual({ status: "ok" });

    // A request that needs the database fails without leaking internals.
    const verify = await fetch(`${base}/orders/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 1, latitude: 0, longitude: 0 }),
    });
    expect(verify.status).toBe(500);
    const body = await verify.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(body).not.toMatch(/leaky|ECONNREFUSED|127\.0\.0\.1/);

    launched.child.kill("SIGTERM");
    expect(await launched.exited).toBe(0);
    expect(launched.stdout()).not.toContain("leaky-password");
    expect(launched.stderr()).not.toContain("leaky-password");
  });

  test("a database that accepts TCP but never answers yields 5xx within bounds, and shutdown completes", async () => {
    const blackHole = await startBlackHole();
    try {
      const launched = launch({
        DATABASE_URL: `postgresql://scos:leaky-password@127.0.0.1:${blackHole.port}/scos`,
        PORT: "0",
      });
      const base = await waitForListening(launched);
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const started = Date.now();
      const verifying = post("/orders/verify", { quantity: 1, latitude: 0, longitude: 0 });
      const submitting = post("/orders", {
        submissionId: "black-hole-1",
        quantity: 1,
        latitude: 0,
        longitude: 0,
      });
      // Shut down while both requests are still waiting on the database: each
      // has opened its own connection to the black hole.
      await vi.waitFor(() => expect(blackHole.accepted()).toBeGreaterThanOrEqual(2), {
        timeout: 4_000,
        interval: 10,
      });
      launched.child.kill("SIGTERM");

      const [verify, submit] = await Promise.all([verifying, submitting]);
      // Bounded by the 5 s connection timeout, not by the (absent) database.
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(verify.status).toBe(500);
      expect(await verify.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
      expect(submit.status).toBe(503);
      expect(submit.headers.get("retry-after")).toBe("1");
      expect(await submit.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });

      expect(await launched.exited).toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(launched.stderr()).not.toContain("leaky-password");
    } finally {
      await blackHole.close();
    }
  });
});
