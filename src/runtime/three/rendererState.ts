import {
  BufferGeometry,
  Color,
  Group,
  Mesh,
  Texture,
  Vector3,
  type Camera,
} from "three";
import type { Vec3 } from "../../engine/math";
import {
  ParticleEffectRunner,
  type CompiledParticleScalarValue,
  type ParticleColorGradientSettings,
  type ParticleEffectDefinition,
} from "../../engine/particles";
import type { MaterialFixedDescriptor } from "../materials/artifact";
import { type MaterialBlend } from "../schema/materials";
import type { ThreeVfxInstancedView } from "./renderAdapter";
import { type ThreeParticleMaterial } from "./materialAdapter";
import { type ThreeTextureFrameSet } from "./textureFrames";
import { type ThreeTrailView } from "./trailGeometry";
import type {
  ThreeVfxEffectInstanceOptions,
  ThreeVfxParticleDebugTransform,
} from "./types";

import type { ThreeEffectLightCandidates } from "./effectLightCandidates";

export interface ThreeEmitterDrawParameters {
  sizeMultiplier: number;
  colorTint: [number, number, number, number];
  /** Compiled on set so per-particle sampling is a LUT read (no allocation). */
  sizeMultiplierValue: CompiledParticleScalarValue | null;
  colorOverLifetimeGradient: ParticleColorGradientSettings | null;
}

export interface ThreeEmitterView extends ThreeTrailView {
  meshes: Mesh[];
  instanced: ThreeVfxInstancedView | null;
  particleOrder: Uint32Array;
  material: ThreeParticleMaterial;
  geometry: BufferGeometry;
  ownedGeometry: BufferGeometry | null;
  pivotBoundsSize: Vec3;
  debugBounds: { min: Vec3; max: Vec3 };
  ownedTextures: Texture[];
  textureFrames: ThreeTextureFrameSet;
  materialFixed: MaterialFixedDescriptor | null;
  materialParticleColorUsage: { rgb: boolean; alpha: boolean };
  materialOpacityIsConstantOne: boolean;
  materialBlend: MaterialBlend | null;
  missingMaterialRef: string | null;
  unsupportedFeatures: string[];
  /** True when view.material is host-owned (materialProvider) — never disposed here. */
  hostMaterial: boolean;
  key: string;
  staticKey: string;
}

/** Per-view host state threaded into view construction and its cache key. */
export interface ThreeViewBuildContext {
  effect: ParticleEffectDefinition;
  renderGeometryOverride: {
    geometry: BufferGeometry;
    generation: number;
  } | null;
}

export interface ParticleSample {
  visible: boolean;
  position: Vec3;
  velocity: Vec3;
  speed: number;
  normalizedAge: number;
  loopAge: number;
  start: number;
  seed: number;
  width: number;
  height: number;
  depthScale: number;
  depth: number;
  rotation: Vec3;
  color: Color;
  shaderColor: Vec3;
  lightColor: [number, number, number, number];
  trailColor: [number, number, number, number];
  alpha: number;
  alignmentAxis: Vector3;
  normal: Vector3;
  emissiveStrength: number;
  textureFrameIndex: number;
}

export interface ThreeEmitterDrawResult {
  visibleParticles: number;
  bloomSourceParticles: number;
  drawCalls: number;
  instancedDrawCalls: number;
  legacyParticleDrawCalls: number;
}

/** Shared frame inputs; getters keep host changes visible without per-frame allocation. */
export interface ThreeParticleFrameContext {
  readonly root: Group;
  readonly lightCandidates: ThreeEffectLightCandidates;
  readonly runner: ParticleEffectRunner;
  readonly position: Vec3;
  readonly camera: Camera;
  readonly emitterDrawParameters: Map<string, ThreeEmitterDrawParameters>;
  readonly renderOrder: number;
  readonly emitterLayerRanks: number[];
  readonly captureDebugTransforms: boolean;
  readonly debugTransforms: ThreeVfxParticleDebugTransform[];
  readonly previewBloomEnabled: boolean;
  readonly previewBloomThreshold: number;
  readonly previewExposureStops: number;
  readonly renderGeometryOverrides: Map<
    string,
    { geometry: BufferGeometry; generation: number }
  >;
  readonly options: ThreeVfxEffectInstanceOptions;
}
