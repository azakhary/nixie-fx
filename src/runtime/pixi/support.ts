import type { ParticleEffectDefinition } from "../../engine/particles";
import {
  PARTICLE_EMITTER_MODULE_KEYS,
  type ParticleEmitterModuleKey,
} from "../../engine/particleModuleSettings";
import type { VfxMaterialAssetRef, VfxTextureAssetRef } from "../assets/types";
import {
  collectParticleTextureRefs,
  createTextureAssetRef,
} from "../assets/textureRefs";

export interface PixiVfxUnsupportedModule {
  emitterId: string;
  emitterIndex: number;
  moduleKey: ParticleEmitterModuleKey;
  path: string;
}

export interface PixiVfxUnsupportedFeature {
  emitterId: string;
  emitterIndex: number;
  featureKey: string;
  path: string;
  reason: string;
}

export const PIXI_VFX_RENDERER_SUPPORTED_MODULES =
  new Set<ParticleEmitterModuleKey>([
    "velocity",
    "limitVelocityOverLifetime",
    "inheritVelocity",
    "color",
    "size",
    "rotation",
    "lifetimeByEmitterSpeed",
    "forceOverLifetime",
    "colorBySpeed",
    "sizeBySpeed",
    "rotationBySpeed",
    "externalForces",
    "noise",
    "collision",
    "triggers",
    "subEmitters",
    "textureSheetAnimation",
    "lights",
    "trails",
    "customData",
  ]);

/**
 * Material support levels (techspec §9, §12). `render.material` is NOT an emitter
 * module key (it lives next to `customData` conceptually, support.ts §37 area),
 * so it gets its own support axis.
 *
 * Tier 0 (bake), Tier 1 (fixed-function uniforms), and the Tier 2
 * ParticleContainer shader path are supported on particles. Tier-2 graphs that
 * require a custom Mesh attribute path carry artifact diagnostics instead of
 * downgrading the whole tier. Tier-3 deferred / [NA] nodes (§4.2) remain
 * `partial`: exported data-only and not rendered in preview either.
 */
export type PixiVfxMaterialTier = "tier0" | "tier1" | "tier2" | "tier3";

export type PixiVfxMaterialSupportLevel = "full" | "partial";

/**
 * Why a tier is only partially supported on particles. `undefined` for the
 * fully-supported tiers (0/1). Surfaced verbatim by the export/validation layer
 * and the editor so the limitation is communicated honestly.
 */
export const PIXI_VFX_MATERIAL_TIER_REASON: Record<
  PixiVfxMaterialTier,
  string | undefined
> = {
  tier0: undefined,
  tier1: undefined,
  tier2: undefined,
  tier3:
    "Material relies on Tier-3 deferred/[NA] nodes; exported as data-only, not rendered in preview.",
};

export const PIXI_VFX_MATERIAL_SUPPORT: Record<
  PixiVfxMaterialTier,
  PixiVfxMaterialSupportLevel
> = {
  tier0: "full",
  tier1: "full",
  tier2: "full",
  tier3: "partial",
};

export interface PixiVfxMaterialSupportFeature {
  emitterId: string;
  emitterIndex: number;
  shaderId: string;
  /** Resolved structural tier; `tier1` is the safe default for instance-only. */
  tier: PixiVfxMaterialTier;
  support: PixiVfxMaterialSupportLevel;
  path: string;
  reason?: string;
}

export function collectPixiVfxUnsupportedModules(
  effect: ParticleEffectDefinition,
): PixiVfxUnsupportedModule[] {
  const unsupported: PixiVfxUnsupportedModule[] = [];
  effect.emitters.forEach((emitter, emitterIndex) => {
    for (const moduleKey of PARTICLE_EMITTER_MODULE_KEYS) {
      if (
        !emitter.modules[moduleKey] ||
        PIXI_VFX_RENDERER_SUPPORTED_MODULES.has(moduleKey)
      ) {
        continue;
      }
      unsupported.push({
        emitterId: emitter.id,
        emitterIndex,
        moduleKey,
        path: `emitters.${emitterIndex}.modules.${moduleKey}`,
      });
    }
  });
  return unsupported;
}

