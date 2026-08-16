import type { ParticleEffectDefinition } from "../engine/particles";
import {
  PIXI_2D_BACKEND_CAPABILITIES,
  THREE_3D_BACKEND_CAPABILITIES,
  statusFromDiagnostics,
  type VfxBackendSupportReport,
  type VfxBackendSupportReports,
  type VfxSupportDiagnostic,
} from "./backends";
import { collectPixiVfxUnsupportedFeatures } from "./pixi/support";
import type { VfxValidationResult } from "./schema/validation";

const THREE_MVP_BLOCKED_MODULES = new Set(["subEmitters", "lights"]);

export function collectVfxBackendSupportReports(
  effect: ParticleEffectDefinition,
  validation?: VfxValidationResult,
): VfxBackendSupportReports {
  return {
    pixi2d: collectPixiBackendSupport(effect, validation),
    three3d: collectThreeBackendSupport(effect, validation),
  };
}

export function collectPixiBackendSupport(
  effect: ParticleEffectDefinition,
  validation?: VfxValidationResult,
): VfxBackendSupportReport {
  const warnings: VfxSupportDiagnostic[] = validationWarnings(
    validation,
    "pixi2d",
  );
  const blockers: VfxSupportDiagnostic[] = validationBlockers(validation);

  for (const feature of collectPixiVfxUnsupportedFeatures(effect)) {
    const diagnostic = {
      code: feature.featureKey,
      path: feature.path,
      message: feature.reason,
      emitterId: feature.emitterId,
      emitterIndex: feature.emitterIndex,
    };
    if (feature.featureKey === "mode.meshAsset") {
      blockers.push(diagnostic);
    } else {
      warnings.push(diagnostic);
    }
  }

  return {
    backend: PIXI_2D_BACKEND_CAPABILITIES.backend,
    status: statusFromDiagnostics(warnings, blockers),
    warnings: dedupeDiagnostics(warnings),
    blockers: dedupeDiagnostics(blockers),
    ...supportNotes(validation, "pixi2d"),
  };
}

export function collectThreeBackendSupport(
  effect: ParticleEffectDefinition,
  validation?: VfxValidationResult,
): VfxBackendSupportReport {
  const warnings = validationWarnings(validation, "three3d");
  const blockers = validationBlockers(validation);

  effect.emitters.forEach((emitter, emitterIndex) => {
    const emitterPath = `emitters.${emitterIndex}`;
    if (emitter.mode === "mesh" && emitter.mesh.renderMode === "pixiShard") {
      warnings.push({
        code: "mode.mesh.pixiShard",
        path: `${emitterPath}.mesh.renderMode`,
        message:
          "Old mesh mode is Pixi shard geometry; Three renders true mesh particles only when mesh.renderMode is meshAsset.",
        emitterId: emitter.id,
        emitterIndex,
      });
    }
    if (emitter.mode === "mesh" && emitter.mesh.renderMode === "meshAsset") {
      if (!emitter.mesh.asset) {
        blockers.push({
          code: "mode.meshAsset.missing",
          path: `${emitterPath}.mesh.asset`,
          message: "Three mesh particles require a prepared mesh asset ref.",
          emitterId: emitter.id,
          emitterIndex,
        });
      }
    }
    for (const [moduleKey, enabled] of Object.entries(emitter.modules)) {
      if (!enabled || !THREE_MVP_BLOCKED_MODULES.has(moduleKey)) continue;
      blockers.push({
        code: `module.${moduleKey}`,
        path: `${emitterPath}.modules.${moduleKey}`,
        message: `${moduleKey} is not implemented in the Three renderer MVP yet; keep it backend-gated until the Three draw path owns it.`,
        emitterId: emitter.id,
        emitterIndex,
      });
    }
    if (
      emitter.render.material &&
      emitter.render.material.shaderId !== "sprite-master"
    ) {
      warnings.push({
        code: "material.threeAdapter",
        path: `${emitterPath}.render.material`,
        message:
          "Three MVP uses the fixed-function particle material adapter; custom graph lowering is backend-gated until the Three material compiler lands.",
        emitterId: emitter.id,
        emitterIndex,
      });
    }
  });

  return {
    backend: THREE_3D_BACKEND_CAPABILITIES.backend,
    status: statusFromDiagnostics(warnings, blockers),
    warnings: dedupeDiagnostics(warnings),
    blockers: dedupeDiagnostics(blockers),
    ...supportNotes(validation, "three3d"),
  };
}

/**
 * Validation warnings that apply to `backend`: unscoped warnings plus those
 * whose `backend` tag matches (F4). Warnings the validator demoted to
 * `infos` for the effect's target profile surface via `validationNotes`.
 */
function validationWarnings(
  validation: VfxValidationResult | undefined,
  backend: "pixi2d" | "three3d",
): VfxSupportDiagnostic[] {
  return (validation?.warnings ?? [])
    .filter((warning) => !warning.backend || warning.backend === backend)
    .map((warning) => ({
      code: warning.code,
      path: warning.path,
      message: warning.message,
    }));
}

/** Informational notes for `backend`; never feed status computation (F4). */
function supportNotes(
  validation: VfxValidationResult | undefined,
  backend: "pixi2d" | "three3d",
): { notes: VfxSupportDiagnostic[] } | Record<string, never> {
  const notes = dedupeDiagnostics(validationNotes(validation, backend));
  return notes.length > 0 ? { notes } : {};
}

function validationNotes(
  validation: VfxValidationResult | undefined,
  backend: "pixi2d" | "three3d",
): VfxSupportDiagnostic[] {
  return (validation?.infos ?? [])
    .filter((info) => !info.backend || info.backend === backend)
    .map((info) => ({
      code: info.code,
      path: info.path,
      message: info.message,
    }));
}

function validationBlockers(
  validation: VfxValidationResult | undefined,
): VfxSupportDiagnostic[] {
  return (
    validation?.blockers.map((blocker) => ({
      code: blocker.code,
      path: blocker.path,
      message: blocker.message,
    })) ?? []
  );
}

function dedupeDiagnostics(
  diagnostics: readonly VfxSupportDiagnostic[],
): VfxSupportDiagnostic[] {
  const seen = new Set<string>();
  const deduped: VfxSupportDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.path}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
}
