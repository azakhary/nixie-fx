import { expandMaterialSubgraphs } from "../runtime/materials/subgraphs";
import {
  extname,
  isAbsolute,
  normalize,
  relative,
  resolve,
} from "../lib/pathx";
import type { ExportIo } from "./io";
import { compileVfxExport, type CompileVfxExportInput } from "./compiler";
import {
  validateVfxMeshAssetPath,
  validateVfxTextureAssetPath,
} from "../runtime/assets/paths";
import {
  VFX_ASSET_REDIRECTS_FILE,
  normalizeAssetRedirectMap,
  resolveAssetRedirectPath,
  rewriteAssetRedirectPaths,
  type VfxAssetRedirectMap,
} from "../runtime/assets/assetRedirects";
import {
  createVfxValidationResult,
  mergeVfxValidationResults,
  type VfxExportBlocker,
  type VfxValidationIssue,
  type VfxValidationResult,
} from "../runtime/schema/validation";
import {
  normalizeShaderGraph,
  type ShaderGraph,
} from "../runtime/schema/materials";
import { EDITOR_PROJECT_FILE_NAME } from "../project/settings";
import { createVfxSourceHash } from "./hash";
import type { VfxAssetRef } from "../runtime/assets/types";
import type {
  VfxCompiledEffect,
  VfxExportedEffect,
  VfxExportManifest,
  VfxExportWriteDiagnostics,
  VfxExportWriteResult,
  VfxExportWrittenFile,
  VfxManifestAssetEntry,
  VfxManifestEffectEntry,
} from "./schema";

const MANIFEST_FILE = "manifest.json";
const DIAGNOSTICS_FILE = "export-diagnostics.json";
const EFFECTS_DIR = "effects";
const DEFAULT_MATERIALS_DIR = "materials";
const MATERIAL_EXTENSION = ".material";

export interface WriteVfxExportFromProjectOptions {
  projectRoot: string;
  effectDataPath: string;
  effectFile?: string;
  assetRootPath?: string;
  outputPath: string;
  allowExternalOutput?: boolean;
  materialsFolder?: string;
  generatedAt?: string;
}

interface ProjectRelativeDirectory {
  absolutePath: string;
  relativePath: string;
}

interface SourceEffectFile {
  absolutePath: string;
  relativePath: string;
}

interface ProjectMaterialContext {
  expandedGraphIds?: Set<string>;
  graphs: Record<string, ShaderGraph>;
  assetPaths: Record<string, string>;
}

