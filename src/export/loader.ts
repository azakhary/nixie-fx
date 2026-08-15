import { createVfxSourceHash } from "./hash";
import { VFX_EXPORT_FORMAT_VERSION } from "./schema";
import type {
  VfxExportManifest,
  VfxExportedEffect,
  VfxManifestAssetEntry,
  VfxManifestEffectEntry,
} from "./schema";
import type { VfxBackendId } from "../runtime/backends";

export interface LoadVfxExportBundleInput {
  manifest: unknown;
  effectsByPath: Readonly<Record<string, unknown>>;
  assetPaths?: Iterable<string>;
}

export interface LoadVfxExportBundleOptions {
  requiredBackend?: VfxBackendId;
  requiredEffectIds?: readonly string[];
  requireEveryAsset?: boolean;
}

export interface VfxExportBundle {
  manifest: VfxExportManifest;
  effectsById: ReadonlyMap<string, VfxExportedEffect>;
  effectsByPath: ReadonlyMap<string, VfxExportedEffect>;
}

/**
 * Loads an official compiled export without consulting authoring data. The
 * caller supplies already-read JSON values so this API works in Node, Vite,
 * native shells, and tests without owning filesystem or network policy.
 */
export function loadVfxExportBundle(
  input: LoadVfxExportBundleInput,
  options: LoadVfxExportBundleOptions = {},
): VfxExportBundle {
  const manifest = parseVfxExportManifest(input.manifest);
  assertExportWasSuccessful(manifest);
  const availableAssets = input.assetPaths
    ? new Set([...input.assetPaths].map(normalizeExportPath))
    : null;
  if (options.requireEveryAsset && !availableAssets) {
    throw new Error(
      "Official VFX export asset paths are required for this load operation.",
    );
  }

  const effectsById = new Map<string, VfxExportedEffect>();
  const effectsByPath = new Map<string, VfxExportedEffect>();
  const effectIds = new Set<string>();
  const effectPaths = new Set<string>();
  const assetPaths = new Set<string>();
  const assetKeys = new Set<string>();
  for (const asset of manifest.assets) {
    assertUnique(
      assetPaths,
      asset.path,
      `duplicate asset path "${asset.path}"`,
    );
    assertUnique(
      assetKeys,
      `${asset.type}:${asset.id}`,
      `duplicate asset identity "${asset.type}:${asset.id}"`,
    );
  }
  for (const entry of manifest.effects) {
    assertUnique(effectIds, entry.id, `duplicate effect id "${entry.id}"`);
    assertUnique(
      effectPaths,
      entry.path,
      `duplicate effect path "${entry.path}"`,
    );
    assertBackendSupport(entry, options.requiredBackend);
    if (!(entry.path in input.effectsByPath)) {
      throw new Error(`Official VFX export is missing ${entry.path}.`);
    }
    const effect = parseVfxExportedEffect(input.effectsByPath[entry.path]);
    assertEffectMatchesManifestEntry(effect, entry, manifest.generatedAt);
    for (const asset of effect.assets) {
      if (!manifestHasAsset(manifest.assets, asset)) {
        throw new Error(
          `Effect "${effect.id}" references asset absent from the manifest: ${asset.path}.`,
        );
      }
    }
    effectsById.set(effect.id, effect);
    effectsByPath.set(entry.path, effect);
  }

  const expectedManifestHash = createVfxSourceHash(
    manifest.effects.map((entry) => ({
      path: entry.path,
      sourceHash: entry.sourceHash,
    })),
  );
  if (manifest.sourceHash !== expectedManifestHash) {
    throw new Error(
      `Official VFX manifest source hash is stale: expected ${expectedManifestHash}, received ${manifest.sourceHash}.`,
    );
  }

  for (const id of options.requiredEffectIds ?? []) {
    if (!effectsById.has(id)) {
      throw new Error(
        `Official VFX export is missing required effect "${id}".`,
      );
    }
  }
  if (availableAssets) {
    for (const asset of manifest.assets) {
      if (!availableAssets.has(asset.path)) {
        throw new Error(`Official VFX export is missing asset ${asset.path}.`);
      }
    }
  }

  return { manifest, effectsById, effectsByPath };
}

export function parseVfxExportManifest(value: unknown): VfxExportManifest {
  const record = requireRecord(value, "VFX export manifest");
  if (record.kind !== "vfx-manifest") {
    throw new Error('VFX export manifest kind must be "vfx-manifest".');
  }
  assertFormatVersion(record.version, "VFX export manifest");
  requireString(record.generatedAt, "VFX export manifest generatedAt");
  requireString(record.sourceHash, "VFX export manifest sourceHash");
  const effects = requireArray(record.effects, "VFX export manifest effects");
  const assets = requireArray(record.assets, "VFX export manifest assets");
  const validation = requireRecord(
    record.validation,
    "VFX export manifest validation",
  );
  if (typeof validation.valid !== "boolean") {
    throw new Error("VFX export manifest validation.valid must be boolean.");
  }
  requireArray(validation.errors, "VFX export manifest validation errors");
  requireArray(validation.warnings, "VFX export manifest validation warnings");
  requireArray(validation.blockers, "VFX export manifest validation blockers");
  for (const [index, entry] of effects.entries()) {
    parseManifestEffectEntry(entry, index);
  }
  for (const [index, asset] of assets.entries()) {
    parseManifestAssetEntry(asset, index);
  }
  return value as VfxExportManifest;
}

