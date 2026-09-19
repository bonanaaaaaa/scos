// Zips each bundled Lambda handler (dist/lambda/<name>/) into
// dist/lambda/<name>.zip and writes dist/lambda/manifest.json.
//
// The zips are deterministic: the same bundle bytes give the same zip bytes
// (entries sorted by name, fixed timestamps and permissions, no extra
// fields, one fixed deflate level). zlib is Node.js's bundled copy, so use
// the pinned Node.js version (CI: 24.15.0) when comparing hashes across
// machines. The manifest also records the Git commit, which is not part of
// any zip.
//
// Usage: node scripts/package-lambda.mjs [--out-dir <dir>]
// (run `pnpm build` first; `pnpm package:lambda` at the root does both).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";

import { LAMBDA_FUNCTIONS } from "../build.config.mjs";

export const RUNTIME = "nodejs24.x";
export const ARCHITECTURE = "arm64";
export const HANDLER = "index.handler";

// 1980-01-01 00:00:00, the earliest MS-DOS timestamp.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
// Regular file, rw-r--r--, in the high 16 bits (Unix "version made by").
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const VERSION_MADE_BY = (3 << 8) | 20;
const VERSION_NEEDED = 20;
const DEFLATE = 8;

/** Builds a zip archive from `{ name, data }` entries, sorted by name. */
export function createZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    const fileName = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, fileName, compressed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(VERSION_MADE_BY, 4);
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(DEFLATE, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(fileName.length, 28);
    record.writeUInt16LE(0, 30); // extra field length
    record.writeUInt16LE(0, 32); // comment length
    record.writeUInt16LE(0, 34); // disk number
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, fileName);

    offset += header.length + fileName.length + compressed.length;
  }
  if (offset > 0xffffffff || sorted.length > 0xffff) {
    throw new Error("Archive too large for a zip without ZIP64");
  }
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralDirectory, end]);
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** Zips every function under `distDir` into `outDir` and writes the manifest. */
export async function packageLambdas({ distDir, outDir }) {
  await mkdir(outDir, { recursive: true });
  const functions = [];
  for (const name of LAMBDA_FUNCTIONS) {
    const directory = join(distDir, name);
    let files;
    try {
      files = (await readdir(directory)).sort();
    } catch {
      throw new Error(`${directory} is missing: run the build first (pnpm build).`);
    }
    if (!files.includes("index.mjs")) {
      throw new Error(`${directory}/index.mjs is missing: run the build first (pnpm build).`);
    }
    const entries = await Promise.all(
      files.map(async (file) => ({ name: file, data: await readFile(join(directory, file)) })),
    );
    const zip = createZip(entries);
    const artifact = `${name}.zip`;
    await writeFile(join(outDir, artifact), zip);
    const digest = createHash("sha256").update(zip).digest();
    functions.push({
      name,
      artifact,
      handler: HANDLER,
      runtime: RUNTIME,
      architecture: ARCHITECTURE,
      files,
      bytes: zip.length,
      sha256: digest.toString("hex"),
      // The form Terraform's source_code_hash and Lambda's CodeSha256 use.
      sha256Base64: digest.toString("base64"),
    });
  }
  const sha = git(["rev-parse", "HEAD"])?.trim() ?? null;
  const status = git(["status", "--porcelain"]);
  const manifest = {
    schemaVersion: 1,
    gitSha: sha,
    gitDirty: status === undefined ? null : status.length > 0,
    runtime: RUNTIME,
    architecture: ARCHITECTURE,
    functions,
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { "out-dir": { type: "string" } } });
  const distDir = resolve("dist/lambda");
  const outDir = resolve(values["out-dir"] ?? distDir);
  const manifest = await packageLambdas({ distDir, outDir });
  for (const fn of manifest.functions) {
    console.log(`${join(outDir, fn.artifact)}  ${fn.bytes} bytes  sha256 ${fn.sha256}`);
  }
  console.log(`${join(outDir, "manifest.json")}  git ${manifest.gitSha ?? "unknown"}`);
}