export async function writeVfxExportWithIo(
  options: WriteVfxExportFromProjectOptions,
  io: ExportIo,
): Promise<VfxExportWriteResult> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const projectRoot = resolve(options.projectRoot);
  const effectsRoot = resolveProjectEffectDataDirectory(
    projectRoot,
    options.effectDataPath,
    "Effect data path",
    io,
  );
  const outputRoot = resolveProjectOutputDirectory(
    projectRoot,
    options.outputPath,
    options.allowExternalOutput === true,
    io,
  );
  const assetRoot = resolveProjectAssetRootDirectory(
    projectRoot,
    options.assetRootPath ?? "assets",
    "Asset root path",
    io,
  );
  assertOutputDoesNotContainSourceRoots(outputRoot.absolutePath, [
    effectsRoot.absolutePath,
    assetRoot.absolutePath,
  ]);
  const materialsFolder = normalizeMaterialFolder(
    options.materialsFolder ?? DEFAULT_MATERIALS_DIR,
  );
  const assetRedirects = await readExportAssetRedirectMap(
    assetRoot.absolutePath,
    io,
  );
  // Incremental mode: a single requested effect is compiled, validated and
  // merged into whatever bundle already sits in the output folder, instead of
  // wiping and rewriting every effect.
  const incremental = options.effectFile !== undefined;
  const sourceFiles = selectSourceEffectFiles(
    await listSourceEffectFiles(effectsRoot.absolutePath, io, {
      excludeRoots: [outputRoot.absolutePath],
    }),
    options.effectFile,
  );
  const materialContext = await listProjectMaterialContext(
    assetRoot,
    materialsFolder,
    io,
    { excludeRoots: [outputRoot.absolutePath] },
  );
  const compileInputs: CompileVfxExportInput[] = [];
  for (const file of sourceFiles) {
    const effect = JSON.parse(
      await io.readTextFile(file.absolutePath),
    ) as unknown;
    compileInputs.push({
      effect: rewriteAssetRedirectPaths(effect, assetRedirects),
      effectPath: createCompiledEffectPath(file.relativePath),
      sourceEffectFile: file.relativePath,
    });
  }
  const compiled = compileVfxExport(compileInputs, {
    generatedAt,
    validation: { materialGraphs: materialContext.graphs },
    materialAssetPaths: materialContext.assetPaths,
  });
  const validation = mergeVfxValidationResults([
    compiled.validation,
    await validateCompiledAssets(
      compiled.effects,
      assetRoot,
      materialsFolder,
      assetRedirects,
      io,
    ),
  ]);

  if (!incremental) await io.resetDir(outputRoot.absolutePath);

  if (!validation.valid) {
    const diagnostics: VfxExportWriteDiagnostics = {
      kind: "vfx-export-diagnostics",
      version: compiled.manifest.version,
      generatedAt,
      projectRoot,
      effectDataPath: effectsRoot.relativePath,
      assetRootPath: assetRoot.relativePath,
      outputPath: outputRoot.relativePath,
      effectCount: compiled.effects.length,
      validation,
    };
    const writtenFiles = [
      await writeJsonFile(
        outputRoot.absolutePath,
        DIAGNOSTICS_FILE,
        diagnostics,
        {
          kind: "diagnostics",
          projectOutputPath: outputRoot.relativePath,
        },
        io,
      ),
    ];
    return {
      ok: false,
      blocked: true,
      generatedAt,
      projectRoot,
      effectDataPath: effectsRoot.relativePath,
      assetRootPath: assetRoot.relativePath,
      outputPath: outputRoot.relativePath,
      effectCount: compiled.effects.length,
      writtenFiles,
      validation,
      diagnostics,
    };
  }

  // Incremental merge: read the bundle already on disk, keep every other
  // effect, and republish it alongside the freshly compiled one.
  const carried = incremental
    ? await readCarriedExportEffects(compiled.effects, outputRoot, io)
    : { effects: [], previousManifest: null };
  const manifest = incremental
    ? mergeIncrementalManifest(compiled.manifest, carried.effects, generatedAt)
    : compiled.manifest;

  const writtenFiles: VfxExportWrittenFile[] = [];
  for (const effect of compiled.effects) {
    writtenFiles.push(
      await writeJsonFile(
        outputRoot.absolutePath,
        effect.path,
        effect.effect,
        {
          kind: "effect",
          projectOutputPath: outputRoot.relativePath,
        },
        io,
      ),
    );
  }
  for (const asset of compiled.manifest.assets) {
    const materialId = Object.keys(materialContext.assetPaths).find(
      (id) => materialContext.assetPaths[id] === asset.path,
    );
    if (materialId && materialContext.expandedGraphIds?.has(materialId)) {
      writtenFiles.push(
        await writeJsonFile(
          outputRoot.absolutePath,
          asset.path,
          materialContext.graphs[materialId],
          { kind: "asset", projectOutputPath: outputRoot.relativePath },
          io,
        ),
      );
      continue;
    }
    writtenFiles.push(
      await copyExportAsset(
        assetRoot.absolutePath,
        outputRoot.absolutePath,
        outputRoot.relativePath,
        asset.path,
        io,
      ),
    );
  }
  // Carried effect files only ever change in `generatedAt`, which the loader
  // requires to equal the manifest's. Their `sourceHash` is untouched, so the
  // bundle stays a faithful export of unchanged sources.
  for (const entry of carried.effects) {
    writtenFiles.push(
      await writeJsonFile(
        outputRoot.absolutePath,
        entry.manifestEntry.path,
        { ...entry.effect, generatedAt },
        { kind: "effect", projectOutputPath: outputRoot.relativePath },
        io,
      ),
    );
  }
  if (incremental) {
    writtenFiles.push(
      ...(await deleteOrphanExportFiles(
        carried.previousManifest,
        manifest,
        outputRoot,
        io,
      )),
    );
  }
  writtenFiles.push(
    await writeJsonFile(
      outputRoot.absolutePath,
      MANIFEST_FILE,
      manifest,
      {
        kind: "manifest",
        projectOutputPath: outputRoot.relativePath,
      },
      io,
    ),
  );

  return {
    ok: true,
    blocked: false,
    generatedAt,
    projectRoot,
    effectDataPath: effectsRoot.relativePath,
    assetRootPath: assetRoot.relativePath,
    outputPath: outputRoot.relativePath,
    effectCount: compiled.effects.length,
    writtenFiles,
    validation,
    manifest,
  };
}

