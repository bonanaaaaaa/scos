/**
 * The offline export of the OpenAPI document to `docs/openapi.json`, and the
 * drift check that compares the committed file with regenerated output. No
 * server, environment or database is involved.
 *
 * The command logic lives here so unit tests cover it; `scripts/openapi.ts`
 * only wires it to the process (`pnpm openapi:export`, `pnpm openapi:check`).
 *
 * @module
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { renderOpenApiDocument } from "./offline";

/** The export's location relative to the repository root. */
export const OPENAPI_EXPORT_FILE = "docs/openapi.json";

/** Absolute path of the committed export in this checkout. */
export const OPENAPI_EXPORT_PATH = fileURLToPath(
  new URL(`../../../../${OPENAPI_EXPORT_FILE}`, import.meta.url),
);

export type OpenApiCommand = "export" | "check";

export interface OpenApiFiles {
  /** The file's content, or `undefined` if it does not exist. */
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
}

export interface OpenApiCommandResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
}

export const OPENAPI_USAGE = "Usage: openapi <export|check>";

export function parseOpenApiCommand(argument: string | undefined): OpenApiCommand | undefined {
  return argument === "export" || argument === "check" ? argument : undefined;
}

/** UTF-8 files on disk; a missing file reads as `undefined`. */
export const nodeOpenApiFiles: OpenApiFiles = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  async write(path, content) {
    await writeFile(path, content, "utf8");
  },
};

/** 1-based number of the first line that differs, for the drift message. */
function firstDifferentLine(expected: string, actual: string): number {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const index = expectedLines.findIndex((line, position) => line !== actualLines[position]);
  return (index === -1 ? expectedLines.length : index) + 1;
}

/**
 * `export` writes the regenerated document to `path`. `check` compares
 * `path` with it byte for byte and fails (exit code 1) if the file is
 * missing or differs.
 */
export async function runOpenApiCommand(
  command: OpenApiCommand,
  path: string,
  files: OpenApiFiles = nodeOpenApiFiles,
): Promise<OpenApiCommandResult> {
  const expected = await renderOpenApiDocument();
  if (command === "export") {
    await files.write(path, expected);
    return { exitCode: 0, message: `Wrote ${path}` };
  }
  const actual = await files.read(path);
  if (actual === undefined) {
    return {
      exitCode: 1,
      message: `${path} does not exist. Run \`pnpm openapi:export\` and commit the result.`,
    };
  }
  if (actual !== expected) {
    return {
      exitCode: 1,
      message: `${path} is out of date with the route contracts (first difference at line ${firstDifferentLine(expected, actual)}). Run \`pnpm openapi:export\` and commit the result.`,
    };
  }
  return { exitCode: 0, message: `${path} is up to date.` };
}
