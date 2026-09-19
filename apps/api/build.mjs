// Bundles the API into ESM files for Node.js and AWS Lambda. Workspace
// packages and third-party runtime dependencies are inlined, except Pino
// (loaded at runtime; see `external`): the runtime artifact must ship
// `node_modules/pino` and its dependencies next to the bundle (docs/observability.md, "Runtime artifact").
import { rm } from "node:fs/promises";

import { build } from "esbuild";

// Add a Lambda handler here alongside the local listener when one exists.
const entryPoints = ["src/server.ts"];

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

const result = await build({
  entryPoints,
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  external,
  // Bundled CommonJS dependencies such as pg call require() for Node.js
  // built-ins, which ESM output does not provide.
  banner: {
    // Aliased so it cannot clash with the source's own `createRequire` import.
    js: 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);',
  },
  logLevel: "info",
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs).filter(([file]) => file.endsWith(".js"));
for (const [file, output] of outputs) {
  const imports = output.imports.filter((entry) => entry.external).map((entry) => entry.path);
  console.log(`${file}: external imports ${[...new Set(imports)].sort().join(", ")}`);
}
