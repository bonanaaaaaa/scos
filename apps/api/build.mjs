// Bundles the API into self-contained ESM files for Node.js and AWS Lambda.
// Workspace packages and third-party runtime dependencies are inlined so each
// output file runs without node_modules.
import { rm } from "node:fs/promises";

import { build } from "esbuild";

// Add a Lambda handler here alongside the local listener when one exists.
const entryPoints = ["src/server.ts"];

// pg loads pg-native only when the native client is requested; it is an
// optional native addon that is not installed and cannot be bundled.
const external = ["pg-native"];

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
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "info",
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs).filter(([file]) => file.endsWith(".js"));
for (const [file, output] of outputs) {
  const imports = output.imports.filter((entry) => entry.external).map((entry) => entry.path);
  console.log(`${file}: external imports ${[...new Set(imports)].sort().join(", ")}`);
}

// @scos/persistence/testing is the integration-test harness (it shells out to
// the Prisma CLI); runtime code must never import it.
const testHarness = /persistence\/(?:dist|src)\/testing\.[jt]s$/;
const bundledHarness = Object.keys(result.metafile.inputs).filter((input) =>
  testHarness.test(input),
);
if (bundledHarness.length > 0) {
  throw new Error(
    `The API bundle includes the test harness (${bundledHarness.join(", ")}); ` +
      "import @scos/persistence/testing only from tests.",
  );
}
