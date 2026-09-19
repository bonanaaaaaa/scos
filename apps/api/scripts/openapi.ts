/**
 * CLI for the OpenAPI export: `tsx scripts/openapi.ts export` writes
 * `docs/openapi.json` from the route contracts; `check` exits 1 when the
 * committed file differs from regenerated output. Needs no server,
 * environment or database. The logic is in `src/openapi/export.ts`.
 *
 * @module
 */

import {
  OPENAPI_EXPORT_PATH,
  OPENAPI_USAGE,
  parseOpenApiCommand,
  runOpenApiCommand,
} from "../src/openapi/export";

const command = parseOpenApiCommand(process.argv[2]);
if (command === undefined) {
  console.error(OPENAPI_USAGE);
  process.exitCode = 2;
} else {
  const result = await runOpenApiCommand(command, OPENAPI_EXPORT_PATH);
  (result.exitCode === 0 ? console.log : console.error)(result.message);
  process.exitCode = result.exitCode;
}
