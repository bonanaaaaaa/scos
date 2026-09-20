/**
 * Runtime-neutral modules (the Hono apps, HTTP helpers, configuration,
 * telemetry ports, decorators and middleware) must not import anything
 * specific to one runtime, so the Node/Lambda and Cloudflare Workers
 * compositions reuse them unchanged. Node/Lambda wiring lives in
 * `composition/node.ts`, `entrypoints/node.ts` and `telemetry/node/`;
 * Workers wiring in `composition/worker.ts`, `entrypoints/worker*.ts` and
 * `telemetry/workers/`. Neither runtime may reach the other's modules, directly
 * or through any module it imports.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") && !/\.test(-support)?\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Module paths (relative to src/) that must stay runtime-neutral. */
function isNeutral(path: string): boolean {
  return (
    ["app.ts", "routes.ts", "config.ts", "composition/composed-application.ts"].includes(path) ||
    path.startsWith("http/") ||
    /^endpoints\/[^/]+\/(?:app|contract|messages|serializers|config)\.ts$/.test(path) ||
    /^telemetry\/(?:decorators\/)?[^/]+\.ts$/.test(path)
  );
}

const FORBIDDEN: readonly [string, RegExp][] = [
  ["Node.js built-in", /from\s+["']node:|require\(/],
  ["Pino", /from\s+["']pino["']/],
  [
    "OpenTelemetry SDK, exporter, context manager or instrumentation",
    /from\s+["']@opentelemetry\/(?!api["']|semantic-conventions["'])/,
  ],
  ["database client", /from\s+["'](?:pg|@prisma\/[^"']+|@scos\/persistence)["']/],
  ["Node server", /from\s+["']@hono\/node-server/],
  ["environment read", /process\.env/],
];

const neutral = sources(sourceDirectory)
  .map((path) => relative(sourceDirectory, path).split("\\").join("/"))
  .filter(isNeutral);

describe("runtime-neutral modules", () => {
  test("the boundary covers the apps, HTTP helpers and telemetry ports", () => {
    expect(neutral).toEqual(
      expect.arrayContaining([
        "app.ts",
        "composition/composed-application.ts",
        "http/logger.ts",
        "endpoints/submit-order/app.ts",
        "telemetry/decorators/inventory-reader.ts",
        "telemetry/decorators/span.ts",
        "telemetry/decorators/submission-store.ts",
        "telemetry/decorators/submit-order.ts",
        "telemetry/decorators/verify-order.ts",
        "telemetry/http.ts",
        "telemetry/log-record.ts",
        "telemetry/telemetry.ts",
      ]),
    );
    expect(neutral.some((path) => path.startsWith("telemetry/node/"))).toBe(false);
    expect(neutral.some((path) => path.startsWith("telemetry/workers/"))).toBe(false);
  });

  test.each(neutral)("%s imports nothing runtime-specific", (path) => {
    const text = readFileSync(join(sourceDirectory, path), "utf8");
    for (const [what, pattern] of FORBIDDEN) {
      expect(pattern.test(text), `${path} must not use a ${what}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Node/Lambda versus Cloudflare Workers
// ---------------------------------------------------------------------------

const all = sources(sourceDirectory).map((path) =>
  relative(sourceDirectory, path).split("\\").join("/"),
);

function isWorkersOnly(path: string): boolean {
  return (
    path.startsWith("telemetry/workers/") ||
    path === "composition/worker.ts" ||
    /^entrypoints\/worker(?:\.[^/]+)?\.ts$/.test(path)
  );
}

function isNodeOnly(path: string): boolean {
  return (
    path.startsWith("telemetry/node/") ||
    path === "composition/node.ts" ||
    /^entrypoints\/node(?:\.[^/]+)?\.ts$/.test(path)
  );
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

/** Every specifier `path` imports (static, re-export or dynamic). */
function specifiers(path: string): string[] {
  const text = readFileSync(join(sourceDirectory, path), "utf8");
  return [...text.matchAll(IMPORT)].map((match) => match[1] as string);
}

/**
 * The src/-relative module a specifier names, if it is one of ours: a folder
 * mate ("./contract") or this package's own "#<path under src>" (package.json
 * "imports"; docs/architecture.md, "Module specifiers"). Anything else is a
 * package.
 */
function resolveLocal(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith("#") && !specifier.startsWith(".")) {
    return undefined;
  }
  const base = specifier.startsWith("#")
    ? specifier.slice(1)
    : join(dirname(from), specifier).split("\\").join("/");
  return [`${base}.ts`, `${base}/index.ts`].find((candidate) =>
    existsSync(join(sourceDirectory, candidate)),
  );
}

/** `entry` and every local module it reaches, with the packages each imports. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (seen.has(path)) {
      continue;
    }
    const found = specifiers(path);
    seen.set(
      path,
      found.filter((specifier) => !specifier.startsWith("#") && !specifier.startsWith(".")),
    );
    for (const specifier of found) {
      const local = resolveLocal(path, specifier);
      if (local !== undefined) {
        pending.push(local);
      }
    }
  }
  return seen;
}

/** Packages that assume a Node.js process: never in the Worker. */
const NODE_ONLY_PACKAGES =
  /^(?:pino(?:\/.*)?|@opentelemetry\/(?:context-async-hooks|sdk-node|auto-instrumentations-node|instrumentation(?:-.*)?|exporter-[^/]+)|@hono\/node-server)$/;

describe("the Workers runtime never loads Node-only telemetry", () => {
  const workersModules = all.filter(isWorkersOnly);

  test("the Workers modules exist where the boundary expects them", () => {
    expect(workersModules).toEqual(
      expect.arrayContaining([
        "composition/worker.ts",
        "entrypoints/worker.ts",
        "telemetry/workers/context.ts",
        "telemetry/workers/otlp-exporter.ts",
        "telemetry/workers/sdk.ts",
      ]),
    );
  });

  test("from the Worker entrypoint, no Node-only module or package is reachable", () => {
    const graph = reachable("entrypoints/worker.ts");
    // Both specifier forms are followed: "#telemetry/workers/sdk" from the
    // entry point, and that module's folder mate "./context". A walk that
    // stopped at either would leave the checks below with nothing to reject.
    expect(graph.has("telemetry/workers/sdk.ts")).toBe(true);
    expect(graph.has("telemetry/workers/context.ts")).toBe(true);
    for (const [path, packages] of graph) {
      expect(isNodeOnly(path), `${path} is Node-only`).toBe(false);
      for (const name of packages) {
        expect(NODE_ONLY_PACKAGES.test(name), `${path} imports ${name}`).toBe(false);
      }
    }
  });

  test.each(workersModules)("%s imports no Node-only module or package", (path) => {
    for (const specifier of specifiers(path)) {
      const local = resolveLocal(path, specifier);
      if (local === undefined) {
        expect(NODE_ONLY_PACKAGES.test(specifier), `${path} imports ${specifier}`).toBe(false);
      } else {
        expect(isNodeOnly(local), `${path} imports ${local}`).toBe(false);
      }
    }
  });
});

describe("the Node runtime never loads Workers modules", () => {
  test.each(["entrypoints/node.ts", "composition/node.ts", "telemetry/node/sdk.ts"])(
    "nothing reachable from %s is Workers-only",
    (entry) => {
      for (const path of reachable(entry).keys()) {
        expect(isWorkersOnly(path), `${entry} reaches ${path}`).toBe(false);
      }
    },
  );

  test.each(all.filter(isNodeOnly))("%s imports no Workers module", (path) => {
    for (const specifier of specifiers(path)) {
      const local = resolveLocal(path, specifier);
      expect(local !== undefined && isWorkersOnly(local), `${path} imports ${local}`).toBe(false);
      expect(specifier.startsWith("cloudflare:"), `${path} imports ${specifier}`).toBe(false);
    }
  });
});
