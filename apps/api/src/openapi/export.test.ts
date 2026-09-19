import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { renderOpenApiDocument } from "./offline";
import {
  OPENAPI_EXPORT_FILE,
  OPENAPI_EXPORT_PATH,
  type OpenApiFiles,
  nodeOpenApiFiles,
  parseOpenApiCommand,
  runOpenApiCommand,
} from "./export";

function memoryFiles(initial: Record<string, string> = {}): OpenApiFiles & {
  readonly contents: Map<string, string>;
} {
  const contents = new Map(Object.entries(initial));
  return {
    contents,
    read: async (path) => contents.get(path),
    write: async (path, content) => {
      contents.set(path, content);
    },
  };
}

describe("committed export", () => {
  test("docs/openapi.json matches the regenerated document byte for byte", async () => {
    expect(OPENAPI_EXPORT_PATH.endsWith(OPENAPI_EXPORT_FILE)).toBe(true);
    const committed = await readFile(OPENAPI_EXPORT_PATH, "utf8");
    expect(
      committed === (await renderOpenApiDocument()),
      `${OPENAPI_EXPORT_FILE} is out of date: run \`pnpm openapi:export\` and commit it.`,
    ).toBe(true);
    await expect(runOpenApiCommand("check", OPENAPI_EXPORT_PATH)).resolves.toMatchObject({
      exitCode: 0,
    });
  });
});

describe("openapi command", () => {
  test("parses the two commands only", () => {
    expect(parseOpenApiCommand("export")).toBe("export");
    expect(parseOpenApiCommand("check")).toBe("check");
    expect(parseOpenApiCommand(undefined)).toBeUndefined();
    expect(parseOpenApiCommand("write")).toBeUndefined();
  });

  test("export writes the rendered document; two runs are identical", async () => {
    const files = memoryFiles();
    await expect(runOpenApiCommand("export", "a.json", files)).resolves.toStrictEqual({
      exitCode: 0,
      message: "Wrote a.json",
    });
    const first = files.contents.get("a.json");
    await runOpenApiCommand("export", "a.json", files);
    expect(files.contents.get("a.json")).toBe(first);
    expect(first).toBe(await renderOpenApiDocument());
    expect(first?.endsWith("}\n")).toBe(true);
  });

  test("check passes on the exported file", async () => {
    const files = memoryFiles({ "a.json": await renderOpenApiDocument() });
    await expect(runOpenApiCommand("check", "a.json", files)).resolves.toStrictEqual({
      exitCode: 0,
      message: "a.json is up to date.",
    });
  });

  test("check fails on a mutated file and names the first differing line", async () => {
    const lines = (await renderOpenApiDocument()).split("\n");
    lines[3] = `${lines[3]} `;
    const files = memoryFiles({ "a.json": lines.join("\n") });
    const result = await runOpenApiCommand("check", "a.json", files);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("line 4");
    expect(result.message).toContain("pnpm openapi:export");
  });

  test("check fails when content is only reformatted or truncated", async () => {
    const reformatted = `${JSON.stringify(JSON.parse(await renderOpenApiDocument()))}\n`;
    const truncated = (await renderOpenApiDocument()).trimEnd();
    for (const content of [reformatted, truncated]) {
      const result = await runOpenApiCommand("check", "a.json", memoryFiles({ "a.json": content }));
      expect(result.exitCode).toBe(1);
    }
  });

  test("check fails when the file is missing", async () => {
    const result = await runOpenApiCommand("check", "missing.json", memoryFiles());
    expect(result).toStrictEqual({
      exitCode: 1,
      message: "missing.json does not exist. Run `pnpm openapi:export` and commit the result.",
    });
  });
});

describe("node files", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "scos-openapi-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("write then read round-trips; a missing file reads as undefined", async () => {
    const path = join(directory, "openapi.json");
    await expect(nodeOpenApiFiles.read(path)).resolves.toBeUndefined();
    await nodeOpenApiFiles.write(path, "{}\n");
    await expect(nodeOpenApiFiles.read(path)).resolves.toBe("{}\n");
  });

  test("other read errors propagate", async () => {
    await expect(nodeOpenApiFiles.read(directory)).rejects.toMatchObject({ code: "EISDIR" });
  });

  test("export and check against a real file", async () => {
    const path = join(directory, "openapi.json");
    await runOpenApiCommand("export", path);
    await expect(runOpenApiCommand("check", path)).resolves.toMatchObject({ exitCode: 0 });
  });
});