export function parseVfxExportedEffect(value: unknown): VfxExportedEffect {
  const record = requireRecord(value, "VFX exported effect");
  if (record.kind !== "vfx-effect") {
    throw new Error('VFX exported effect kind must be "vfx-effect".');
  }
  assertFormatVersion(record.version, "VFX exported effect");
  requireString(record.generatedAt, "VFX exported effect generatedAt");
  requireString(record.id, "VFX exported effect id");
  requireString(record.sourceEffectId, "VFX exported effect sourceEffectId");
  requireString(record.sourceHash, "VFX exported effect sourceHash");
  requireArray(record.emitters, "VFX exported effect emitters");
  const assets = requireArray(record.assets, "VFX exported effect assets");
  requireRecord(record.support, "VFX exported effect support");
  for (const [index, asset] of assets.entries()) {
    parseManifestAssetEntry(asset, index);
  }
  return value as VfxExportedEffect;
}

function parseManifestEffectEntry(
  value: unknown,
  index: number,
): VfxManifestEffectEntry {
  const record = requireRecord(value, `VFX manifest effect ${index}`);
  requireString(record.id, `VFX manifest effect ${index} id`);
  requireString(record.name, `VFX manifest effect ${index} name`);
  normalizeExportPath(
    requireString(record.path, `VFX manifest effect ${index} path`),
  );
  requireString(
    record.sourceEffectId,
    `VFX manifest effect ${index} sourceEffectId`,
  );
  requireString(record.sourceHash, `VFX manifest effect ${index} sourceHash`);
  requireRecord(record.support, `VFX manifest effect ${index} support`);
  return value as VfxManifestEffectEntry;
}

function parseManifestAssetEntry(
  value: unknown,
  index: number,
): VfxManifestAssetEntry {
  const record = requireRecord(value, `VFX manifest asset ${index}`);
  requireString(record.id, `VFX manifest asset ${index} id`);
  if (
    record.type !== "texture" &&
    record.type !== "material" &&
    record.type !== "mesh"
  ) {
    throw new Error(`VFX manifest asset ${index} has unsupported type.`);
  }
  normalizeExportPath(
    requireString(record.path, `VFX manifest asset ${index} path`),
  );
  return value as VfxManifestAssetEntry;
}

function assertExportWasSuccessful(manifest: VfxExportManifest): void {
  if (!manifest.validation.valid || manifest.validation.blockers.length > 0) {
    throw new Error("Official VFX export is blocked by validation errors.");
  }
}

function assertBackendSupport(
  entry: VfxManifestEffectEntry,
  backend: VfxBackendId | undefined,
): void {
  if (!backend) return;
  const report = entry.support.backends[backend];
  if (!report || report.status === "blocked" || report.blockers.length > 0) {
    throw new Error(
      `Effect "${entry.id}" is blocked on required backend "${backend}".`,
    );
  }
}

function assertEffectMatchesManifestEntry(
  effect: VfxExportedEffect,
  entry: VfxManifestEffectEntry,
  manifestGeneratedAt: string,
): void {
  const mismatches: string[] = [];
  if (effect.id !== entry.id) mismatches.push("id");
  if (effect.sourceEffectId !== entry.sourceEffectId) {
    mismatches.push("sourceEffectId");
  }
  if (effect.sourceHash !== entry.sourceHash) mismatches.push("sourceHash");
  if (effect.generatedAt !== manifestGeneratedAt)
    mismatches.push("generatedAt");
  if (mismatches.length > 0) {
    throw new Error(
      `Official VFX effect ${entry.path} does not match its manifest entry (${mismatches.join(
        ", ",
      )}).`,
    );
  }
}

function manifestHasAsset(
  entries: readonly VfxManifestAssetEntry[],
  asset: VfxManifestAssetEntry,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === asset.type &&
      entry.id === asset.id &&
      entry.path === asset.path,
  );
}

function normalizeExportPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("//")
  ) {
    throw new Error(`Unsafe VFX export path "${path}".`);
  }
  return normalized.replace(/^\.\//, "");
}

function assertUnique(
  values: Set<string>,
  value: string,
  message: string,
): void {
  if (values.has(value))
    throw new Error(`Official VFX manifest has ${message}.`);
  values.add(value);
}

function assertFormatVersion(value: unknown, label: string): void {
  if (value !== VFX_EXPORT_FORMAT_VERSION) {
    throw new Error(
      `${label} version must be ${VFX_EXPORT_FORMAT_VERSION}; received ${String(
        value,
      )}.`,
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}