interface CarriedExportEffect {
  manifestEntry: VfxManifestEffectEntry;
  effect: VfxExportedEffect;
}

interface CarriedExportBundle {
  effects: CarriedExportEffect[];
  previousManifest: VfxExportManifest | null;
}

/**
 * Reads the manifest already in the output folder and returns every effect that
 * must survive an incremental export: the ones the newly compiled effects do
 * NOT replace and whose compiled file is still readable on disk. A missing or
 * corrupt manifest (or effect file) is treated as "nothing to carry" rather
 * than an error, so a broken output folder always heals into a valid bundle.
 */
async function readCarriedExportEffects(
  compiled: readonly VfxCompiledEffect[],
  outputRoot: ProjectRelativeDirectory,
  io: ExportIo,
): Promise<CarriedExportBundle> {
  const previousManifest = await readExistingExportManifest(
    outputRoot.absolutePath,
    io,
  );
  if (!previousManifest) return { effects: [], previousManifest: null };

  const replacedPaths = new Set(compiled.map((entry) => entry.path));
  const replacedSourceIds = new Set(
    compiled.map((entry) => entry.sourceEffectId),
  );
  const replacedIds = new Set(compiled.map((entry) => entry.effect.id));
  const effects: CarriedExportEffect[] = [];
  for (const entry of previousManifest.effects) {
    if (
      replacedPaths.has(entry.path) ||
      replacedSourceIds.has(entry.sourceEffectId) ||
      replacedIds.has(entry.id)
    ) {
      continue;
    }
    const effect = await readExportedEffectFile(
      outputRoot.absolutePath,
      entry.path,
      io,
    );
    // A manifest entry whose compiled file vanished cannot be carried: keeping
    // it would produce a manifest the loader rejects.
    if (!effect || effect.sourceHash !== entry.sourceHash) continue;
    effects.push({ manifestEntry: entry, effect });
  }
  return { effects, previousManifest };
}

/**
 * Merges the freshly compiled single-effect manifest with the carried entries.
 *
 * - `effects`: carried entries first (in their previous order), then the
 *   compiled ones, so re-exporting one effect does not reshuffle the bundle.
 * - `assets`: union of the effect files' own asset lists, deduped by path
 *   (the loader requires unique asset paths). Assets no longer referenced by
 *   any surviving effect simply fall out of the union.
 * - `validation`: union of the per-entry validations, which is exactly what a
 *   full export writes. Entries from a pre-0.1.11 manifest carry no stored
 *   validation and therefore contribute nothing.
 * - `sourceHash`: recomputed over the merged `{path, sourceHash}` list, which
 *   is the value `loadVfxExportBundle` recomputes and compares.
 */
