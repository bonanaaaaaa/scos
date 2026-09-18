import { defineConfig } from "tsdown";

// @scos/persistence is bundled with tsdown; its sources keep NodeNext `.js`
// relative imports like the rest of the workspace. The generated Prisma client
// (src/generated/prisma) is bundled; runtime dependencies stay external and
// Prisma's query compiler is loaded from @prisma/client at run time.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    database: "src/database.ts",
    "bin/seed": "src/bin/seed.ts",
    "bin/confirm-reset": "src/bin/confirm-reset.ts",
  },
  outDir: "dist",
  format: "esm",
  platform: "node",
  // Keep .js/.d.ts names so package.json exports and db:* scripts stay stable.
  fixedExtension: false,
  sourcemap: true,
  // TypeScript 7 is installed, so declarations are generated with tsgo from
  // tsconfig.json. Only the public entries need declarations.
  dts: {
    generator: "tsgo",
    entry: ["src/index.ts", "src/database.ts"],
  },
  deps: {
    // Fail the build if the output imports anything besides these packages
    // (and Node built-ins).
    onlyImport: ["@prisma/adapter-pg", "@prisma/client", "@scos/core", "pg"],
  },
});
