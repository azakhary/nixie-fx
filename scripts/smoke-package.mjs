import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

const entryChecks = [
  {
    file: "index.js",
    required: [
      "ParticleEffectRunner",
      "VFX_ASSET_REDIRECTS_FILE",
      "createDefaultParticleEffect",
      "meshAssetIdFromPath",
      "validateVfxAuthoringEffect",
    ],
    absent: ["PixiVfxRenderer", "ThreeVfxRenderer"],
    forbiddenImports: ["pixi.js", "three", "node:"],
  },
  {
    file: "materials.js",
    required: ["compileMaterial", "normalizeShaderGraph", "sampleGradient"],
    forbiddenImports: ["pixi.js", "three", "node:"],
  },
  {
    file: "project.js",
    required: [
      "EDITOR_PROJECT_FILE_NAME",
      "normalizeEditorProjectFile",
      "normalizeProjectSettings",
    ],
    forbiddenImports: ["pixi.js", "three", "node:"],
  },
  {
    file: "export.js",
    required: [
      "VFX_EXPORT_FORMAT_VERSION",
      "compileVfxExport",
      "loadVfxExportBundle",
      "writeVfxExportWithIo",
    ],
    absent: ["nodeExportIo", "writeVfxExportFromProject"],
    forbiddenImports: ["pixi.js", "three", "node:"],
  },
  {
    file: "pixi.js",
    required: ["PixiVfxRenderer", "createMaterialPreviewFragment"],
    forbiddenImports: ["three", "node:"],
  },
  {
    file: "three.js",
    required: ["ThreeVfxRenderer", "repairMirroredGeometryWinding"],
    forbiddenImports: ["pixi.js", "node:"],
  },
  {
    file: "export-node.js",
    required: ["nodeExportIo", "writeVfxExportFromProject"],
    forbiddenImports: ["pixi.js", "three"],
  },
];

for (const check of entryChecks) {
  const entry = resolve(dist, check.file);
  const exports = await import(pathToFileURL(entry).href);
  for (const name of check.required) {
    if (!(name in exports)) {
      throw new Error(`${check.file} is missing the public export ${name}.`);
    }
  }
  for (const name of check.absent ?? []) {
    if (name in exports) {
      throw new Error(`${check.file} unexpectedly exports ${name}.`);
    }
  }
  const imports = await collectExternalImports(entry);
  for (const forbidden of check.forbiddenImports) {
    const hit = [...imports].find(
      (specifier) =>
        specifier === forbidden || specifier.startsWith(`${forbidden}/`),
    );
    if (hit) {
      throw new Error(`${check.file} reaches forbidden import ${hit}.`);
    }
  }
}

const cliSource = await readFile(resolve(dist, "cli.js"), "utf8");
if (!cliSource.startsWith("#!/usr/bin/env node")) {
  throw new Error("cli.js is missing its executable Node shebang.");
}
const cliImports = await collectExternalImports(resolve(dist, "cli.js"));
for (const forbidden of ["pixi.js", "three"]) {
  const hit = [...cliImports].find(
    (specifier) =>
      specifier === forbidden || specifier.startsWith(`${forbidden}/`),
  );
  if (hit) throw new Error(`cli.js reaches optional renderer peer ${hit}.`);
}
const cliHelp = execFileSync(
  process.execPath,
  [resolve(dist, "cli.js"), "--help"],
  {
    encoding: "utf8",
  },
);
if (!cliHelp.includes("nixie-fx effect create")) {
  throw new Error("cli.js did not print the expected help text.");
}

for (const file of await listFiles(dist)) {
  const extension = extname(file);
  if (extension !== ".js" && !file.endsWith(".d.ts")) continue;
  const source = await readFile(file, "utf8");
  for (const token of [
    ["@rockbite", "vfx-runtime"].join("/"),
    ["rockbite", "vfx-editor"].join("/"),
    ["", "Users", ""].join("/"),
    ["src", "editor", ""].join("/"),
    "@/",
  ]) {
    if (source.includes(token)) {
      throw new Error(
        `${file.slice(root.length + 1)} contains forbidden token ${token}.`,
      );
    }
  }
}

process.stdout.write("NixieFX package smoke passed.\n");

async function collectExternalImports(entry) {
  const visited = new Set();
  const external = new Set();

  const visit = async (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const dependency = resolve(dirname(file), specifier);
      if (extname(dependency) === ".js") await visit(dependency);
    }
  };

  await visit(entry);
  return external;
}

function importSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:from\s*|import\s*\()(["'])([^"']+)\1/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[2]);
  return specifiers;
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    if (entry.isFile()) files.push(path);
  }
  return files;
}