function mergeIncrementalManifest(
  compiledManifest: VfxExportManifest,
  carried: readonly CarriedExportEffect[],
  generatedAt: string,
): VfxExportManifest {
  const effects: VfxManifestEffectEntry[] = [
    ...carried.map((entry) => entry.manifestEntry),
    ...compiledManifest.effects,
  ];
  const assets = dedupeExportAssets([
    ...carried.flatMap((entry) => entry.effect.assets),
    ...compiledManifest.assets,
  ]);
  return {
    ...compiledManifest,
    generatedAt,
    sourceHash: createVfxSourceHash(
      effects.map((entry) => ({
        path: entry.path,
        sourceHash: entry.sourceHash,
      })),
    ),
    effects,
    assets,
    validation: mergeVfxValidationResults(
      effects.map(
        (entry) => entry.validation ?? createVfxValidationResult([], []),
      ),
    ),
  };
}

function dedupeExportAssets(
  assets: readonly (VfxAssetRef | VfxManifestAssetEntry)[],
): VfxManifestAssetEntry[] {
  const byPath = new Map<string, VfxManifestAssetEntry>();
  for (const asset of assets) {
    if (byPath.has(asset.path)) continue;
    byPath.set(asset.path, {
      id: asset.id,
      type: asset.type,
      path: asset.path,
    });
  }
  return [...byPath.values()];
}

/**
 * Deletes files the previous manifest declared and the merged one no longer
 * does — orphaned assets plus compiled effect files of replaced/renamed
 * entries. Only paths that resolve INSIDE the output root are touched, and a
 * backend without `deleteFile` keeps the stale files instead.
 */
async function deleteOrphanExportFiles(
  previousManifest: VfxExportManifest | null,
  manifest: VfxExportManifest,
  outputRoot: ProjectRelativeDirectory,
  io: ExportIo,
): Promise<VfxExportWrittenFile[]> {
  const deleteFile = io.deleteFile?.bind(io);
  if (!previousManifest || !deleteFile) return [];
  const keptAssets = new Set(manifest.assets.map((asset) => asset.path));
  const keptEffects = new Set(manifest.effects.map((entry) => entry.path));
  const orphans = [
    ...previousManifest.assets
      .filter((asset) => !keptAssets.has(asset.path))
      .map((asset) => asset.path),
    ...previousManifest.effects
      .filter((entry) => !keptEffects.has(entry.path))
      .map((entry) => entry.path),
  ];

  const removed: VfxExportWrittenFile[] = [];
  for (const path of orphans) {
    let target: string;
    try {
      target = resolve(
        outputRoot.absolutePath,
        normalizeSafeProjectRelativePath(path, "Export file path"),
      );
      assertPathInside(
        outputRoot.absolutePath,
        target,
        "Export file path escapes output folder",
      );
    } catch {
      continue;
    }
    if (!(await io.isFile(target))) continue;
    await deleteFile(target);
    removed.push({
      kind: "removed",
      path: `${outputRoot.relativePath}/${path}`.replace(/\\/g, "/"),
      bytes: 0,
    });
  }
  return removed;
}

async function readExistingExportManifest(
  outputRoot: string,
  io: ExportIo,
): Promise<VfxExportManifest | null> {
  const target = resolve(outputRoot, MANIFEST_FILE);
  if (!(await io.isFile(target))) return null;
  try {
    const parsed = JSON.parse(
      await io.readTextFile(target),
    ) as VfxExportManifest;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.kind !== "vfx-manifest" ||
      !Array.isArray(parsed.effects) ||
      !Array.isArray(parsed.assets)
    ) {
      return null;
    }
    return {
      ...parsed,
      effects: parsed.effects.filter(isUsableManifestEffectEntry),
      assets: parsed.assets.filter(
        (asset): asset is VfxManifestAssetEntry =>
          !!asset && typeof asset.path === "string",
      ),
    };
  } catch {
    return null;
  }
}

function isUsableManifestEffectEntry(
  entry: VfxManifestEffectEntry,
): entry is VfxManifestEffectEntry {
  return (
    !!entry &&
    typeof entry.id === "string" &&
    typeof entry.path === "string" &&
    typeof entry.sourceHash === "string" &&
    typeof entry.sourceEffectId === "string"
  );
}

