import { createVfxSourceHash } from "./hash";
import type { VfxExportManifest, VfxManifestEffectEntry } from "./schema";

/**
 * Browser-safe staleness comparison between an exported bundle manifest and the
 * authored effect JSON files it was produced from. The caller reads both sides
 * (fetch, node:fs, File System Access, ...) so this module owns no IO policy.
 */

export type VfxExportSourceStatus = "exported" | "stale" | "unexported";

export interface VfxExportSourceInput {
  /** Effect-data-root-relative source path, e.g. `nested/spark.json`. */
  path: string;
  /** The parsed authoring JSON exactly as it was read from disk. */
  source: unknown;
}

export interface VfxExportSourceComparison {
  /** Source path, as passed in. */
  path: string;
  status: VfxExportSourceStatus;
  /** Hash of the authored JSON, computed with the exporter's own hash. */
  sourceHash: string;
  /** Manifest entry path (`effects/<source path>`) when the effect is exported. */
  exportedPath?: string;
  /** Compiled effect id from the manifest entry, when exported. */
  effectId?: string;
  /** `sourceHash` recorded in the manifest, when exported. */
  exportedSourceHash?: string;
}

export interface VfxExportOrphanComparison {
  /** Manifest entry path, e.g. `effects/spark.json`. */
  exportedPath: string;
  effectId: string;
  name: string;
  sourceEffectFile?: string;
  exportedSourceHash: string;
}

export interface VfxExportComparison {
  /** `generatedAt` of the compared manifest; null when there is no manifest. */
  generatedAt: string | null;
  /** True when no usable manifest was supplied (absent or unreadable). */
  missingManifest: boolean;
  effects: VfxExportSourceComparison[];
  /** Manifest effects with no matching authored source. */
  orphans: VfxExportOrphanComparison[];
  counts: Record<VfxExportSourceStatus, number> & { orphans: number };
  /** True when anything is stale, unexported, or orphaned. */
  outOfDate: boolean;
}

const EFFECTS_DIR = "effects";

/**
 * Compares a parsed export manifest against the authored effect sources.
 *
 * Pass `null`/`undefined`/garbage for `manifest` when the bundle has never been
 * exported: every source is then reported as `unexported`.
 */
export function compareVfxExportToSources(
  manifest: unknown,
  sources: readonly VfxExportSourceInput[],
): VfxExportComparison {
  const entries = readManifestEffectEntries(manifest);
  const byPath = new Map<string, VfxManifestEffectEntry>();
  const bySourceFile = new Map<string, VfxManifestEffectEntry>();
  for (const entry of entries) {
    byPath.set(normalizePath(entry.path), entry);
    if (entry.sourceEffectFile) {
      bySourceFile.set(normalizePath(entry.sourceEffectFile), entry);
    }
  }

  const matched = new Set<VfxManifestEffectEntry>();
  const effects: VfxExportSourceComparison[] = [];
  for (const input of sources) {
    const path = normalizePath(input.path);
    const entry =
      bySourceFile.get(path) ?? byPath.get(`${EFFECTS_DIR}/${path}`);
    const sourceHash = createVfxSourceHash(input.source);
    if (!entry) {
      effects.push({ path: input.path, status: "unexported", sourceHash });
      continue;
    }
    matched.add(entry);
    effects.push({
      path: input.path,
      status: entry.sourceHash === sourceHash ? "exported" : "stale",
      sourceHash,
      exportedPath: entry.path,
      effectId: entry.id,
      exportedSourceHash: entry.sourceHash,
    });
  }

  const orphans = entries
    .filter((entry) => !matched.has(entry))
    .map<VfxExportOrphanComparison>((entry) => ({
      exportedPath: entry.path,
      effectId: entry.id,
      name: entry.name,
      ...(entry.sourceEffectFile
        ? { sourceEffectFile: entry.sourceEffectFile }
        : {}),
      exportedSourceHash: entry.sourceHash,
    }));

  const counts = {
    exported: effects.filter((entry) => entry.status === "exported").length,
    stale: effects.filter((entry) => entry.status === "stale").length,
    unexported: effects.filter((entry) => entry.status === "unexported").length,
    orphans: orphans.length,
  };

  return {
    generatedAt: readManifestGeneratedAt(manifest),
    missingManifest: !isManifestLike(manifest),
    effects,
    orphans,
    counts,
    outOfDate: counts.stale > 0 || counts.unexported > 0 || counts.orphans > 0,
  };
}

function readManifestEffectEntries(
  manifest: unknown,
): VfxManifestEffectEntry[] {
  if (!isManifestLike(manifest)) return [];
  const effects = (manifest as VfxExportManifest).effects;
  if (!Array.isArray(effects)) return [];
  return effects.filter(
    (entry): entry is VfxManifestEffectEntry =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      typeof entry.path === "string" &&
      typeof entry.sourceHash === "string",
  );
}

function readManifestGeneratedAt(manifest: unknown): string | null {
  if (!isManifestLike(manifest)) return null;
  const generatedAt = (manifest as Record<string, unknown>).generatedAt;
  return typeof generatedAt === "string" ? generatedAt : null;
}

function isManifestLike(manifest: unknown): boolean {
  return isRecord(manifest) && Array.isArray(manifest.effects);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
