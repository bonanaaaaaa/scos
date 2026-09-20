import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createApp } from "#app";
import { fakeLogger } from "#testing/fixtures.test-support";
import { noSubmit, noVerify } from "#testing/requests.test-support";

import {
  OPENAPI_EXPORT_FILE,
  OPENAPI_EXPORT_PATH,
  exportArguments,
  exportOpenApiDocument,
  exportPath,
  writeFileCreatingDirectory,
} from "./export";
import { renderOpenApiDocument } from "./offline";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "scos-openapi-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("openapi export", () => {
  test("writes exactly the bytes GET /openapi.json serves", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    try {
      const path = join(directory, "openapi.json");
      await exportOpenApiDocument(path);
      const app = createApp({ verifyOrder: noVerify, submitOrder: noSubmit, logger: fakeLogger() });
      const served = await (await app.request("/openapi.json")).text();
      expect(await readFile(path, "utf8")).toBe(served);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("two exports are byte-identical, with two-space JSON and a trailing newline", async () => {
    const first = join(directory, "first.json");
    const second = join(directory, "second.json");
    const written = await exportOpenApiDocument(first);
    await exportOpenApiDocument(second);
    expect(await readFile(second, "utf8")).toBe(await readFile(first, "utf8"));
    expect(written).toBe(await renderOpenApiDocument());
    expect(written).toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
  });

  test("creates the output directory (dist/ before the first build) and overwrites", async () => {
    const path = join(directory, "dist", "nested", "openapi.json");
    await writeFileCreatingDirectory(path, "stale\n");
    await exportOpenApiDocument(path);
    expect(await readFile(path, "utf8")).toBe(await renderOpenApiDocument());
  });

  test("passes the rendered document to the writer", async () => {
    const writes: [string, string][] = [];
    const written = await exportOpenApiDocument("out.json", async (path, content) => {
      writes.push([path, content]);
    });
    expect(writes).toStrictEqual([["out.json", written]]);
  });

  test("a write failure propagates", async () => {
    const blocker = join(directory, "file");
    await writeFile(blocker, "");
    await expect(exportOpenApiDocument(join(blocker, "openapi.json"))).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|EEXIST)$/),
    });
  });
});

describe("export path", () => {
  test("defaults to apps/api/dist/openapi.json", () => {
    expect(OPENAPI_EXPORT_FILE).toBe("dist/openapi.json");
    expect(OPENAPI_EXPORT_PATH.endsWith(join("apps", "api", "dist", "openapi.json"))).toBe(true);
    expect(exportPath(undefined, "/anywhere")).toBe(OPENAPI_EXPORT_PATH);
  });

  test("a leading -- (forwarded by pnpm) is ignored", () => {
    expect(exportArguments(["--", "out.json"])).toStrictEqual(["out.json"]);
    expect(exportArguments(["out.json"])).toStrictEqual(["out.json"]);
    expect(exportArguments([])).toStrictEqual([]);
  });

  test("an argument is resolved against the working directory", () => {
    expect(exportPath("out/spec.json", "/work")).toBe("/work/out/spec.json");
    expect(exportPath("/abs/spec.json", "/work")).toBe("/abs/spec.json");
  });
});