async function readExportedEffectFile(
  outputRoot: string,
  path: string,
  io: ExportIo,
): Promise<VfxExportedEffect | null> {
  let target: string;
  try {
    target = resolve(
      outputRoot,
      normalizeSafeProjectRelativePath(path, "Export file path"),
    );
    assertPathInside(
      outputRoot,
      target,
      "Export file path escapes output folder",
    );
  } catch {
    return null;
  }
  if (!(await io.isFile(target))) return null;
  try {
    const parsed = JSON.parse(
      await io.readTextFile(target),
    ) as VfxExportedEffect;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.kind !== "vfx-effect" ||
      !Array.isArray(parsed.assets)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function resolveProjectExportDirectory(
  projectRoot: string,
  rawPath: string,
  label = "Project path",
): ProjectRelativeDirectory {
  const relativePath = normalizeSafeProjectRelativePath(rawPath, label);
  const absolutePath = resolve(projectRoot, relativePath);
  assertPathInside(projectRoot, absolutePath, `${label} escapes project root`);
  return { absolutePath, relativePath };
}

export function resolveProjectOutputDirectory(
  projectRoot: string,
  rawPath: string,
  allowExternal: boolean,
  io?: ExportIo,
): ProjectRelativeDirectory {
  return allowExternal
    ? resolveExternalProjectDirectory(projectRoot, rawPath, "Output path", io)
    : resolveProjectExportDirectory(projectRoot, rawPath, "Output path");
}

export function resolveProjectEffectDataDirectory(
  projectRoot: string,
  rawPath: string,
  label = "Effect data path",
  io?: ExportIo,
): ProjectRelativeDirectory {
  return resolveExternalProjectDirectory(projectRoot, rawPath, label, io);
}

export function resolveProjectAssetRootDirectory(
  projectRoot: string,
  rawPath: string,
  label = "Asset root path",
  io?: ExportIo,
): ProjectRelativeDirectory {
  return resolveExternalProjectDirectory(projectRoot, rawPath, label, io);
}

function resolveExternalProjectDirectory(
  projectRoot: string,
  rawPath: string,
  label: string,
  io?: ExportIo,
): ProjectRelativeDirectory {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (looksLikeProtocolPath(trimmed)) {
    throw new Error(`${label} cannot be a URL or protocol path`);
  }
  const expanded = expandHomePath(trimmed, io);
  const absolutePath = isAbsolute(expanded)
    ? normalize(expanded)
    : resolve(projectRoot, normalize(expanded));
  return { absolutePath, relativePath: trimmed.replace(/\/+$/g, "") || "." };
}

export function normalizeSafeProjectRelativePath(
  rawPath: string,
  label = "Project path",
): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (isAbsolute(trimmed)) {
    throw new Error(`${label} must be relative to the project root`);
  }
  const normalized = normalize(trimmed).replace(/\\/g, "/");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`${label} must stay inside the project root`);
  }
  return normalized.replace(/^\.\/+/, "");
}

function expandHomePath(path: string, io?: ExportIo): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    const home = io?.homeDir() ?? null;
    if (!home) {
      throw new Error("Home-relative paths are not available here");
    }
    if (path === "~") return home;
    return resolve(home, path.slice(2));
  }
  return path;
}

function looksLikeProtocolPath(path: string): boolean {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path)
  );
}

async function listSourceEffectFiles(
  root: string,
  io: ExportIo,
  options: { excludeRoots?: readonly string[] } = {},
): Promise<SourceEffectFile[]> {
  if (!(await io.exists(root))) return [];
  if (!(await io.isDirectory(root))) {
    throw new Error("Effect data path must point to a folder");
  }
  const excluded = (options.excludeRoots ?? []).map((path) => resolve(path));
  const files: SourceEffectFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await io.readDir(directory)) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory) {
        if (
          excluded.some(
            (exclude) =>
              absolutePath === exclude ||
              relative(exclude, absolutePath).startsWith("..") === false,
          )
        ) {
          continue;
        }
        if (await isNestedProjectDirectory(absolutePath, io)) continue;
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile || extname(entry.name).toLowerCase() !== ".json") {
        continue;
      }
      // Only files carrying the particle-effect envelope are effects. The
      // effect root may legitimately hold other JSON (prepared meshes,
      // settings); without this sniff a shared effects/assets root would
      // block every export on e.g. a mesh file "missing" an effect id.
      // Envelope-only on purpose: an effect with the right envelope but
      // broken content must still surface its validation errors.
      if (!(await hasParticleEffectEnvelope(absolutePath, io))) {
        continue;
      }
      files.push({
        absolutePath,
        relativePath: relative(root, absolutePath).replace(/\\/g, "/"),
      });
    }
  };
  await walk(root);
  return files.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }),
  );
}

