// Generate the Wrangler configuration the deploy workflow uses, from the
// committed apps/api/wrangler.jsonc, and validate the Worker configuration it
// will run with before anything is uploaded.
//
// Run with tsx from apps/api, so the API's own Zod schema can be imported:
//
//   pnpm --filter @scos/api exec tsx ../../infra/cloudflare/scripts/worker-deploy-config.mjs \
//     --bundle <dir> --hyperdrive-id <32 hex> --out <file>
//
// The generated configuration differs from the committed one only in what a
// deployment needs:
//   - `main` is the already built bundle, uploaded with `no_bundle`, so what
//     is deployed is exactly the bundle whose checksum was recorded;
//   - the HYPERDRIVE binding's placeholder ID becomes the ID Terraform output,
//     and the local-only `localConnectionString` is dropped;
//   - non-secret telemetry `vars` come from the environment (allow-list below);
//   - the placement hint (WORKER_PLACEMENT_REGION, default aws:ap-southeast-1,
//     `none` to omit).
// Nothing secret is written: OTEL_EXPORTER_OTLP_HEADERS is only validated
// here, then uploaded as a Worker secret by the workflow.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PLACEHOLDER_ID = "00000000000000000000000000000000";
const DEFAULT_PLACEMENT_REGION = "aws:ap-southeast-1";

/** Worker `vars` the pipeline may set from its environment. Never a secret. */
const VAR_NAMES = [
  "DEPLOYMENT_ENVIRONMENT",
  "SERVICE_VERSION",
  "OTEL_SERVICE_NAME",
  "OTEL_SDK_DISABLED",
  "LOG_LEVEL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
];
const SECRET_NAMES = ["OTEL_EXPORTER_OTLP_HEADERS"];

function fail(message) {
  console.error(`worker-deploy-config: ${message}`);
  process.exit(1);
}

/** JSONC to JSON: drops comments and trailing commas, leaving strings intact. */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      i += 1;
    }
  }
  // Trailing commas before a closing bracket (outside strings: strings in
  // this file never contain `,}` or `,]`; JSON.parse fails loudly if one did).
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "wrangler.jsonc" },
    bundle: { type: "string" },
    "hyperdrive-id": { type: "string" },
    out: { type: "string" },
  },
});
if (!values.bundle || !values["hyperdrive-id"] || !values.out) {
  fail("usage: --bundle <dir> --hyperdrive-id <id> --out <file> [--source wrangler.jsonc]");
}

const hyperdriveId = values["hyperdrive-id"];
if (!/^[0-9a-f]{32}$/.test(hyperdriveId) || hyperdriveId === PLACEHOLDER_ID) {
  fail("the Hyperdrive ID must be 32 lowercase hex characters and not the placeholder.");
}

const source = resolve(values.source);
const out = resolve(values.out);
const bundle = resolve(values.bundle);
if (!existsSync(join(bundle, "worker.js"))) {
  fail(`no worker.js in ${bundle}; build the bundle first.`);
}

const config = parseJsonc(readFileSync(source, "utf8"));

// The committed file must still have exactly one HYPERDRIVE binding with the
// placeholder ID: anything else means the file changed shape and the
// injection would be a guess.
const bindings = config.hyperdrive ?? [];
if (
  bindings.length !== 1 ||
  bindings[0].binding !== "HYPERDRIVE" ||
  bindings[0].id !== PLACEHOLDER_ID
) {
  fail("expected exactly one HYPERDRIVE binding with the placeholder ID in the source config.");
}

const vars = { ...config.vars };
for (const name of VAR_NAMES) {
  const value = process.env[name];
  if (value !== undefined && value !== "") {
    vars[name] = value;
  }
}
for (const name of SECRET_NAMES) {
  if (name in vars) {
    fail(`${name} is a secret and must never be a var.`);
  }
}

const placementRegion = process.env.WORKER_PLACEMENT_REGION || DEFAULT_PLACEMENT_REGION;
if (placementRegion !== "none" && !/^(aws|gcp|azure):[a-z0-9-]+$/.test(placementRegion)) {
  fail("WORKER_PLACEMENT_REGION must look like aws:ap-southeast-1, or be none.");
}

const outDir = dirname(out);
const rel = (path) => relative(outDir, path) || ".";
const { alias: _alias, main: _main, $schema: _schema, ...rest } = config;
const deployConfig = {
  ...rest,
  main: rel(join(bundle, "worker.js")),
  // Upload the built files as they are: no second build.
  no_bundle: true,
  base_dir: rel(bundle),
  find_additional_modules: true,
  // The query compiler, imported by the bundle under its hashed file name.
  rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false }],
  hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdriveId }],
  vars,
  ...(placementRegion === "none" ? {} : { placement: { region: placementRegion } }),
};

// Validate with the Worker's own startup schema, as it will run: vars and
// secrets from here, DATABASE_URL from the binding (a stand-in, since only the
// deployed Hyperdrive has the real one). Errors are `NAME: reason`, no values.
const { parseWorkerConfig } = await import(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/api/src/config.ts")
);
const environment = {
  ...vars,
  DATABASE_URL: "postgresql://hyperdrive.invalid:5432/scos",
};
for (const name of SECRET_NAMES) {
  if (process.env[name]) environment[name] = process.env[name];
}
const result = parseWorkerConfig(environment);
if (!result.success) {
  fail(`the Worker would not start:\n  ${result.errors.join("\n  ")}`);
}

writeFileSync(out, `${JSON.stringify(deployConfig, null, 2)}\n`);
console.log(`Wrote ${out}`);
console.log(`Worker vars: ${Object.keys(vars).sort().join(", ")}`);
console.log(`Placement: ${placementRegion}`);
