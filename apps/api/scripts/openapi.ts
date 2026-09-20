/**
 * CLI for the OpenAPI export: writes the document served at
 * `GET /openapi.json` to the given path, or to `apps/api/dist/openapi.json`.
 * Needs no server, environment or database. `pnpm openapi:export` runs it
 * with tsx; the build (`build.mjs`) bundles it with esbuild and runs it with
 * an explicit path. The logic is in `src/openapi/export.ts`.
 *
 * @module
 */

import { OPENAPI_USAGE, exportArguments, exportOpenApiDocument, exportPath } from "#openapi/export";

const [argument, ...extra] = exportArguments(process.argv.slice(2));
if (extra.length > 0 || argument === "--help" || argument === "-h") {
  console.error(OPENAPI_USAGE);
  process.exitCode = 2;
} else {
  const path = exportPath(argument, process.cwd());
  await exportOpenApiDocument(path);
  console.log(`Wrote ${path}`);
}
