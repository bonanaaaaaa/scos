/**
 * The offline export of the OpenAPI document: the exact bytes served at
 * `GET /openapi.json`, written to a file with no server, environment or
 * database. The API build writes it to `apps/api/dist/openapi.json` (a build
 * artifact, not committed); `pnpm openapi:export` does the same on demand.
 *
 * The logic lives here so unit tests cover it; `scripts/openapi.ts` only
 * wires it to the process.
 *
 * @module
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderOpenApiDocument } from "./offline";

/** The export's location relative to `apps/api`. */
export const OPENAPI_EXPORT_FILE = "dist/openapi.json";

/**
 * Absolute path of the default export in this checkout, from this module's
 * location in `src/openapi/`. A bundled copy of the exporter (the build's)
 * must be given the path explicitly.
 */
export const OPENAPI_EXPORT_PATH = fileURLToPath(
  new URL(`../../${OPENAPI_EXPORT_FILE}`, import.meta.url),
);

export const OPENAPI_USAGE = "Usage: openapi [output-path]  (default: apps/api/dist/openapi.json)";

/** The CLI arguments, without the `--` separator pnpm forwards as-is. */
export function exportArguments(argv: readonly string[]): readonly string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

/** Where to write: the optional argument, resolved against `cwd`, else the default. */
export function exportPath(argument: string | undefined, cwd: string): string {
  return argument === undefined ? OPENAPI_EXPORT_PATH : resolve(cwd, argument);
}

export type WriteFile = (path: string, content: string) => Promise<void>;

/** UTF-8 on disk, creating the directory (such as `dist/`) when missing. */
export const writeFileCreatingDirectory: WriteFile = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
};

/** Writes the rendered document to `path` and returns what was written. */
export async function exportOpenApiDocument(
  path: string,
  write: WriteFile = writeFileCreatingDirectory,
): Promise<string> {
  const content = await renderOpenApiDocument();
  await write(path, content);
  return content;
}
