import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (packageJson.bin?.["nixie-fx"] !== "dist/cli.js") {
  throw new Error('package.json must expose bin.nixie-fx as "dist/cli.js".');
}

const output = execFileSync(
  npmCommand(),
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);
const [result] = JSON.parse(output);
const paths = result.files.map((file) => file.path);

for (const required of [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/project.js",
  "dist/project.d.ts",
  "dist/materials.js",
  "dist/pixi.js",
  "dist/three.js",
  "dist/export.js",
  "dist/export-node.js",
  "dist/cli.js",
]) {
  if (!paths.includes(required)) {
    throw new Error(`Packed artifact is missing ${required}.`);
  }
}

for (const path of paths) {
  const allowed =
    path === "LICENSE" ||
    path === "README.md" ||
    path === "package.json" ||
    path.startsWith("dist/");
  if (!allowed) throw new Error(`Unexpected packed file: ${path}.`);
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) {
    throw new Error(`Test file leaked into packed artifact: ${path}.`);
  }
  if (path.endsWith(".map")) {
    throw new Error(`Source map leaked into packed artifact: ${path}.`);
  }
}

process.stdout.write(
  `NixieFX pack audit passed (${paths.length} files, ${result.size} bytes).\n`,
);

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