/**
 * A subfolder holding its own `vfx-editor.prj` is a separate project (e.g. a
 * `3d/` subproject inside a `vfx/` project). Its effects, materials and assets
 * belong to that project's own export, so the parent walks past it — otherwise
 * the parent's export blocks on assets it does not own.
 */
async function isNestedProjectDirectory(
  directory: string,
  io: ExportIo,
): Promise<boolean> {
  return io.isFile(resolve(directory, EDITOR_PROJECT_FILE_NAME));
}

async function hasParticleEffectEnvelope(
  absolutePath: string,
  io: ExportIo,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await io.readTextFile(absolutePath)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return false;
    const record = parsed as Record<string, unknown>;
    if (record.app === "vfx-editor" && record.kind === "particle-effect") {
      return true;
    }
    // Legacy authoring files carry no envelope; the structural marker is the
    // emitters array. Anything declaring a different kind (compiled
    // "vfx-effect" output, manifests) is not an authoring effect.
    return !("kind" in record) && Array.isArray(record.emitters);
  } catch {
    return false;
  }
}

function selectSourceEffectFiles(
  files: readonly SourceEffectFile[],
  requestedFile: string | undefined,
): SourceEffectFile[] {
  if (requestedFile === undefined) return [...files];

  const relativePath = normalizeSafeProjectRelativePath(
    requestedFile,
    "Effect file path",
  );
  if (extname(relativePath).toLowerCase() !== ".json") {
    throw new Error("Only JSON particle effects can be exported");
  }
  const selected = files.find((file) => file.relativePath === relativePath);
  if (!selected) {
    throw new Error(`Effect file "${relativePath}" was not found`);
  }
  return [selected];
}

async function listProjectMaterialContext(
  assetRoot: ProjectRelativeDirectory,
  materialsFolder: string,
  io: ExportIo,
  options: { excludeRoots?: readonly string[] } = {},
): Promise<ProjectMaterialContext> {
  const root = resolve(assetRoot.absolutePath, materialsFolder);
  const excluded = (options.excludeRoots ?? []).map((path) => resolve(path));
  const graphs: Record<string, ShaderGraph> = {};
  const assetPaths: Record<string, string> = {};
  if (!(await io.exists(root))) return { graphs, assetPaths };
  if (!(await io.isDirectory(root))) return { graphs, assetPaths };

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await io.readDir(directory)) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory) {
        if (
          excluded.some(
            (exclude) =>
              absolutePath === exclude ||
              !relative(exclude, absolutePath).startsWith(".."),
          )
        ) {
          continue;
        }
        if (await isNestedProjectDirectory(absolutePath, io)) continue;
        await walk(absolutePath);
        continue;
      }
      if (
        !entry.isFile ||
        extname(entry.name).toLowerCase() !== MATERIAL_EXTENSION
      ) {
        continue;
      }
      try {
        const graph = normalizeShaderGraph(
          JSON.parse(await io.readTextFile(absolutePath)) as unknown,
        );
        graphs[graph.id] = graph;
        assetPaths[graph.id] = relative(
          assetRoot.absolutePath,
          absolutePath,
        ).replace(/\\/g, "/");
      } catch {
        // Referenced malformed material files are still caught as missing graph
        // references by project validation because they never enter this map.
      }
    }
  };
  await walk(root);
  const hydrate = (
    graph: ShaderGraph,
    ancestors: string[] = [],
  ): ShaderGraph => {
    if (ancestors.includes(graph.id))
      throw new Error(`Recursive material subgraph: ${graph.name}`);
    return {
      ...graph,
      nodes: graph.nodes.map((node) => {
        if (node.type !== "subgraph") return node;
        const snapshot = node.params.graph as ShaderGraph | undefined;
        const definition = snapshot && graphs[snapshot.id];
        if (!definition)
          throw new Error(`Missing subgraph asset used by ${graph.name}`);
        return {
          ...node,
          params: {
            ...node.params,
            graph: hydrate(definition, [...ancestors, graph.id]),
          },
        };
      }),
    };
  };
  const resolved = Object.fromEntries(
    Object.entries(graphs)
      .filter(([, graph]) => !graph.subgraph)
      .map(([id, graph]) => [id, expandMaterialSubgraphs(hydrate(graph))]),
  );
  return {
    graphs: resolved,
    assetPaths,
    expandedGraphIds: new Set(
      Object.values(graphs)
        .filter((g) => g.nodes.some((n) => n.type === "subgraph"))
        .map((g) => g.id),
    ),
  };
}

