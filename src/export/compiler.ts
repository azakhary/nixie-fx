import {
  makeParticleEffectFileName,
  normalizeParticleEffect,
  type ParticleEffectDefinition,
} from "../engine/particles";
import { serializeMaterialInstance } from "../engine/materialInstance";
import type { VfxAssetRef } from "../runtime/assets/types";
import {
  mergeVfxValidationResults,
  validateVfxAuthoringEffect,
  type VfxAuthoringValidationOptions,
  type VfxValidationResult,
} from "../runtime/schema/validation";
import { collectParticleTextureRefs } from "../runtime/assets/textureRefs";
import { collectParticleMeshRefs } from "../runtime/assets/meshRefs";
import { collectPixiVfxMaterialRefs } from "../runtime/pixi/support";
import {
  normalizeShaderGraph,
  type ShaderGraph,
} from "../runtime/schema/materials";
import {
  preferredBackendForTargetProfile,
  type VfxSupportStatus,
} from "../runtime/backends";
import { collectVfxBackendSupportReports } from "../runtime/support";
import {
  VFX_EXPORT_FORMAT_VERSION,
  type VfxCompiledEffect,
  type VfxCompiledExport,
  type VfxExportedEffect,
  type VfxExportedEmitter,
  type VfxExportManifest,
  type VfxExportSupport,
  type VfxManifestAssetEntry,
} from "./schema";
import { createVfxSourceHash } from "./hash";

export { createVfxSourceHash } from "./hash";

export interface CompileVfxEffectOptions {
  effectPath?: string;
  sourceEffectFile?: string;
  generatedAt?: string;
  validation?: VfxAuthoringValidationOptions;
  materialAssetPaths?: Readonly<Record<string, string>>;
}

export interface CompileVfxExportInput {
  effect: unknown;
  effectPath?: string;
  sourceEffectFile?: string;
}

export interface CompileVfxExportOptions {
  generatedAt?: string;
  validation?: VfxAuthoringValidationOptions;
  materialAssetPaths?: Readonly<Record<string, string>>;
}

export function compileVfxEffect(
  value: unknown,
  options: CompileVfxEffectOptions = {},
): VfxCompiledEffect {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const validation = validateVfxAuthoringEffect(value, options.validation);
  const normalized = normalizeParticleEffect(value);
  const assets = collectExportAssetRefs(
    normalized,
    options.materialAssetPaths,
    createMaterialGraphProvider(options.validation?.materialGraphs),
  );
  const support = createExportSupport(normalized, validation);
  const sourceEffectId = readSourceEffectId(value) ?? normalized.id;
  const sourceHash = createVfxSourceHash(value);
  const effect: VfxExportedEffect = {
    kind: "vfx-effect",
    version: VFX_EXPORT_FORMAT_VERSION,
    generatedAt,
    id: normalized.id,
    name: normalized.name,
    timeline: normalized.timeline,
    targetProfile: normalized.targetProfile,
    ...(options.sourceEffectFile
      ? { sourceEffectFile: options.sourceEffectFile }
      : {}),
    sourceEffectId,
    sourceHash,
    emitters: serializeExportedEmitters(normalized),
    assets,
    support,
  };

  return {
    effect,
    path:
      options.effectPath ?? `effects/${makeParticleEffectFileName(normalized)}`,
    ...(options.sourceEffectFile
      ? { sourceEffectFile: options.sourceEffectFile }
      : {}),
    sourceEffectId,
    sourceHash,
    assets,
    validation,
  };
}

export function compileVfxExport(
  inputs: readonly (CompileVfxExportInput | unknown)[],
  options: CompileVfxExportOptions = {},
): VfxCompiledExport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const effects = inputs.map((input) => {
    if (isCompileInput(input)) {
      return compileVfxEffect(input.effect, {
        effectPath: input.effectPath,
        sourceEffectFile: input.sourceEffectFile,
        generatedAt,
        validation: options.validation,
        materialAssetPaths: options.materialAssetPaths,
      });
    }
    return compileVfxEffect(input, {
      generatedAt,
      validation: options.validation,
      materialAssetPaths: options.materialAssetPaths,
    });
  });
  const validation = mergeVfxValidationResults(
    effects.map((compiled) => compiled.validation),
  );
  return {
    effects,
    manifest: compileVfxManifest(effects, {
      generatedAt,
      validation,
    }),
    validation,
  };
}

export function compileVfxManifest(
  effects: readonly VfxCompiledEffect[],
  options: CompileVfxExportOptions & {
    validation?: VfxValidationResult;
  } = {},
): VfxExportManifest {
  const assets = dedupeManifestAssets(
    effects.flatMap((compiled) => compiled.assets),
  );
  const validation =
    options.validation ??
    mergeVfxValidationResults(effects.map((compiled) => compiled.validation));
  return {
    kind: "vfx-manifest",
    version: VFX_EXPORT_FORMAT_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceHash: createVfxSourceHash(
      effects.map((compiled) => ({
        path: compiled.path,
        sourceHash: compiled.sourceHash,
      })),
    ),
    effects: effects.map((compiled) => ({
      id: compiled.effect.id,
      name: compiled.effect.name,
      path: compiled.path,
      ...(compiled.sourceEffectFile
        ? { sourceEffectFile: compiled.sourceEffectFile }
        : {}),
      sourceEffectId: compiled.sourceEffectId,
      sourceHash: compiled.sourceHash,
      support: compiled.effect.support,
    })),
    assets,
    validation,
  };
}

