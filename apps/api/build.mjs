// Bundles the API into self-contained ESM files for Node.js and AWS Lambda.
// Workspace packages and third-party runtime dependencies are inlined so each
// output file runs without node_modules. That includes Prisma's query
// compiler: the generated client imports it as JavaScript modules (the WASM
// travels as base64 inside one of them), so there are no engine files to copy.
//
// - dist/server.js: the local listener (src/server.ts).
// - dist/lambda/<name>/index.mjs: one Lambda handler per endpoint
//   (src/lambda/<name>.ts, handler `index.handler`). `package:lambda` zips
//   each directory (scripts/package-lambda.mjs).
import { builtinModules } from "node:module";
import { rm } from "node:fs/promises";

import { build } from "esbuild";

import { LAMBDA_FUNCTIONS } from "./build.config.mjs";

// pg loads pg-native only when the native client is requested; it is an
// optional native addon that is not installed and cannot be bundled.
const external = ["pg-native"];

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  external,
  // Bundled CommonJS dependencies such as pg call require() for Node.js
  // built-ins, which ESM output does not provide.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "info",
  metafile: true,
};

await rm("dist", { recursive: true, force: true });

const results = [
  await build({ ...shared, entryPoints: ["src/server.ts"], outdir: "dist" }),
  await build({
    ...shared,
    entryPoints: Object.fromEntries(
      LAMBDA_FUNCTIONS.map((name) => [`lambda/${name}/index`, `src/lambda/${name}.ts`]),
    ),
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
  }),
];

for (const result of results) {
  const outputs = Object.entries(result.metafile.outputs).filter(([file]) => /\.m?js$/.test(file));
  for (const [file, output] of outputs) {
    const imports = [
      ...new Set(output.imports.filter((entry) => entry.external).map((entry) => entry.path)),
    ].sort();
    console.log(`${file}: external imports ${imports.join(", ")}`);
    // Anything else would need node_modules at run time.
    const unexpected = imports.filter((path) => !builtins.has(path) && !external.includes(path));
    if (unexpected.length > 0) {
      throw new Error(`${file} imports packages that are not bundled: ${unexpected.join(", ")}`);
    }
  }
}
