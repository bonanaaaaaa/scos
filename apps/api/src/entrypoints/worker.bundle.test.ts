/**
 * Guards the Worker bundle Wrangler builds from wrangler.jsonc
 * (`wrangler deploy --dry-run`, no Cloudflare account): Node-only telemetry
 * (Pino, the Node OTLP exporters, instrumentation, the async-hooks context
 * manager, the Node server) is not in it, Prisma uses its edge runtime with
 * the query compiler as a separate WebAssembly module, and the upload stays
 * well within the Workers size limit.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const apiDirectory = fileURLToPath(new URL("../..", import.meta.url));
const wrangler = join(apiDirectory, "node_modules/.bin/wrangler");

/** The Workers limit: 64 MiB uncompressed on every plan (no compressed limit since 2026-09-04). */
const WORKER_SIZE_LIMIT = 64 * 1024 * 1024;
/**
 * This project's own budget, far below the limit: about 5.4 MiB today
 * (docs/observability.md). A jump past it means a dependency slipped in,
 * such as the `effect` library the alias in wrangler.jsonc keeps out, and
 * costs startup time (1 s limit for the global scope).
 */
const SIZE_BUDGET = 8 * 1024 * 1024;
/** Compressed size, kept under the retired 3 MB Free-plan limit as a second budget. */
const COMPRESSED_BUDGET = 3 * 1024 * 1024;

interface Metafile {
  readonly inputs: Record<string, unknown>;
}

let outdir: string;
let inputs: string[];

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), "scos-worker-bundle-"));
  await promisify(execFile)(
    wrangler,
    ["deploy", "--dry-run", "--outdir", outdir, "--metafile", join(outdir, "meta.json")],
    {
      cwd: apiDirectory,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
      timeout: 90_000,
    },
  );
  const metafile = JSON.parse(await readFile(join(outdir, "meta.json"), "utf8")) as Metafile;
  inputs = Object.keys(metafile.inputs);
}, 120_000);

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true });
});

/** The package an input path belongs to, from its last node_modules segment. */
function packageOf(input: string): string | undefined {
  const match = /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
  return match?.[1];
}

describe("the Worker bundle (wrangler deploy --dry-run)", () => {
  test("contains no Node-only telemetry, Node server or unused schema libraries", () => {
    const packages = new Set(inputs.map(packageOf).filter((name) => name !== undefined));
    for (const name of packages) {
      expect(
        /^(?:pino.*|@opentelemetry\/(?:context-async-hooks|sdk-node|instrumentation.*|exporter-.*)|@hono\/node-server|effect|fast-check)$/.test(
          name,
        ),
        name,
      ).toBe(false);
    }
    expect(packages).toContain("@opentelemetry/sdk-trace");
    expect(packages).toContain("@opentelemetry/sdk-metrics");
    expect(packages).toContain("@opentelemetry/otlp-transformer");
    expect(inputs.some((input) => input.includes("src/telemetry/node/"))).toBe(false);
    expect(inputs.some((input) => input.endsWith("src/telemetry/workers/sdk.ts"))).toBe(true);
  });

  test("uses Prisma's edge runtime and imports the query compiler as WebAssembly", async () => {
    expect(
      inputs.some((input) => input.includes("@prisma/client/runtime/wasm-compiler-edge")),
    ).toBe(true);
    expect(inputs.some((input) => /@prisma\/client\/runtime\/client\.m?js$/.test(input))).toBe(
      false,
    );
    const files = await readdir(outdir);
    expect(files.filter((file) => file.endsWith(".wasm"))).toHaveLength(1);
  });

  test("the upload is within the Workers size limit and this project's budget", async () => {
    const files = (await readdir(outdir)).filter(
      (file) => file.endsWith(".js") || file.endsWith(".wasm"),
    );
    let uncompressed = 0;
    let compressed = 0;
    for (const file of files) {
      const content = await readFile(join(outdir, file));
      uncompressed += content.byteLength;
      compressed += gzipSync(content).byteLength;
    }
    expect(uncompressed).toBeLessThan(WORKER_SIZE_LIMIT);
    expect(uncompressed).toBeLessThan(SIZE_BUDGET);
    expect(compressed).toBeLessThan(COMPRESSED_BUDGET);
  });
});