function createCompiledEffectPath(sourceRelativePath: string): string {
  const relativePath = normalizeSafeProjectRelativePath(
    sourceRelativePath,
    "Effect file path",
  );
  if (!relativePath.endsWith(".json")) {
    throw new Error("Only JSON particle effects can be exported");
  }
  return `${EFFECTS_DIR}/${relativePath}`;
}

async function validateCompiledAssets(
  effects: readonly VfxCompiledEffect[],
  assetRoot: ProjectRelativeDirectory,
  materialsFolder: string,
  redirects: VfxAssetRedirectMap,
  io: ExportIo,
): Promise<VfxValidationResult> {
  const issues: VfxValidationIssue[] = [];
  const blockers: VfxExportBlocker[] = [];

  for (const compiled of effects) {
    for (const [assetIndex, asset] of compiled.assets.entries()) {
      const error = await validateCompiledAsset(
        asset,
        assetRoot,
        materialsFolder,
        redirects,
        io,
      );
      if (!error) continue;
      const path = `${
        compiled.sourceEffectFile ?? compiled.path
      }.assets.${assetIndex}.path`;
      const issue: VfxValidationIssue = {
        severity: "error",
        code: "invalid-asset-ref",
        path,
        message: error,
      };
      const blocker: VfxExportBlocker = {
        code: "invalid-asset-ref",
        path,
        message: error,
      };
      issues.push(issue);
      blockers.push(blocker);
    }
  }

  return createVfxValidationResult(issues, blockers);
}

async function validateCompiledAsset(
  asset: VfxAssetRef,
  assetRoot: ProjectRelativeDirectory,
  materialsFolder: string,
  redirects: VfxAssetRedirectMap,
  io: ExportIo,
): Promise<string | null> {
  if (asset.type === "texture") {
    const validation = validateVfxTextureAssetPath(asset.path);
    if (!validation.valid || !validation.path) return null;
    const resolvedPath = resolveAssetRedirectPath(validation.path, redirects);
    const target = resolve(assetRoot.absolutePath, resolvedPath);
    assertPathInside(
      assetRoot.absolutePath,
      target,
      "Texture asset path escapes asset root",
    );
    if (await io.isFile(target)) return null;
    return `Missing raw texture asset "${asset.path}" in asset root "${assetRoot.relativePath}".`;
  }

  if (asset.type === "mesh") {
    const validation = validateVfxMeshAssetPath(asset.path);
    if (!validation.valid || !validation.path) return null;
    const resolvedPath = resolveAssetRedirectPath(validation.path, redirects);
    const target = resolve(assetRoot.absolutePath, resolvedPath);
    assertPathInside(
      assetRoot.absolutePath,
      target,
      "Mesh asset path escapes asset root",
    );
    if (await io.isFile(target)) return null;
    return `Missing raw mesh asset "${asset.path}" in asset root "${assetRoot.relativePath}".`;
  }

  const relativePath = validateMaterialAssetPath(asset.path, materialsFolder);
  if (!relativePath) {
    return `Material asset path "${asset.path}" must be a .material file under "${materialsFolder}/".`;
  }
  const target = resolve(assetRoot.absolutePath, relativePath);
  assertPathInside(
    assetRoot.absolutePath,
    target,
    "Material asset path escapes asset root",
  );
  if (await io.isFile(target)) return null;
  return `Missing material asset "${asset.path}" in asset root "${assetRoot.relativePath}".`;
}

