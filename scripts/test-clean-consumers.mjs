import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);
const typescriptCli = resolve(
  repositoryRoot,
  "node_modules/typescript/bin/tsc",
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "nixie-fx-consumers-"));

try {
  const tarball = await packActualArtifact(temporaryRoot);
  const consumers = [
    {
      name: "core-export-no-peers",
      dependencies: {},
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      typeSource: `
import {
  ParticleEffectRunner,
  createDefaultParticleEffect,
  validateVfxAuthoringEffect,
} from "nixie-fx";
import {
  compileVfxExport,
  loadVfxExportBundle,
  type ExportIo,
} from "nixie-fx/export";
import {
  EDITOR_PROJECT_FILE_NAME,
  normalizeProjectSettings,
} from "nixie-fx/project";

const effect = createDefaultParticleEffect();
const runner = new ParticleEffectRunner(effect);
const validation = validateVfxAuthoringEffect(effect);
const compiled = compileVfxExport([effect], {
  generatedAt: "2026-01-01T00:00:00.000Z",
});
const io: ExportIo | undefined = undefined;
void runner;
void validation;
void compiled;
void loadVfxExportBundle;
void io;
void EDITOR_PROJECT_FILE_NAME;
void normalizeProjectSettings;
`,
      runtimeSource: `
import { createRequire } from "node:module";
import { ParticleEffectRunner, createDefaultParticleEffect } from "nixie-fx";
import { compileVfxExport, loadVfxExportBundle } from "nixie-fx/export";
import { EDITOR_PROJECT_FILE_NAME } from "nixie-fx/project";

const effect = createDefaultParticleEffect();
if (!(new ParticleEffectRunner(effect) instanceof ParticleEffectRunner)) {
  throw new Error("Core runtime constructor is unavailable.");
}
if (typeof compileVfxExport !== "function" || typeof loadVfxExportBundle !== "function") {
  throw new Error("Browser-safe export API is unavailable.");
}
if (EDITOR_PROJECT_FILE_NAME !== "vfx-editor.prj") {
  throw new Error("Project API is unavailable.");
}
const require = createRequire(import.meta.url);
for (const peer of ["pixi.js", "three"]) {
  try {
    require.resolve(peer);
    throw new Error(peer + " was installed in the peer-free consumer.");
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("peer-free consumer.")) throw error;
  }
}
`,
    },
    {
      name: "pixi-only",
      dependencies: {
        "pixi.js": packageJson.devDependencies["pixi.js"],
      },
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      typeSource: `
import type { Container } from "pixi.js";
import {
  PixiVfxRenderer,
  createMaterialPreviewFragment,
  createPixiVfx2dProjection,
  type PixiVfxRendererOptions,
} from "nixie-fx/pixi";

declare const parent: Container;
const options: PixiVfxRendererOptions = {
  parent,
  projection: createPixiVfx2dProjection(),
};
const Runtime: typeof PixiVfxRenderer = PixiVfxRenderer;
void options;
void Runtime;
void createMaterialPreviewFragment;
`,
      runtimeSource: `
import { createRequire } from "node:module";
import { PixiVfxRenderer, createPixiVfx2dProjection } from "nixie-fx/pixi";

if (typeof PixiVfxRenderer !== "function" || typeof createPixiVfx2dProjection !== "function") {
  throw new Error("Pixi public API is unavailable.");
}
const require = createRequire(import.meta.url);
require.resolve("pixi.js");
try {
  require.resolve("three");
  throw new Error("three was installed in the Pixi-only consumer.");
} catch (error) {
  if (error instanceof Error && error.message.endsWith("Pixi-only consumer.")) throw error;
}
`,
    },
    {
      name: "three-only",
      dependencies: {
        three: packageJson.devDependencies.three,
        "@types/three": packageJson.devDependencies["@types/three"],
      },
      lib: ["ES2022", "DOM"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      typeSource: `
import type { Camera, Object3D } from "three";
import {
  ThreeVfxRenderer,
  repairMirroredGeometryWinding,
  type ThreeVfxRendererOptions,
} from "nixie-fx/three";

declare const camera: Camera;
declare const parent: Object3D;
const options: ThreeVfxRendererOptions = { camera, parent };
const Runtime: typeof ThreeVfxRenderer = ThreeVfxRenderer;
void options;
void Runtime;
void repairMirroredGeometryWinding;
`,
      runtimeSource: `
import { createRequire } from "node:module";
import { ThreeVfxRenderer, repairMirroredGeometryWinding } from "nixie-fx/three";

if (typeof ThreeVfxRenderer !== "function" || typeof repairMirroredGeometryWinding !== "function") {
  throw new Error("Three public API is unavailable.");
}
const require = createRequire(import.meta.url);
require.resolve("three");
try {
  require.resolve("pixi.js");
  throw new Error("pixi.js was installed in the Three-only consumer.");
} catch (error) {
  if (error instanceof Error && error.message.endsWith("Three-only consumer.")) throw error;
}
`,
    },
    {
      name: "export-node-no-peers",
      dependencies: {},
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      typeSource: `
import {
  nodeExportIo,
  writeVfxExportFromProject,
} from "nixie-fx/export/node";

void nodeExportIo;
void writeVfxExportFromProject;
`,
      runtimeSource: `
import { createRequire } from "node:module";
import { nodeExportIo, writeVfxExportFromProject } from "nixie-fx/export/node";

if (typeof nodeExportIo !== "object" || typeof writeVfxExportFromProject !== "function") {
  throw new Error("Node export API is unavailable.");
}
const require = createRequire(import.meta.url);
for (const peer of ["pixi.js", "three"]) {
  try {
    require.resolve(peer);
    throw new Error(peer + " was installed in the export/node consumer.");
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("export/node consumer.")) throw error;
  }
}
`,
    },
  ];

  for (const consumer of consumers) {
    await testConsumer(consumer, tarball);
    process.stdout.write(`Clean consumer passed: ${consumer.name}.\n`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("All NixieFX clean consumers passed.\n");

async function packActualArtifact(outputDirectory) {
  const output = execFileSync(
    npmCommand(),
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      outputDirectory,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const [result] = JSON.parse(output);
  const tarball = resolve(outputDirectory, result.filename);
  await access(tarball);
  return tarball;
}

async function testConsumer(consumer, tarball) {
  const directory = resolve(temporaryRoot, consumer.name);
  await mkdir(directory, { recursive: true });
  const dependencies = {
    "nixie-fx": `file:${tarball}`,
    ...consumer.dependencies,
  };
  await writeJson(resolve(directory, "package.json"), {
    name: `nixie-fx-test-${consumer.name}`,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
  });
  await writeJson(resolve(directory, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: consumer.module,
      moduleResolution: consumer.moduleResolution,
      lib: consumer.lib,
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
    },
    files: ["index.ts"],
  });
  await writeFile(resolve(directory, "index.ts"), consumer.typeSource.trim());
  await writeFile(
    resolve(directory, "index.mjs"),
    consumer.runtimeSource.trim(),
  );

  execFileSync(
    npmCommand(),
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [typescriptCli, "--project", resolve(directory, "tsconfig.json")],
    { cwd: directory, stdio: "inherit" },
  );
  execFileSync(process.execPath, [resolve(directory, "index.mjs")], {
    cwd: directory,
    stdio: "inherit",
  });
  if (consumer.name === "core-export-no-peers") {
    const binary = resolve(
      directory,
      "node_modules/.bin",
      process.platform === "win32" ? "nixie-fx.cmd" : "nixie-fx",
    );
    const help = execFileSync(binary, ["--help"], {
      cwd: directory,
      encoding: "utf8",
    });
    if (!help.includes("nixie-fx effect create")) {
      throw new Error("Installed nixie-fx binary did not print help.");
    }
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
