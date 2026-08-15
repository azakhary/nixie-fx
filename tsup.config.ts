import { defineConfig } from "tsup";

const shared = {
  format: "esm" as const,
  sourcemap: false,
  clean: false,
  minify: false,
  treeshake: true,
  external: ["pixi.js", "three"],
  outDir: "dist",
};

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      project: "src/project.ts",
      materials: "src/materials.ts",
      pixi: "src/pixi.ts",
      three: "src/three.ts",
      export: "src/export.ts",
      "export-node": "src/export-node.ts",
    },
    target: "es2020",
    platform: "neutral",
    dts: true,
    splitting: true,
  },
  {
    ...shared,
    entry: { cli: "src/cli/main.ts" },
    target: "node20",
    platform: "node",
    dts: false,
    splitting: false,
  },
]);
