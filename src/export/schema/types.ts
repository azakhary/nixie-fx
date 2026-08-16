import type {
  ParticleEffectDefinition,
  ParticleEmitterDefinition,
  ParticleScalarValue,
} from "../../engine/particles";
import type {
  MaterialInstance,
  MaterialParamValue,
  MaterialTextureRef,
} from "../../engine/materialInstance";
import type { VfxAssetRef } from "../../runtime/assets/types";
import type {
  VfxBackendId,
  VfxBackendSupportReports,
  VfxTargetProfile,
} from "../../runtime/backends";
import type { VfxValidationResult } from "../../runtime/schema/validation";

/**
 * Exported material instance shape (techspec §9). Identical to the engine
 * {@link MaterialInstance}; re-exported under an export-scoped name so consumers
 * of the export format can type `render.material` without reaching into the
 * engine. Serialized via `serializeMaterialInstance` (deterministic key order,
 * persist-when-non-default — §3.3, §12).
 */
export type VfxExportedMaterialInstance = MaterialInstance;
export type VfxExportedMaterialParamValue = MaterialParamValue;
export type VfxExportedMaterialTextureRef = MaterialTextureRef;

export const VFX_EXPORT_FORMAT_VERSION = 1;
export type VfxExportFormatVersion = typeof VFX_EXPORT_FORMAT_VERSION;

export type StripParticleScalarEditorFields<T> = T extends ParticleScalarValue
  ? Omit<T, "editorMin" | "editorMax">
  : T extends readonly unknown[]
    ? { [K in keyof T]: StripParticleScalarEditorFields<T[K]> }
    : T extends object
      ? {
          [
            K in keyof T as K extends "editorMin" | "editorMax" ? never : K
          ]: StripParticleScalarEditorFields<T[K]>;
        }
      : T;

export type VfxExportedEmitter =
  StripParticleScalarEditorFields<ParticleEmitterDefinition>;

export type VfxSupportStatus = "supported" | "partial" | "blocked";

export interface VfxExportSupport {
  /**
   * `blocked` when validation has blockers (export/runtime cannot represent the
   * effect safely), `partial` when the effect is exportable but relies on
   * modules/features whose runtime semantics are approximate or smaller than
   * a full-featured reference implementation, and `supported` when there are no blockers and no partial
   * warnings.
   */
  status: VfxSupportStatus;
  /** Same summary as `status`, named for the backend-aware support contract. */
  overall: VfxSupportStatus;
  targetProfile: VfxTargetProfile;
  preferredBackend?: VfxBackendId;
  portableSubset: boolean;
  backends: VfxBackendSupportReports;
  /** Authoring paths of modules/features that block export. */
  unsupportedModules: string[];
  /** Authoring paths of modules/features with approximate ("partial") support. */
  partialModules: string[];
  /**
   * Human-readable warning messages surfaced during validation, scoped to
   * the effect's target profile — these gate `status` (F4).
   */
  warnings: string[];
  /**
   * Informational backend-semantics notes (F4), e.g. how the non-target
   * backend renders authored depth flags. Never gate `status`. Prefixed
   * with the backend they describe; omitted when empty.
   */
  notes?: string[];
}

export interface VfxExportedEffect {
  kind: "vfx-effect";
  version: VfxExportFormatVersion;
  generatedAt: string;
  id: ParticleEffectDefinition["id"];
  name: ParticleEffectDefinition["name"];
  timeline: ParticleEffectDefinition["timeline"];
  targetProfile: ParticleEffectDefinition["targetProfile"];
  sourceEffectFile?: string;
  sourceEffectId: string;
  sourceHash: string;
  emitters: VfxExportedEmitter[];
  assets: VfxAssetRef[];
  support: VfxExportSupport;
}

export interface VfxManifestEffectEntry {
  id: string;
  name: string;
  path: string;
  sourceEffectFile?: string;
  sourceEffectId: string;
  sourceHash: string;
  support: VfxExportSupport;
}

export interface VfxManifestAssetEntry {
  id: string;
  type: VfxAssetRef["type"];
  path: string;
}

export interface VfxExportManifest {
  kind: "vfx-manifest";
  version: VfxExportFormatVersion;
  generatedAt: string;
  sourceHash: string;
  effects: VfxManifestEffectEntry[];
  assets: VfxManifestAssetEntry[];
  validation: VfxValidationResult;
}

export interface VfxCompiledEffect {
  effect: VfxExportedEffect;
  path: string;
  sourceEffectFile?: string;
  sourceEffectId: string;
  sourceHash: string;
  assets: VfxAssetRef[];
  validation: VfxValidationResult;
}

export interface VfxCompiledExport {
  effects: VfxCompiledEffect[];
  manifest: VfxExportManifest;
  validation: VfxValidationResult;
}

export type VfxExportWrittenFileKind =
  "manifest" | "effect" | "asset" | "diagnostics";

export interface VfxExportWrittenFile {
  kind: VfxExportWrittenFileKind;
  path: string;
  bytes: number;
}

export interface VfxExportWriteDiagnostics {
  kind: "vfx-export-diagnostics";
  version: VfxExportFormatVersion;
  generatedAt: string;
  projectRoot: string;
  effectDataPath: string;
  assetRootPath: string;
  outputPath: string;
  effectCount: number;
  validation: VfxValidationResult;
}

export interface VfxExportWriteResult {
  ok: boolean;
  blocked: boolean;
  generatedAt: string;
  projectRoot: string;
  effectDataPath: string;
  assetRootPath: string;
  outputPath: string;
  effectCount: number;
  writtenFiles: VfxExportWrittenFile[];
  validation: VfxValidationResult;
  manifest?: VfxExportManifest;
  diagnostics?: VfxExportWriteDiagnostics;
}