export function collectTextureAssetRefs(
  effect: ParticleEffectDefinition,
): VfxAssetRef[] {
  return collectParticleTextureRefs(effect);
}

/**
 * Collect every asset the export depends on: texture refs (mainTex is already
 * covered here via the texture-ref walker) plus the material assets themselves
 * (techspec §9, §3.2). Material refs follow texture refs so the manifest lists
 * textures first, then materials, in a deterministic order.
 */
export function collectExportAssetRefs(
  effect: ParticleEffectDefinition,
  materialAssetPaths?: Readonly<Record<string, string>>,
  materialGraphProvider?: (shaderId: string) => ShaderGraph | undefined,
): VfxAssetRef[] {
  return [
    ...collectParticleTextureRefs(effect, { materialGraphProvider }),
    ...collectPixiVfxMaterialRefs(effect, materialAssetPaths),
    ...collectParticleMeshRefs(effect),
  ];
}

/**
 * Strip editor-only scalar ranges from each emitter, then serialize any
 * `render.material` through `serializeMaterialInstance` so the exported instance
 * has a deterministic key order and drops default fields (techspec §9, §12).
 * `createVfxSourceHash` still hashes the INPUT value, so this re-serialization
 * never perturbs the source hash.
 */
function serializeExportedEmitters(
  effect: ParticleEffectDefinition,
): VfxExportedEmitter[] {
  const stripped = stripEditorScalarFields(
    effect.emitters,
  ) as VfxExportedEmitter[];
  return stripped.map((emitter, index) => {
    const material = effect.emitters[index]?.render.material;
    const render = emitter.render as Record<string, unknown>;
    render.material = material ? serializeMaterialInstance(material) : null;
    return emitter;
  });
}

export function stripEditorScalarFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripEditorScalarFields(item));
  }
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isScalarEditorField(key, value)) continue;
    output[key] = stripEditorScalarFields(item);
  }
  return output;
}

function createExportSupport(
  effect: ParticleEffectDefinition,
  validation: VfxValidationResult,
): VfxExportSupport {
  const blockers = validation.blockers;
  const warnings = validation.warnings;
  const partialModules = warnings
    .filter((warning) => warning.code === "unsupported-module")
    .map((warning) => warning.path);
  const status: VfxSupportStatus =
    blockers.length > 0
      ? "blocked"
      : partialModules.length > 0
        ? "partial"
        : "supported";
  const backends = collectVfxBackendSupportReports(effect, validation);
  const preferredBackend = preferredBackendForTargetProfile(
    effect.targetProfile,
  );
  const backendStatuses = Object.values(backends).map(
    (report) => report.status,
  );
  const profileStatus =
    preferredBackend === undefined
      ? worstSupportStatus([status, ...backendStatuses])
      : worstSupportStatus([status, backends[preferredBackend].status]);
  const overall: VfxSupportStatus = profileStatus;
  return {
    status: overall,
    overall,
    targetProfile: effect.targetProfile,
    ...(preferredBackend ? { preferredBackend } : {}),
    portableSubset:
      backends.pixi2d.status === "supported" &&
      backends.three3d.status === "supported",
    backends,
    unsupportedModules: blockers
      .filter((blocker) => blocker.code === "unsupported-module")
      .map((blocker) => blocker.path),
    partialModules,
    warnings: warnings.map((warning) => warning.message),
  };
}

function createMaterialGraphProvider(
  materialGraphs: Readonly<Record<string, unknown>> | undefined,
): ((shaderId: string) => ShaderGraph | undefined) | undefined {
  if (!materialGraphs) return undefined;
  const cache = new Map<string, ShaderGraph>();
  return (shaderId: string): ShaderGraph | undefined => {
    const cached = cache.get(shaderId);
    if (cached) return cached;
    const raw = materialGraphs[shaderId];
    if (!raw) return undefined;
    const graph = normalizeShaderGraph(raw);
    cache.set(shaderId, graph);
    return graph;
  };
}

function worstSupportStatus(
  statuses: readonly VfxSupportStatus[],
): VfxSupportStatus {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("partial")) return "partial";
  return "supported";
}

function dedupeManifestAssets(
  assets: readonly VfxAssetRef[],
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

function isScalarEditorField(
  key: string,
  record: Record<string, unknown>,
): boolean {
  if (key !== "editorMin" && key !== "editorMax") return false;
  return (
    typeof record.mode === "string" &&
    ("value" in record || "curve" in record || "curveB" in record)
  );
}

function isCompileInput(value: unknown): value is CompileVfxExportInput {
  return isRecord(value) && "effect" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSourceEffectId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const id = value.id.trim();
  return id || null;
}
