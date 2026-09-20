/**
 * The "workerd" build (package.json "exports", tsdown.config.ts) that
 * Cloudflare Workers resolve: the same adapters over the workerd Prisma
 * client, so the errors, decimals and isolation levels the adapters use come
 * from the same runtime as the client. Reads the built output; `pnpm test`
 * builds first (turbo `test` depends on `build`).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const workerdEntry = `${packageDirectory}dist/workerd/index.js`;

describe("the workerd build", () => {
  test("is what the workerd condition resolves to", () => {
    const manifest = JSON.parse(readFileSync(`${packageDirectory}package.json`, "utf8")) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(manifest.exports["."]?.workerd).toBe("./dist/workerd/index.js");
    expect(Object.keys(manifest.exports["."] ?? {}).indexOf("workerd")).toBeLessThan(
      Object.keys(manifest.exports["."] ?? {}).indexOf("import"),
    );
  });

  test("uses only Prisma's edge runtime and imports the query compiler as a module", () => {
    expect(existsSync(workerdEntry), "run `pnpm --filter @scos/persistence build` first").toBe(
      true,
    );
    const source = readFileSync(workerdEntry, "utf8");
    expect(source).toContain('from "@prisma/client/runtime/wasm-compiler-edge"');
    expect(source).not.toContain("@prisma/client/runtime/client");
    expect(source).not.toContain("wasm-base64");
    expect(source).toContain('import("./query_compiler_fast_bg.wasm?module")');
    expect(existsSync(`${packageDirectory}dist/workerd/query_compiler_fast_bg.wasm`)).toBe(true);
    // The Node build is untouched.
    expect(readFileSync(`${packageDirectory}dist/index.js`, "utf8")).toContain(
      '"@prisma/client/runtime/client"',
    );
  });

  test("exports the same public API as the Node build", async () => {
    const node = await import("#index");
    const exported = [...readFileSync(workerdEntry, "utf8").matchAll(/export \{([^}]*)\}/g)]
      .flatMap((match) => (match[1] ?? "").split(","))
      .map(
        (part) =>
          part
            .trim()
            .split(/\s+as\s+/)
            .at(-1) ?? "",
      )
      .filter((name) => name.length > 0);
    expect(new Set(exported)).toStrictEqual(new Set(Object.keys(node)));
  });
});
