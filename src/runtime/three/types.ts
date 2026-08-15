import type {
  BufferGeometry,
  Camera,
  Material,
  Object3D,
  Scene,
  Texture,
} from "three";
import type { Vec3 } from "../../engine/math";
import type {
  ParticleColorGradientSettings,
  ParticleEffectDefinition,
  ParticleEffectRuntimeParameterPatch,
  ParticleEmitterRuntimeParameterPatch,
  ParticleMeshAssetRef,
  ParticleScalarValue,
} from "../../engine/particles";
import type { VfxTextureProvider } from "../assets/types";
import type { ShaderGraph } from "../schema/materials";

export type ThreeVfxTextureProvider = VfxTextureProvider<Texture>;

export interface ThreeVfxMeshProvider {
  getMeshGeometry(ref: ParticleMeshAssetRef): BufferGeometry | null;
}

export interface ThreeVfxMaterialProvider {
  getParticleMaterial?(
    effect: ParticleEffectDefinition,
    emitterId: string,
  ): Material | null;
}

export type ThreeVfxMaterialGraphProvider = (
  shaderId: string,
) => ShaderGraph | undefined;

/**
 * Emitter-scoped host-driven parameters for the Three backend.
 * `emissionRateMultiplier` / `initialVelocityMultiplier` run in the shared
 * engine runner (deterministic, backend-neutral); the remaining fields apply
 * at draw time (Three-only, purely visual). All fields merge over previous
 * patches and default to identity.
 */
export interface ThreeVfxEmitterRuntimeParameterPatch extends ParticleEmitterRuntimeParameterPatch {
  sizeMultiplier?: number;
  /** RGBA multiplier over the sampled particle color (alpha scales opacity). */
  colorTint?: [number, number, number, number];
  /**
   * Scalar-or-curve multiplier over the authored size, sampled per particle
   * at its normalized age (curve x = lifetime). Composes with the authored
   * size curves and `sizeMultiplier`; normalized + compiled to a LUT on set,
   * so per-frame sampling neither allocates nor re-evaluates the curve.
   * Partial values are fine (e.g. `{ mode: "curve", curve: [...] }`); `null`
   * restores the authored sizing.
   */
  sizeMultiplierValue?: Partial<ParticleScalarValue> | null;
  /**
   * Replaces the authored color-over-lifetime gradient at draw time (applies
   * even when the emitter's color module is authored off; the colorBySpeed /
   * lights compositions are bypassed while overridden). Normalized on set;
   * partial values are fine. `null` restores the authored gradient.
   */
  colorOverLifetimeGradient?: Partial<ParticleColorGradientSettings> | null;
}

export interface ThreeVfxRendererOptions {
  scene?: Scene;
  camera: Camera;
  textureProvider?: ThreeVfxTextureProvider;
  meshProvider?: ThreeVfxMeshProvider;
  materialProvider?: ThreeVfxMaterialProvider;
  materialGraphProvider?: ThreeVfxMaterialGraphProvider;
  parent?: Object3D;
  clockSpace?: "world" | "local";
  previewBloomEnabled?: boolean;
  previewBloomThreshold?: number;
  previewExposureStops?: number;
  captureDebugTransforms?: boolean;
}

export interface ThreeVfxEffectInstanceOptions {
  effect: unknown;
  camera: Camera;
  textureProvider?: ThreeVfxTextureProvider;
  meshProvider?: ThreeVfxMeshProvider;
  materialProvider?: ThreeVfxMaterialProvider;
  materialGraphProvider?: ThreeVfxMaterialGraphProvider;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  seed?: number;
  timeSeconds?: number;
  autoStart?: boolean;
  runtimeParameters?: ParticleEffectRuntimeParameterPatch;
  previewBloomEnabled?: boolean;
  previewBloomThreshold?: number;
  previewExposureStops?: number;
  captureDebugTransforms?: boolean;
}

export interface ThreeVfxParticleDebugTransform {
  emitterId: string;
  emitterIndex: number;
  particleIndex: number;
  mode: "billboard" | "pixiShard" | "meshAsset";
  position: Vec3;
  normal: Vec3;
  width: number;
  height: number;
  depth: number;
  localBounds: { min: Vec3; max: Vec3 };
  matrix: number[];
}

export interface ThreeVfxEffectStats {
  activeParticles: number;
  visibleParticles: number;
  capacity: number;
  emittedLastFrame: number;
  bloomSourceParticles: number;
  drawCalls: number;
  instancedDrawCalls: number;
  legacyParticleDrawCalls: number;
  missingMeshRefs: ParticleMeshAssetRef[];
  missingMaterialRefs: string[];
  unsupportedFeatures: string[];
}

export interface ThreeVfxRendererStats extends ThreeVfxEffectStats {
  effectCount: number;
}
