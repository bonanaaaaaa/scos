import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { startBlackHole } from "#testing/black-hole.test-support";

// ---------------------------------------------------------------------------
// The real entrypoint as a subprocess
// ---------------------------------------------------------------------------

const apiDirectory = fileURLToPath(new URL("../..", import.meta.url));
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
  const child = spawn(process.execPath, ["--import", "tsx", "src/entrypoints/node.ts"], {
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
    const verify = await fetch(`${base}/api/v1/orders/verify`, {
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
      const verifying = post("/api/v1/orders/verify", { quantity: 1, latitude: 0, longitude: 0 });
      const submitting = post("/api/v1/orders", {
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