function validateMaterialAssetPath(
  path: string,
  materialsFolder: string,
): string | null {
  try {
    const relativePath = normalizeSafeProjectRelativePath(
      path,
      "Material asset path",
    );
    const prefix = `${materialsFolder.replace(/\/+$/g, "")}/`;
    if (!relativePath.startsWith(prefix)) return null;
    if (extname(relativePath).toLowerCase() !== MATERIAL_EXTENSION) return null;
    return relativePath;
  } catch {
    return null;
  }
}

function normalizeMaterialFolder(rawPath: string): string {
  const relativePath = normalizeSafeProjectRelativePath(
    rawPath,
    "Materials folder",
  );
  return relativePath.replace(/\/+$/g, "");
}

async function readExportAssetRedirectMap(
  assetRoot: string,
  io: ExportIo,
): Promise<VfxAssetRedirectMap> {
  const target = resolve(assetRoot, VFX_ASSET_REDIRECTS_FILE);
  if (!(await io.exists(target))) return normalizeAssetRedirectMap(null);
  try {
    return normalizeAssetRedirectMap(
      JSON.parse(await io.readTextFile(target)) as unknown,
    );
  } catch {
    return normalizeAssetRedirectMap(null);
  }
}

async function copyExportAsset(
  assetRoot: string,
  outputRoot: string,
  projectOutputPath: string,
  path: string,
  io: ExportIo,
): Promise<VfxExportWrittenFile> {
  const relativePath = normalizeSafeProjectRelativePath(
    path,
    "Export asset path",
  );
  if (
    relativePath === MANIFEST_FILE ||
    relativePath === DIAGNOSTICS_FILE ||
    relativePath === EFFECTS_DIR ||
    relativePath.startsWith(`${EFFECTS_DIR}/`)
  ) {
    throw new Error(`Export asset path collides with reserved output: ${path}`);
  }
  const source = resolve(assetRoot, relativePath);
  const target = resolve(outputRoot, relativePath);
  assertPathInside(assetRoot, source, "Export asset path escapes asset root");
  assertPathInside(
    outputRoot,
    target,
    "Export asset path escapes output folder",
  );
  await io.copyFile(source, target);
  return {
    kind: "asset",
    path: `${projectOutputPath}/${relativePath}`.replace(/\\/g, "/"),
    bytes: await io.fileSize(target),
  };
}

async function writeJsonFile(
  root: string,
  path: string,
  data: unknown,
  options: {
    kind: VfxExportWrittenFile["kind"];
    projectOutputPath: string;
  },
  io: ExportIo,
): Promise<VfxExportWrittenFile> {
  const relativePath = normalizeSafeProjectRelativePath(
    path,
    "Export file path",
  );
  const target = resolve(root, relativePath);
  assertPathInside(root, target, "Export file path escapes output folder");
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await io.writeTextFile(target, json);
  return {
    kind: options.kind,
    path: `${options.projectOutputPath}/${relativePath}`.replace(/\\/g, "/"),
    bytes: new TextEncoder().encode(json).length,
  };
}

function assertPathInside(root: string, target: string, message: string): void {
  const path = relative(root, target);
  if (path.startsWith("..") || isAbsolute(path)) throw new Error(message);
}

function assertOutputDoesNotContainSourceRoots(
  outputRoot: string,
  sourceRoots: readonly string[],
): void {
  for (const sourceRoot of sourceRoots) {
    const path = relative(outputRoot, sourceRoot);
    if (!path.startsWith("..") && !isAbsolute(path)) {
      throw new Error(
        "Output path must not contain the effect data or asset root.",
      );
    }
  }
}
