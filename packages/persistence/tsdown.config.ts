import { defineConfig } from "tsdown";

// @scos/persistence is bundled with tsdown. The generated Prisma client
// (src/generated/prisma) is bundled; runtime dependencies stay external and
// Prisma's query compiler is loaded from @prisma/client at run time.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    database: "src/database.ts",
    // Integration-test harness for this package and its composers (apps/api).
    testing: "src/testing.ts",
    "bin/seed": "src/bin/seed.ts",
    "bin/confirm-reset": "src/bin/confirm-reset.ts",
  },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24",
  tsconfig: "tsconfig.json",
  // Keep .js/.d.ts names so package.json exports and db:* scripts stay stable.
  fixedExtension: false,
  sourcemap: true,
  // TypeScript 7 is installed, so declarations are generated with tsgo from
  // tsconfig.json. Only the public entries need declarations.
  dts: {
    generator: "tsgo",
    entry: ["src/index.ts", "src/database.ts", "src/testing.ts"],
  },
  deps: {
    // Fail the build if the output imports anything besides these packages
    // (and Node built-ins).
    onlyImport: ["@prisma/adapter-pg", "@prisma/client", "@scos/core", "pg"],
  },
});