export function collectPixiVfxUnsupportedFeatures(
  effect: ParticleEffectDefinition,
): PixiVfxUnsupportedFeature[] {
  const unsupported: PixiVfxUnsupportedFeature[] = [];
  effect.emitters.forEach((emitter, emitterIndex) => {
    // Mesh mode renders as 2D shard geometry, not a true 3D mesh, so it is an
    // approximate per-effect feature (default mode is `billboard`).
    if (emitter.mode === "mesh" && emitter.mesh.renderMode === "meshAsset") {
      unsupported.push({
        emitterId: emitter.id,
        emitterIndex,
        featureKey: "mode.meshAsset",
        path: `emitters.${emitterIndex}.mesh.asset`,
        reason:
          "Mesh particle assets require the Three 3D/world backend; Pixi does not render prepared 3D mesh geometry.",
      });
    } else if (emitter.mode === "mesh") {
      unsupported.push({
        emitterId: emitter.id,
        emitterIndex,
        featureKey: "mode.mesh",
        path: `emitters.${emitterIndex}.mode`,
        reason:
          "Mesh mode renders as Pixi 2D shard geometry, not true 3D mesh rendering.",
      });
    }
    // Mesh emission samples spawn positions from host-provided geometry; the
    // Pixi backend has no mesh asset loading, so such emitters degrade to
    // point emission there.
    if (emitter.spawn.shape === "mesh") {
      unsupported.push({
        emitterId: emitter.id,
        emitterIndex,
        featureKey: "spawn.shape.mesh",
        path: `emitters.${emitterIndex}.spawn.shape`,
        reason:
          "Mesh spawn shape requires the Three 3D/world backend to load emission geometry; Pixi falls back to point emission.",
      });
    }
    // `depthWrite` opts into GPU-style depth writing, which the deterministic
    // 2.5D renderer does not provide (default is off). `depthTest`/`depthInk`
    // are on by default and are the renderer's standard 2.5D draw model, so
    // they are documented globally rather than reported per effect.
    if (emitter.render.depthWrite) {
      unsupported.push({
        emitterId: emitter.id,
        emitterIndex,
        featureKey: "render.depthWrite",
        path: `emitters.${emitterIndex}.render.depthWrite`,
        reason:
          "depthWrite renders as deterministic Pixi 2.5D draw-order/ink semantics, not GPU depth-buffer writing.",
      });
    }
    if (emitter.render.shading === "lit") {
      unsupported.push({
        emitterId: emitter.id,
        emitterIndex,
        featureKey: "render.shading.lit",
        path: `emitters.${emitterIndex}.render.shading`,
        reason:
          "Lit particle shading requires the Three 3D/world backend; Pixi keeps unlit particle compositing.",
      });
    }
    if (
      emitter.modules.customData &&
      emitter.advanced.customData.channels.some(
        (channel) => channel.mode !== "constant",
      )
    ) {
      unsupported.push({
        emitterId: emitter.id,
        emitterIndex,
        featureKey: "module.customData.dynamicParameters",
        path: `emitters.${emitterIndex}.advanced.customData.channels`,
        reason:
          "Pixi delivers Shader Custom Data DynamicParameter channels as an emitter-level representative uniform; per-particle random/curve channels require the Three world-3D backend.",
      });
    }
  });
  return unsupported;
}

export function collectPixiVfxTextureRefs(
  effect: ParticleEffectDefinition,
): VfxTextureAssetRef[] {
  return collectParticleTextureRefs(effect);
}

export function createPixiVfxTextureRef(path: string): VfxTextureAssetRef {
  return createTextureAssetRef(path);
}

/**
 * Report each emitter that carries a `render.material`, classified by support
 * level (techspec §9, §502). The runtime only sees the `MaterialInstance`
 * (shaderId + overrides + mainTex), not the authoring `ShaderGraph`, so the
 * structural tier is supplied by the export/validation layer via
 * {@link PixiVfxMaterialTierLookup}; absent a lookup, an instance defaults to
 * `tier1` (fixed-function — fully supported), the safe assumption for the
 * built-in Sprite Master and any MIC-style override material. Tier-3 resolves
 * to `partial` with the per-tier data-only reason from
 * {@link PIXI_VFX_MATERIAL_TIER_REASON}.
 */
export type PixiVfxMaterialTierLookup = (
  shaderId: string,
) => PixiVfxMaterialTier | undefined;

export function collectPixiVfxMaterialSupport(
  effect: ParticleEffectDefinition,
  resolveTier?: PixiVfxMaterialTierLookup,
): PixiVfxMaterialSupportFeature[] {
  const features: PixiVfxMaterialSupportFeature[] = [];
  effect.emitters.forEach((emitter, emitterIndex) => {
    const material = emitter.render.material;
    if (!material) return;
    const tier = resolveTier?.(material.shaderId) ?? "tier1";
    const support = PIXI_VFX_MATERIAL_SUPPORT[tier];
    const reason = PIXI_VFX_MATERIAL_TIER_REASON[tier];
    features.push({
      emitterId: emitter.id,
      emitterIndex,
      shaderId: material.shaderId,
      tier,
      support,
      path: `emitters.${emitterIndex}.render.material`,
      ...(support === "partial" && reason ? { reason } : {}),
    });
  });
  return features;
}

/**
 * Collect the distinct material asset refs referenced by an effect's emitters
 * (techspec §3.2, §9). The `MainTex` of each material is already collected by
 * {@link collectPixiVfxTextureRefs}; this adds the material asset itself so the
 * manifest can list it next to textures. `shaderId` is the material asset id
 * (the built-in `sprite-master` is implicit and not emitted as an asset).
 */
export function collectPixiVfxMaterialRefs(
  effect: ParticleEffectDefinition,
  materialAssetPaths?: Readonly<Record<string, string>>,
): VfxMaterialAssetRef[] {
  const byPath = new Map<string, VfxMaterialAssetRef>();
  for (const emitter of effect.emitters) {
    const material = emitter.render.material;
    if (!material) continue;
    if (material.shaderId === SPRITE_MASTER_SUPPORT_ID) continue;
    const path = materialAssetPaths
      ? materialAssetPaths[material.shaderId]
      : material.shaderId;
    if (!path || byPath.has(path)) continue;
    byPath.set(path, { type: "material", id: material.shaderId, path });
  }
  return [...byPath.values()];
}

/** The built-in fixed-function shader — implicit, never an exported asset. */
const SPRITE_MASTER_SUPPORT_ID = "sprite-master";
