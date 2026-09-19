// Bundles the API into ESM files for Node.js and AWS Lambda. Workspace
// packages and third-party runtime dependencies are inlined, except Pino
// (loaded at runtime; see `external`): the runtime artifact must ship
// `node_modules/pino` and its dependencies next to the bundle (docs/observability.md, "Runtime artifact").
//
// Then writes the OpenAPI document to dist/openapi.json, a build artifact
// that is not committed: the exporter CLI (scripts/openapi.ts) is bundled
// with the same settings to a temporary file outside dist/ and run with
// Node.js, without DATABASE_URL. It builds the combined app over stub use
// cases, so the file is the exact bytes GET /openapi.json serves; it is
// deterministic and needs no server or database. The exporter is a separate
// bundle, so none of it is added to dist/node.js.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "esbuild";

// One entry per runtime, named after it: src/entrypoints/node.ts is the local
// Node server. Add the Lambda handlers (src/entrypoints/lambda*.ts, #14) here.
const entryPoints = ["src/entrypoints/node.ts"];

// - pg loads pg-native only when the native client is requested; it is an
//   optional native addon that is not installed and cannot be bundled.
// - pino: what keeps Pino out of the bundle is the
//   `createRequire(import.meta.url)("pino")` call in
//   src/telemetry/node/pino-logger.ts, which esbuild does not follow. It runs
//   after OpenTelemetry's PinoInstrumentation has hooked require; a bundled
//   copy would bypass that hook and lose trace correlation. This entry is
//   only a backstop in case pino is ever imported statically (the output is
//   identical without it today).
// - hono-openapi converts schemas through @standard-community adapters that
//   lazily import() the converter of each schema library they support. The
//   API uses Zod 4 only (converted by Zod itself), so the other adapters never
//   run; left external, `effect` (installed for Prisma) is not bundled for
//   nothing.
const optionalSchemaVendors = [
  "effect",
  "arktype",
  "typebox",
  "valibot",
  "@valibot/to-json-schema",
  "sury",
  "zod-openapi",
  "zod-to-json-schema",
];
const external = ["pg-native", "pino", ...optionalSchemaVendors];

await rm("dist", { recursive: true, force: true });

const bundleOptions = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external,
  // Bundled CommonJS dependencies such as pg call require() for Node.js
  // built-ins, which ESM output does not provide.
  banner: {
    // Aliased so it cannot clash with the source's own `createRequire` import.
    js: 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);',
  },
};

const result = await build({
  ...bundleOptions,
  entryPoints,
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs).filter(([file]) => file.endsWith(".js"));
for (const [file, output] of outputs) {
  const imports = output.imports.filter((entry) => entry.external).map((entry) => entry.path);
  console.log(`${file}: external imports ${[...new Set(imports)].sort().join(", ")}`);
}

const openApiPath = resolve("dist/openapi.json");
const exporterDirectory = await mkdtemp(join(tmpdir(), "scos-openapi-"));
try {
  const exporter = join(exporterDirectory, "openapi.mjs");
  await build({
    ...bundleOptions,
    entryPoints: ["scripts/openapi.ts"],
    outfile: exporter,
    logLevel: "warning",
  });
  const { DATABASE_URL: _unused, ...environment } = process.env;
  execFileSync(process.execPath, [exporter, openApiPath], { env: environment, stdio: "inherit" });
} finally {
  await rm(exporterDirectory, { recursive: true, force: true });
}
