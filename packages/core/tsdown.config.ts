import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  tsconfig: "tsconfig.json",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  deps: {
    neverBundle: true,
  },
});
