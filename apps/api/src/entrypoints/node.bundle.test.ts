/**
 * Guards the bundled load path: `dist/node.js` (esbuild output, with Pino
 * loaded at runtime from node_modules) must still be patched by
 * PinoInstrumentation, so a request log carries the trace ID of the incoming
 * `traceparent`. `pnpm test` builds first (turbo `test` depends on `build`).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

const apiDirectory = fileURLToPath(new URL("../..", import.meta.url));
const bundle = fileURLToPath(new URL("../../dist/node.js", import.meta.url));
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

function records(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("built bundle (dist/node.js)", { timeout: 30_000 }, () => {
  test("PinoInstrumentation correlates the request log with the incoming traceparent", async () => {
    expect(existsSync(bundle), "run `pnpm --filter @scos/api build` first").toBe(true);
    const child = spawn(process.execPath, [bundle], {
      cwd: apiDirectory,
      env: {
        PATH: process.env.PATH ?? "",
        // Validated but never connected to: /health does not use the database.
        DATABASE_URL: "postgresql://scos:leaky-password@127.0.0.1:1/scos",
        PORT: "0",
        OTEL_SERVICE_NAME: "scos-api-bundle-test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = once(child, "exit").then(([code]) => code as number | null);

    await vi.waitFor(() => expect(stdout).toMatch(/listening on http:\/\/localhost:\d+/), {
      timeout: 20_000,
      interval: 50,
    });
    const port = /localhost:(\d+)/.exec(stdout)?.[1];

    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` },
    });
    expect(response.status).toBe(200);

    await vi.waitFor(
      () => expect(records(stdout).some((record) => record.msg === "request completed")).toBe(true),
      { timeout: 5_000, interval: 20 },
    );
    const completed = records(stdout).find((record) => record.msg === "request completed");
    expect(completed).toMatchObject({
      "service.name": "scos-api-bundle-test",
      trace_id: TRACE_ID,
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      trace_flags: "01",
      "http.route": "/health",
      "http.response.status_code": 200,
    });
    expect(completed?.span_id).not.toBe("00f067aa0ba902b7");
    // The startup record has no active span, so no correlation fields.
    expect(records(stdout)[0]).not.toHaveProperty("trace_id");

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(stdout + stderr).not.toContain("leaky-password");
  });
});
