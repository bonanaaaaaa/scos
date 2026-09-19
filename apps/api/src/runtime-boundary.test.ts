/**
 * Runtime-neutral modules (the Hono apps, HTTP helpers, configuration,
 * telemetry ports, decorators and middleware) must not import anything
 * specific to one runtime, so a Workers composition (follow-up PR under #17)
 * can reuse them unchanged. Node/Lambda wiring lives in the compositions,
 * `composition/`, `entrypoints/` and `telemetry/node/`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
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
  });

  test.each(neutral)("%s imports nothing runtime-specific", (path) => {
    const text = readFileSync(join(sourceDirectory, path), "utf8");
    for (const [what, pattern] of FORBIDDEN) {
      expect(pattern.test(text), `${path} must not use a ${what}`).toBe(false);
    }
  });
});
