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
  const warnings: VfxSupportDiagnostic[] = validationWarnings(validation);
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
  };
}

export function collectThreeBackendSupport(
  effect: ParticleEffectDefinition,
  validation?: VfxValidationResult,
): VfxBackendSupportReport {
  const warnings = validationWarnings(validation).filter(
    (warning) => !isPixiSpecificWarning(warning),
  );
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
  };
}

function validationWarnings(
  validation: VfxValidationResult | undefined,
): VfxSupportDiagnostic[] {
  return (
    validation?.warnings.map((warning) => ({
      code: warning.code,
      path: warning.path,
      message: warning.message,
    })) ?? []
  );
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

function isPixiSpecificWarning(warning: VfxSupportDiagnostic): boolean {
  return (
    warning.message.includes("Pixi 2.5D") ||
    warning.message.includes("Pixi 2D shard")
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
