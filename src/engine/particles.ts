import { type Vec2, type Vec3, type Vec4 } from "./math";
import {
  normalizeOptionalMaterialInstance,
  type MaterialInstance,
} from "./materialInstance";
export type { MaterialInstance } from "./materialInstance";
import {
  createBareParticleModuleSettings,
  createDefaultParticleAdvancedModules,
  createDefaultParticleModuleSettings,
  normalizeEmitterModules,
  normalizeParticleAdvancedModules,
  particleSpeedRangeRatio,
  type ParticleAdvancedModuleSettings,
  type ParticleEmitterModuleSettings,
  type ParticleSubEmitterSlotSettings,
  type ParticleVec3ScalarSettings,
} from "./particleModuleSettings";
export type {
  ParticleAdvancedModuleSettings,
  ParticleEmitterModuleKey,
  ParticleEmitterModuleSettings,
  ParticleVec3ScalarSettings,
  ParticleVelocityOverLifetimeSettings,
  ParticleVelocityOverLifetimeSpace,
} from "./particleModuleSettings";

export type ParticleEmitterMode = "billboard" | "mesh";
export type VfxTargetProfile = "pixi-ui-2d" | "three-world-3d" | "portable";
export type ParticleBlendMode = "alpha" | "additive" | "premultiplied";
export type ParticleRenderShading = "unlit" | "lit";
export type ParticleRenderAlignment =
  "faceCamera" | "spawnDirection" | "velocity" | "vector";
export type ParticleRenderAlignAxis =
  "screen" | "spawnDirection" | "velocity" | "vector";
export type ParticleRenderFacing = "cameraPlane" | "cameraPosition" | "off";
export type ParticleSortMode =
  | "none"
  | "distanceFarFirst"
  | "distanceNearFirst"
  | "oldestFirst"
  | "youngestFirst";
/**
 * Where the particle's opacity comes from. `textureAlpha` uses the texture's
 * own alpha channel (default). The other channel/luminance options derive a
 * per-pixel alpha mask from an RGB texture so artists can alpha-blend a texture
 * that has no usable alpha channel instead of resorting to additive blending.
 * `constant` ignores the source channel and treats the sprite as fully opaque.
 */
export type ParticleOpacitySource =
  | "textureAlpha"
  | "red"
  | "green"
  | "blue"
  | "luminance"
  | "inverseLuminance"
  | "constant";
export type ParticleSpawnShape =
  "point" | "circle" | "box" | "cone" | "sphere" | "hemisphere" | "mesh";
/** Where on the emission mesh particles are born ("mesh" spawn shape). */
export type ParticleSpawnMeshEmitFrom = "surface" | "vertices";
export type ParticleSpawnArcMode =
  "random" | "loop" | "pingPong" | "burstSpread";
export type ParticleSpawnEmitFrom = "base" | "volume";
export type ParticleSimulationSpace = "world" | "local";
export type ParticleBillboardShape = "circle" | "square";
export type ParticleMeshTemplate = "grassShard" | "triangleShard" | "quadShard";
export type ParticleMeshRenderMode = "pixiShard" | "meshAsset";
export type ParticleScalarValueMode =
  "constant" | "random" | "curve" | "randomCurve";
export type ParticleGradientMode = "blend" | "fixed";

/**
 * Which normalized 0..1 quantity drives a curve's x-axis. "lifetime" is the
 * default (normalized particle age); "loopAge" samples against the emitter's
 * normalized loop time instead.
 */
export type ParticleScalarXAxis = "lifetime" | "loopAge";

const PARTICLE_SCALAR_VALUE_LIMIT = 100000;
export const PARTICLE_HDR_COLOR_INTENSITY_MAX_EXPOSURE = 50;
export const PARTICLE_HDR_COLOR_INTENSITY_VALUE_LIMIT =
  2 ** PARTICLE_HDR_COLOR_INTENSITY_MAX_EXPOSURE;

export interface ParticleCurvePoint {
  x: number;
  y: number;
  /** Legacy symmetric tangent. Used when side-specific slopes are not authored. */
  slope?: number;
  /** Incoming tangent slope at this point. */
  slopeIn?: number;
  /** Outgoing tangent slope at this point. */
  slopeOut?: number;
  /** Incoming Bezier handle length as a fraction of the previous segment. */
  weightIn?: number;
  /** Outgoing Bezier handle length as a fraction of the next segment. */
  weightOut?: number;
}

export interface ParticleScalarValue {
  mode: ParticleScalarValueMode;
  value: number;
  min: number;
  max: number;
  curve: ParticleCurvePoint[];
  curveB: ParticleCurvePoint[];
  editorMin: number;
  editorMax: number;
  /** Output gain applied to the whole curve (curve / randomCurve modes). Defaults to 1. */
  multiplier?: number;
  /** Normalized parameter driving the curve x-axis. Defaults to "lifetime". */
  xAxis?: ParticleScalarXAxis;
}

export interface ParticleGradientColorStop {
  position: number;
  color: Vec3;
}

export interface ParticleGradientAlphaStop {
  position: number;
  alpha: number;
}

export interface ParticleColorGradientSettings {
  mode: ParticleGradientMode;
  colorStops: ParticleGradientColorStop[];
  alphaStops: ParticleGradientAlphaStop[];
}

export interface CompiledParticleScalarValue {
  mode: ParticleScalarValueMode;
  value: number;
  min: number;
  max: number;
  multiplier: number;
  samples: number;
  curve: Float32Array;
  curveB: Float32Array;
}

export interface CompiledParticleGradient {
  mode: ParticleGradientMode;
  samples: number;
  rgba: Float32Array;
}

export interface ParticleNumberRange {
  min: number;
  max: number;
}

export interface ParticleVec3Range {
  min: Vec3;
  max: Vec3;
}

export interface ParticleBurstSchedule {
  time: number;
  count: number;
  cycles: number;
  interval: number;
  probability: number;
}

export interface ParticleSpawnSettings {
  rate: number;
  rateValue: ParticleScalarValue;
  rateOverDistance: number;
  rateOverDistanceValue: ParticleScalarValue;
  bursts: ParticleBurstSchedule[];
  shape: ParticleSpawnShape;
  radius: number;
  radiusValue: ParticleScalarValue;
  box: Vec3;
  angle: number;
  radiusThickness: number;
  arc: number;
  arcMode: ParticleSpawnArcMode;
  arcSpread: number;
  arcSpeedValue: ParticleScalarValue;
  length: number;
  emitFrom: ParticleSpawnEmitFrom;
  /**
   * Emission source mesh ("mesh" spawn shape). The engine never loads files;
   * hosts resolve this ref (or inject geometry directly) via
   * ParticleEffectRunner.setEmissionGeometry.
   */
  meshAsset: ParticleMeshAssetRef | null;
  meshEmitFrom: ParticleSpawnMeshEmitFrom;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  simulationSpace: ParticleSimulationSpace;
  alignToDirection: boolean;
  randomDirectionAmount: number;
  sphericalDirectionAmount: number;
  randomPositionAmount: number;
}

/**
 * Color over the particle's INITIAL value (Niagara "Initialize Particle").
 * The over-life `color` gradient multiplies this base color each frame.
 */
export type ParticleColorValueMode =
  "constant" | "random" | "gradient" | "randomGradient";

export interface ParticleColorValue {
  mode: ParticleColorValueMode;
  /** Start color (constant base / random endpoint A). */
  color: Vec4;
  /** Second color (random endpoint B). */
  colorB: Vec4;
  /** Sampled by per-particle seed for gradient/randomGradient modes. */
  gradient: ParticleColorGradientSettings;
  /** Second gradient (randomGradient). */
  gradientB: ParticleColorGradientSettings;
  /** Initial alpha value mode, independent of RGB selection. */
  alpha: ParticleScalarValue;
  /** RGB multiplier (HDR-ready; preview clamps to LDR). */
  intensity: ParticleScalarValue;
}

export type ParticleInitializeVelocityMode = "vector" | "shapeDirection";

export interface ParticleInitializeVelocity {
  mode: ParticleInitializeVelocityMode;
  /** Per-axis minimum for `vector` mode. */
  min: Vec3;
  /** Per-axis maximum for `vector` mode. */
  max: Vec3;
  /** Speed along the sampled shape direction for `shapeDirection` mode. */
  speed: ParticleScalarValue;
}

/**
 * Niagara-style "Initialize Particle": the single source of per-particle
 * INITIAL values. Over-lifetime modules (Color/Size over Lifetime) compose
 * multiplicatively over these base values.
 */
export interface ParticleInitializeSettings {
  lifetime: ParticleScalarValue;
  color: ParticleColorValue;
  size: ParticleScalarValue;
  size3D: ParticleVec3ScalarSettings;
  /**
   * Billboard-only: when true, Start Size samples X from `size3D.x` and Y from
   * `size3D.y` (non-uniform / random non-uniform) instead of the uniform
   * `size` scalar. Off (default) keeps the legacy single-scalar behavior and
   * matches the mesh path's per-axis `size3D` authoring.
   */
  startSizeSeparateAxes: boolean;
  rotation: ParticleScalarValue;
  rotation3D: ParticleVec3ScalarSettings;
  /**
   * Billboard authoring toggle for full XYZ initial orientation. Mesh emitters
   * have always consumed `rotation3D`; billboards keep legacy scalar Z rotation
   * while this is off and expose all three axes while it is on.
   */
  startRotationSeparateAxes: boolean;
  angularVelocitySeparateAxes: boolean;
  angularVelocity: ParticleScalarValue;
  angularVelocity3D: ParticleVec3ScalarSettings;
  velocity: ParticleInitializeVelocity;
}

export interface ParticleForceSettings {
  gravity: number;
  gravityValue: ParticleScalarValue;
  drag: number;
  dragValue: ParticleScalarValue;
}

export interface ParticleRenderSettings {
  blend: ParticleBlendMode;
  /**
   * Surface lighting model. `unlit` keeps classic particle/emissive behavior.
   * `lit` is honored by the Three world backend so 3D mesh particles can react
   * to preview/game scene lighting; Pixi exports it as an unsupported feature.
   */
  shading: ParticleRenderShading;
  depthTest: boolean;
  depthWrite: boolean;
  depthInk: boolean;
  /**
   * "Order in Layer" rendering. Emitter render views draw from lowest to
   * highest order, so lower numbers render first (background) and higher numbers
   * draw on top (foreground). Ties keep the authored emitter array order.
   */
  orderInLayer: number;
  /**
   * Per-emitter particle ordering. `distanceFarFirst` is the alpha-correct
   * painter order; `distanceNearFirst` keeps the legacy reversed Pixi order.
   */
  sortMode: ParticleSortMode;
  /**
   * Deprecated legacy orientation field. New code should use `alignAxis` and
   * `facing`; the normalizer writes this field for one migration cycle.
   */
  alignment: ParticleRenderAlignment;
  /**
   * Which local billboard axis is pinned before Start Rotation is added.
   * `screen` keeps the billboard screen-up; the other modes pin the local
   * alignment axis to velocity, spawn direction, or a fixed vector.
   */
  alignAxis: ParticleRenderAlignAxis;
  /**
   * Whether the aligned billboard then spins around its pinned axis to face the
   * camera. `off` preserves legacy Three vector/velocity plate orientation.
   */
  facing: ParticleRenderFacing;
  /** Direction used when `alignAxis === "vector"`. */
  alignmentVector: Vec3;
  /**
   * Which texture channel (or luminance) feeds the particle's alpha. When this
   * is anything other than `textureAlpha`, the runtime derives an alpha mask
   * from the source texture so artists can alpha-blend an RGB texture.
   */
  opacitySource: ParticleOpacitySource;
  /** Invert the derived opacity (1 - alpha). Has no effect on `textureAlpha`. */
  opacityInvert: boolean;
  /**
   * Project-relative path (under the project `assets/` folder) of the texture
   * applied to particles. `null` falls back to the procedural billboard shape.
   */
  texture: string | null;
  /**
   * Material assigned to this emitter (techspec §8). Material XOR texture: when
   * a material is assigned the emitter renders through the material's compiled
   * artifact (its `mainTex` feeds the shared texture); when `null` the emitter
   * uses the texture branch (the implicit built-in "Sprite Master" material).
   */
  material: MaterialInstance | null;
}

export interface ParticleBillboardSettings {
  shape: ParticleBillboardShape;
  sizeStart: number;
  sizeEnd: number;
  sizeValue: ParticleScalarValue;
  separateAxes: boolean;
  sizeStartY: number;
  sizeEndY: number;
  sizeValueY: ParticleScalarValue;
  softness: number;
  /** Signed pivot offset in local sprite space, fraction of size. [0,0]=center;
   *  +X = toward sprite right, +Y = toward sprite top (up). Twin of mesh.pivot. */
  pivot: Vec2;
}

export interface ParticleMeshSettings {
  renderMode: ParticleMeshRenderMode;
  template: ParticleMeshTemplate;
  asset: ParticleMeshAssetRef | null;
  sizeStart: number;
  sizeEnd: number;
  sizeValue: ParticleScalarValue;
  separateAxes: boolean;
  sizeValueY: ParticleScalarValue;
  sizeValueZ: ParticleScalarValue;
  thickness: number;
  pivot: Vec3;
  flipWinding: boolean;
  recomputeNormals: boolean;
}

export interface ParticleMeshAssetRef {
  type: "mesh";
  id: string;
  path: string;
  name?: string;
  bounds?: {
    min: Vec3;
    max: Vec3;
  };
}

export interface ParticleColorSettings {
  start: Vec4;
  end: Vec4;
  gradient: ParticleColorGradientSettings;
}

export interface ParticleEmitterDefinition {
  id: string;
  name: string;
  enabled: boolean;
  mode: ParticleEmitterMode;
  maxParticles: number;
  duration: number;
  loop: boolean;
  timeline: ParticleEmitterTimelineDefinition;
  modules: ParticleEmitterModuleSettings;
  spawn: ParticleSpawnSettings;
  /** Per-particle INITIAL values (lifetime/color/size/rotation/velocity). */
  initializeParticle: ParticleInitializeSettings;
  forces: ParticleForceSettings;
  render: ParticleRenderSettings;
  billboard: ParticleBillboardSettings;
  mesh: ParticleMeshSettings;
  /** Color OVER LIFETIME multiplier gradient (composes over init color). */
  color: ParticleColorSettings;
  advanced: ParticleAdvancedModuleSettings;
}

export interface ParticleEffectDefinition {
  app: "vfx-editor";
  kind: "particle-effect";
  version: 1;
  targetProfile: VfxTargetProfile;
  id: string;
  name: string;
  timeline: ParticleEffectTimelineDefinition;
  emitters: ParticleEmitterDefinition[];
}

export interface ParticleEffectTimelineDefinition {
  frameRate: number;
  duration: number;
  loop: ParticleTimelineLoopDefinition;
  groups: ParticleTimelineGroupDefinition[];
}

export interface ParticleTimelineLoopDefinition {
  enabled: boolean;
  start: number;
  end: number;
}

export interface ParticleTimelineGroupDefinition {
  id: string;
  name: string;
  collapsed: boolean;
  hidden: boolean;
  locked: boolean;
}

export interface ParticleEmitterTimelineDefinition {
  start: number;
  groupId: string | null;
  locked: boolean;
}

export interface ParticleEffectRuntimeStats {
  activeParticles: number;
  capacity: number;
  emittedLastFrame: number;
  uploadBytesLastFrame: number;
}

export type ParticleEffectEventKind =
  "birth" | "death" | "normalizedTime" | "collision";

export interface ParticleEffectEvent {
  kind: ParticleEffectEventKind;
  eventName: string;
  effectId: string;
  emitterId: string;
  emitterIndex: number;
  particleIndex: number;
  particleSeed: number;
  timeSeconds: number;
  effectAge: number;
  particleAge: number;
  normalizedAge: number;
  position: Vec3;
  velocity: Vec3;
}

export interface ParticleSubEmitterSpawnRequest {
  hook: ParticleEffectEventKind;
  effectFile: string;
  sourceEffectId: string;
  sourceEmitterId: string;
  sourceEmitterIndex: number;
  sourceParticleIndex: number;
  sourceParticleSeed: number;
  timeSeconds: number;
  position: Vec3;
  velocity: Vec3;
  normalizedAge: number;
  inheritColor: boolean;
  inheritSize: boolean;
  inheritedColor: Vec4 | null;
  inheritedSize: number | null;
  depth: number;
  nextDepth: number;
  maxDepth: number;
}

export interface ParticleEffectRunnerOptions {
  subEmitterDepth?: number;
  maxSubEmitterDepth?: number;
  maxEventsPerFrame?: number;
  maxSubEmitterRequestsPerFrame?: number;
}

export interface ParticleEffectRuntimeParameters {
  emissionRateMultiplier: number;
  initialVelocityMultiplier: number;
}

export type ParticleEffectRuntimeParameterPatch =
  Partial<ParticleEffectRuntimeParameters>;

/**
 * Emitter-scoped runtime multipliers a host can drive per frame without
 * touching the effect definition. They compose multiplicatively with the
 * effect-level ParticleEffectRuntimeParameters.
 */
export interface ParticleEmitterRuntimeParameters {
  emissionRateMultiplier: number;
  initialVelocityMultiplier: number;
}

export type ParticleEmitterRuntimeParameterPatch =
  Partial<ParticleEmitterRuntimeParameters>;

/** Options for ParticleEffectRunner.emitBurst — an immediate host-triggered burst. */
export interface ParticleBurstEmitOptions {
  /** Particles to emit (capacity-clamped). Default 1. */
  count?: number;
  /** Temporary emitter position for just this burst (world units). */
  position?: Vec3;
}

export const PARTICLE_INSTANCE_STRIDE = 18;
export const PARTICLE_RUNTIME_VECTOR_STRIDE = 3;
export const PARTICLE_RUNTIME_FLAG_LOCAL_SPACE = 1 << 0;
export const PARTICLE_RUNTIME_FLAG_ALIGN_TO_DIRECTION = 1 << 1;
export const PARTICLE_SCALAR_CURVE_POINT_LIMIT = 8;
export const PARTICLE_GRADIENT_STOP_LIMIT = 8;
export const PARTICLE_BURST_SCHEDULE_LIMIT = 16;
export const PARTICLE_TAU = Math.PI * 2;

const PARTICLE_CURVE_DEFAULT_WEIGHT = 1 / 3;
const PARTICLE_CURVE_SLOPE_LIMIT = 1000;
const PARTICLE_CURVE_WEIGHT_LIMIT = 1;
const PARTICLE_SCALAR_INTEGRAL_STEPS = 64;
const PARTICLE_BURST_CATCHUP_LOOP_LIMIT = 256;
const PARTICLE_TIME_EPSILON = 0.000001;
const PARTICLE_TRIGGER_FLAG_NORMALIZED_TIME = 1 << 0;
const PARTICLE_TRIGGER_FLAG_COLLISION = 1 << 1;
const DEFAULT_PARTICLE_EVENT_LIMIT = 4096;
const DEFAULT_SUB_EMITTER_REQUEST_LIMIT = 512;
const DEFAULT_SUB_EMITTER_DEPTH_LIMIT = 4;
const DEFAULT_EFFECT_TIMELINE_FRAME_RATE = 30;
const DEFAULT_EFFECT_TIMELINE_DURATION = 2;
const EFFECT_TIMELINE_DURATION_HEADROOM = 1.15;
const EFFECT_TIMELINE_DURATION_MAX = 100000;

const FULL_EMITTER_MODULES = createDefaultParticleModuleSettings();
const BARE_EMITTER_MODULES = createBareParticleModuleSettings();

const DEFAULT_EMITTER: ParticleEmitterDefinition = {
  id: "emitter-1",
  name: "Emitter",
  enabled: true,
  mode: "billboard",
  maxParticles: 256,
  duration: 1.2,
  loop: true,
  timeline: {
    start: 0,
    groupId: null,
    locked: false,
  },
  modules: { ...FULL_EMITTER_MODULES },
  spawn: {
    rate: 80,
    rateValue: createConstantParticleScalar(80, 0, 3000),
    rateOverDistance: 0,
    rateOverDistanceValue: createConstantParticleScalar(0, 0, 1000),
    bursts: [{ time: 0, count: 18, cycles: 1, interval: 0.1, probability: 1 }],
    shape: "circle",
    radius: 0.35,
    radiusValue: createConstantParticleScalar(0.35, 0, 24),
    box: [0.6, 0.2, 0.6],
    angle: 25,
    radiusThickness: 1,
    arc: 360,
    arcMode: "random",
    arcSpread: 0,
    arcSpeedValue: createConstantParticleScalar(0, -360, 360),
    length: 5,
    emitFrom: "base",
    meshAsset: null,
    meshEmitFrom: "surface",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    simulationSpace: "world",
    alignToDirection: false,
    randomDirectionAmount: 0,
    sphericalDirectionAmount: 0,
    randomPositionAmount: 0,
  },
  initializeParticle: {
    lifetime: createRandomParticleScalar(0.45, 0.85, 0.02, 30),
    color: createWhiteParticleColorValue(),
    size: createConstantParticleScalar(1, 0, 24),
    size3D: {
      x: createConstantParticleScalar(1, 0, 24),
      y: createConstantParticleScalar(1, 0, 24),
      z: createConstantParticleScalar(1, 0, 24),
    },
    startSizeSeparateAxes: false,
    rotation: createRandomParticleScalar(
      0,
      PARTICLE_TAU,
      -PARTICLE_TAU,
      PARTICLE_TAU,
    ),
    rotation3D: {
      x: createConstantParticleScalar(0, -PARTICLE_TAU, PARTICLE_TAU),
      y: createConstantParticleScalar(0, -PARTICLE_TAU, PARTICLE_TAU),
      z: createRandomParticleScalar(
        0,
        PARTICLE_TAU,
        -PARTICLE_TAU,
        PARTICLE_TAU,
      ),
    },
    startRotationSeparateAxes: false,
    angularVelocitySeparateAxes: false,
    angularVelocity: createRandomParticleScalar(-9, 9, -24, 24),
    angularVelocity3D: {
      x: createConstantParticleScalar(0, -24, 24),
      y: createConstantParticleScalar(0, -24, 24),
      z: createRandomParticleScalar(-9, 9, -24, 24),
    },
    velocity: {
      mode: "shapeDirection",
      min: [-0.7, 2.2, -0.7],
      max: [0.7, 3.4, 0.7],
      speed: createConstantParticleScalar(0, 0, 80),
    },
  },
  forces: {
    gravity: 4.8,
    gravityValue: createConstantParticleScalar(4.8, -80, 80),
    drag: 0.05,
    dragValue: createConstantParticleScalar(0.05, 0, 12),
  },
  render: {
    blend: "alpha",
    shading: "unlit",
    depthTest: true,
    depthWrite: false,
    depthInk: true,
    orderInLayer: 0,
    sortMode: "distanceFarFirst",
    alignment: "faceCamera",
    alignAxis: "screen",
    facing: "cameraPlane",
    alignmentVector: [0, 1, 0],
    opacitySource: "textureAlpha",
    opacityInvert: false,
    texture: null,
    material: null,
  },
  billboard: {
    shape: "circle",
    sizeStart: 0.28,
    sizeEnd: 0.05,
    sizeValue: createCurveParticleScalar(0.28, 0.05, 0.001, 24),
    separateAxes: false,
    sizeStartY: 0.28,
    sizeEndY: 0.05,
    sizeValueY: createCurveParticleScalar(0.28, 0.05, 0.001, 24),
    softness: 0.4,
    pivot: [0, 0],
  },
  mesh: {
    renderMode: "pixiShard",
    template: "triangleShard",
    asset: null,
    sizeStart: 0.28,
    sizeEnd: 0.08,
    sizeValue: createCurveParticleScalar(0.28, 0.08, 0.001, 24),
    separateAxes: false,
    sizeValueY: createCurveParticleScalar(0.28, 0.08, 0.001, 24),
    sizeValueZ: createCurveParticleScalar(0.28, 0.08, 0.001, 24),
    thickness: 0.5,
    pivot: [0, 0, 0],
    flipWinding: false,
    recomputeNormals: false,
  },
  color: {
    start: [0.75, 1.0, 0.48, 0.95],
    end: [0.35, 0.75, 0.28, 0.0],
    gradient: createParticleGradient(
      [0.75, 1.0, 0.48, 0.95],
      [0.35, 0.75, 0.28, 0.0],
    ),
  },
  advanced: createDefaultParticleAdvancedModules(),
};

const BARE_EMITTER: ParticleEmitterDefinition = {
  ...DEFAULT_EMITTER,
  maxParticles: 128,
  duration: 1,
  modules: { ...BARE_EMITTER_MODULES },
  spawn: {
    rate: 24,
    rateValue: createConstantParticleScalar(24, 0, 3000),
    rateOverDistance: 0,
    rateOverDistanceValue: createConstantParticleScalar(0, 0, 1000),
    bursts: [],
    shape: "point",
    radius: 0,
    radiusValue: createConstantParticleScalar(0, 0, 24),
    box: [0, 0, 0],
    angle: 25,
    radiusThickness: 1,
    arc: 360,
    arcMode: "random",
    arcSpread: 0,
    arcSpeedValue: createConstantParticleScalar(0, -360, 360),
    length: 5,
    emitFrom: "base",
    meshAsset: null,
    meshEmitFrom: "surface",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    simulationSpace: "world",
    alignToDirection: false,
    randomDirectionAmount: 0,
    sphericalDirectionAmount: 0,
    randomPositionAmount: 0,
  },
  initializeParticle: {
    lifetime: createConstantParticleScalar(1, 0.02, 30),
    color: createWhiteParticleColorValue(),
    size: createConstantParticleScalar(1, 0, 24),
    size3D: {
      x: createConstantParticleScalar(1, 0, 24),
      y: createConstantParticleScalar(1, 0, 24),
      z: createConstantParticleScalar(1, 0, 24),
    },
    startSizeSeparateAxes: false,
    rotation: createConstantParticleScalar(0, -PARTICLE_TAU, PARTICLE_TAU),
    rotation3D: {
      x: createConstantParticleScalar(0, -PARTICLE_TAU, PARTICLE_TAU),
      y: createConstantParticleScalar(0, -PARTICLE_TAU, PARTICLE_TAU),
      z: createConstantParticleScalar(0, -PARTICLE_TAU, PARTICLE_TAU),
    },
    startRotationSeparateAxes: false,
    angularVelocitySeparateAxes: false,
    angularVelocity: createConstantParticleScalar(0, -24, 24),
    angularVelocity3D: {
      x: createConstantParticleScalar(0, -24, 24),
      y: createConstantParticleScalar(0, -24, 24),
      z: createConstantParticleScalar(0, -24, 24),
    },
    velocity: {
      mode: "shapeDirection",
      min: [0, 0, 0],
      max: [0, 0, 0],
      speed: createConstantParticleScalar(0, 0, 80),
    },
  },
  forces: {
    gravity: 0,
    gravityValue: createConstantParticleScalar(0, -80, 80),
    drag: 0,
    dragValue: createConstantParticleScalar(0, 0, 12),
  },
  billboard: {
    shape: "circle",
    sizeStart: 0.28,
    sizeEnd: 0.28,
    sizeValue: createConstantParticleScalar(0.28, 0.001, 24),
    separateAxes: false,
    sizeStartY: 0.28,
    sizeEndY: 0.28,
    sizeValueY: createConstantParticleScalar(0.28, 0.001, 24),
    softness: 0.4,
    pivot: [0, 0],
  },
  mesh: {
    renderMode: "pixiShard",
    template: "triangleShard",
    asset: null,
    sizeStart: 0.28,
    sizeEnd: 0.28,
    sizeValue: createConstantParticleScalar(0.28, 0.001, 24),
    separateAxes: false,
    sizeValueY: createConstantParticleScalar(0.28, 0.001, 24),
    sizeValueZ: createConstantParticleScalar(0.28, 0.001, 24),
    thickness: 0.5,
    pivot: [0, 0, 0],
    flipWinding: false,
    recomputeNormals: false,
  },
  color: {
    start: [1, 1, 1, 1],
    end: [1, 1, 1, 1],
    gradient: createParticleGradient([1, 1, 1, 1], [1, 1, 1, 1]),
  },
  advanced: createDefaultParticleAdvancedModules(),
};

export function createConstantParticleScalar(
  value: number,
  editorMin: number,
  editorMax: number,
): ParticleScalarValue {
  return normalizeParticleScalarValue(
    { mode: "constant", value },
    value,
    editorMin,
    editorMax,
  );
}

export function createRandomParticleScalar(
  min: number,
  max: number,
  editorMin: number,
  editorMax: number,
): ParticleScalarValue {
  return normalizeParticleScalarValue(
    { mode: "random", min, max, value: (min + max) * 0.5 },
    (min + max) * 0.5,
    editorMin,
    editorMax,
  );
}

export function createCurveParticleScalar(
  start: number,
  end: number,
  editorMin: number,
  editorMax: number,
): ParticleScalarValue {
  return normalizeParticleScalarValue(
    {
      mode: "curve",
      value: start,
      min: Math.min(start, end),
      max: Math.max(start, end),
      curve: [
        { x: 0, y: start },
        { x: 1, y: end },
      ],
    },
    start,
    editorMin,
    editorMax,
  );
}

export function createParticleGradient(
  start: Vec4,
  end: Vec4,
): ParticleColorGradientSettings {
  return normalizeParticleGradient(
    {
      mode: "blend",
      colorStops: [
        { position: 0, color: [start[0], start[1], start[2]] },
        { position: 1, color: [end[0], end[1], end[2]] },
      ],
      alphaStops: [
        { position: 0, alpha: start[3] },
        { position: 1, alpha: end[3] },
      ],
    },
    start,
    end,
  );
}

/** White, fully opaque initial color (constant mode), intensity 1. */
export function createWhiteParticleColorValue(): ParticleColorValue {
  const white: Vec4 = [1, 1, 1, 1];
  return {
    mode: "constant",
    color: [...white],
    colorB: [...white],
    gradient: createParticleGradient([...white], [...white]),
    gradientB: createParticleGradient([...white], [...white]),
    alpha: createConstantParticleScalar(1, 0, 1),
    intensity: createConstantParticleScalar(1, 0, 16),
  };
}

/**
 * Per-particle INITIAL color (fixed for the particle's whole life). The
 * intensity multiplier is applied separately by the renderer; this returns the
 * base RGBA only.
 */
export function sampleInitialParticleColor(
  color: ParticleColorValue,
  seed: number,
  normalizedAge = 0,
  loopAgeT?: number,
): Vec4 {
  return sampleInitialParticleColorInto(
    color,
    seed,
    normalizedAge,
    loopAgeT,
    [1, 1, 1, 1],
    [1, 1, 1, 1],
  );
}

export function sampleInitialParticleColorInto(
  color: ParticleColorValue,
  seed: number,
  normalizedAge: number,
  loopAgeT: number | undefined,
  out: Vec4,
  scratch: Vec4,
): Vec4 {
  const mix = clampNumber(seed, 0, 1);
  const alpha = clampNumber(
    sampleParticleScalarValue(color.alpha, normalizedAge, seed, loopAgeT),
    0,
    1,
  );
  if (color.mode === "random") {
    out[0] = color.color[0] + (color.colorB[0] - color.color[0]) * mix;
    out[1] = color.color[1] + (color.colorB[1] - color.color[1]) * mix;
    out[2] = color.color[2] + (color.colorB[2] - color.color[2]) * mix;
    out[3] = alpha;
    return out;
  }
  if (color.mode === "gradient") {
    sampleParticleGradientColor(color.gradient, mix, out);
    out[3] = sampleParticleGradientAlpha(color.gradient, mix) * alpha;
    return out;
  }
  if (color.mode === "randomGradient") {
    sampleParticleGradientColor(color.gradient, mix, out);
    out[3] = sampleParticleGradientAlpha(color.gradient, mix);
    sampleParticleGradientColor(color.gradientB, mix, scratch);
    scratch[3] = sampleParticleGradientAlpha(color.gradientB, mix);
    out[0] += (scratch[0] - out[0]) * mix;
    out[1] += (scratch[1] - out[1]) * mix;
    out[2] += (scratch[2] - out[2]) * mix;
    out[3] = (out[3] + (scratch[3] - out[3]) * mix) * alpha;
    return out;
  }
  out[0] = color.color[0];
  out[1] = color.color[1];
  out[2] = color.color[2];
  out[3] = alpha;
  return out;
}

/** Per-particle INITIAL color intensity (RGB multiplier). */
export function sampleInitialParticleColorIntensity(
  color: ParticleColorValue,
  normalizedAge: number,
  seed: number,
  loopAgeT?: number,
): number {
  return sampleParticleScalarValue(
    color.intensity,
    normalizedAge,
    seed,
    loopAgeT,
  );
}

export function createDefaultParticleEffect(
  id = "new-particle-effect",
  name = "New Particle Effect",
): ParticleEffectDefinition {
  return normalizeParticleEffect({
    app: "vfx-editor",
    kind: "particle-effect",
    version: 1,
    id,
    name,
    // Seed one emitter so a freshly created / fallback effect always renders
    // its module panels (B1). An empty `emitters` array hides every
    // per-emitter panel in the editor's right rail.
    emitters: [createDefaultParticleEmitter()],
  });
}

export function createDefaultParticleEmitter(
  id = "emitter-1",
  name = "Emitter",
): ParticleEmitterDefinition {
  return normalizeEmitter(
    {
      ...BARE_EMITTER,
      id,
      name,
    },
    0,
  );
}

export function normalizeParticleEffect(
  value: unknown,
): ParticleEffectDefinition {
  const source = isRecord(value) ? value : {};
  const emittersRaw = Array.isArray(source.emitters) ? source.emitters : [];
  const emitters = emittersRaw.map((item, index) =>
    normalizeEmitter(item, index),
  );
  const timeline = normalizeEffectTimeline(source.timeline, emitters);
  applyLegacyTimelineGrouping(source.timeline, emitters, timeline);
  return {
    app: "vfx-editor",
    kind: "particle-effect",
    version: 1,
    targetProfile: normalizeTargetProfile(source.targetProfile),
    id: safeId(source.id, "particle-effect"),
    name: safeString(source.name, "Particle Effect"),
    timeline,
    emitters,
  };
}

export function normalizeTargetProfile(value: unknown): VfxTargetProfile {
  return value === "three-world-3d" || value === "portable"
    ? value
    : "pixi-ui-2d";
}

export function cloneParticleEffect(
  effect: ParticleEffectDefinition,
): ParticleEffectDefinition {
  return normalizeParticleEffect(effect);
}

export function makeParticleEffectFileName(
  effect: ParticleEffectDefinition,
): string {
  return `${safeId(effect.id, "particle-effect")}.json`;
}

function applyLegacyTimelineGrouping(
  rawTimeline: unknown,
  emitters: ParticleEmitterDefinition[],
  timeline: ParticleEffectTimelineDefinition,
): void {
  if (timeline.groups.length > 0 || emitters.length <= 3) return;
  if (isRecord(rawTimeline) && Array.isArray(rawTimeline.groups)) return;
  if (emitters.some((emitter) => emitter.timeline.groupId)) return;

  const groupId = "track-group";
  timeline.groups.push({
    id: groupId,
    name: "Track Group",
    collapsed: false,
    hidden: false,
    locked: false,
  });
  for (let index = 3; index < emitters.length; index++) {
    const emitter = emitters[index];
    if (!emitter) continue;
    emitter.timeline = {
      ...emitter.timeline,
      groupId,
    };
  }
}

function normalizeEffectTimeline(
  value: unknown,
  emitters: readonly ParticleEmitterDefinition[],
): ParticleEffectTimelineDefinition {
  const source = isRecord(value) ? value : {};
  const frameRate = clampNumber(
    numberOr(source.frameRate, DEFAULT_EFFECT_TIMELINE_FRAME_RATE),
    1,
    240,
  );
  const inferredDuration = inferEffectTimelineDuration(emitters);
  const duration = clampNumber(
    numberOr(source.duration, inferredDuration),
    0.05,
    EFFECT_TIMELINE_DURATION_MAX,
  );
  return {
    frameRate,
    duration,
    loop: normalizeTimelineLoop(source.loop, duration),
    groups: normalizeTimelineGroups(source.groups),
  };
}

function inferEffectTimelineDuration(
  emitters: readonly ParticleEmitterDefinition[],
): number {
  let longest = 0;
  for (const emitter of emitters) {
    longest = Math.max(
      longest,
      emitter.timeline.start + Math.max(0.05, emitter.duration),
    );
  }
  const seconds =
    Math.max(longest, DEFAULT_EFFECT_TIMELINE_DURATION) *
    EFFECT_TIMELINE_DURATION_HEADROOM;
  return clampNumber(seconds, 0.05, EFFECT_TIMELINE_DURATION_MAX);
}

function normalizeTimelineLoop(
  value: unknown,
  duration: number,
): ParticleTimelineLoopDefinition {
  const source = isRecord(value) ? value : {};
  const defaultStart = duration * 0.12;
  const defaultEnd = duration * 0.62;
  let start = clampNumber(numberOr(source.start, defaultStart), 0, duration);
  let end = clampNumber(numberOr(source.end, defaultEnd), 0, duration);
  if (end <= start) {
    end = Math.min(duration, start + 0.05);
    if (end <= start) start = Math.max(0, end - 0.05);
  }
  return {
    enabled: source.enabled === true,
    start,
    end,
  };
}

function normalizeTimelineGroups(
  value: unknown,
): ParticleTimelineGroupDefinition[] {
  if (!Array.isArray(value)) return [];
  const groups: ParticleTimelineGroupDefinition[] = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!isRecord(item)) continue;
    const fallbackId = `track-group-${index + 1}`;
    let id = safeId(item.id, fallbackId);
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${safeId(item.id, fallbackId)}-${suffix}`;
      suffix++;
    }
    usedIds.add(id);
    groups.push({
      id,
      name: safeString(item.name, `Track Group ${index + 1}`),
      collapsed: item.collapsed === true,
      hidden: item.hidden === true,
      locked: item.locked === true,
    });
  }
  return groups;
}

function normalizeEmitterTimeline(
  value: unknown,
): ParticleEmitterTimelineDefinition {
  const source = isRecord(value) ? value : {};
  const groupId =
    typeof source.groupId === "string" && source.groupId.trim()
      ? safeId(source.groupId, "track-group")
      : null;
  return {
    start: clampNumber(
      numberOr(source.start, 0),
      0,
      EFFECT_TIMELINE_DURATION_MAX,
    ),
    groupId,
    locked: source.locked === true,
  };
}

function normalizeEmitter(
  value: unknown,
  index: number,
): ParticleEmitterDefinition {
  const source = isRecord(value) ? value : {};
  const fallback = DEFAULT_EMITTER;
  const spawn = normalizeSpawn(source.spawn);
  return {
    id: safeId(source.id, `emitter-${index + 1}`),
    name: safeString(source.name, `Emitter ${index + 1}`),
    enabled: source.enabled !== false,
    mode: source.mode === "mesh" ? "mesh" : "billboard",
    maxParticles: Math.round(
      clampNumber(
        numberOr(source.maxParticles, fallback.maxParticles),
        1,
        4096,
      ),
    ),
    duration: clampNumber(
      numberOr(source.duration, fallback.duration),
      0.05,
      EFFECT_TIMELINE_DURATION_MAX,
    ),
    loop: source.loop !== false,
    timeline: normalizeEmitterTimeline(source.timeline),
    modules: normalizeEmitterModules(source.modules, FULL_EMITTER_MODULES),
    spawn,
    initializeParticle: normalizeParticleInitializeSettings(
      source.initializeParticle,
      fallback.initializeParticle,
    ),
    forces: normalizeForces(source.forces),
    render: normalizeRender(source.render, spawn.alignToDirection),
    billboard: normalizeBillboard(source.billboard),
    mesh: normalizeMesh(source.mesh),
    color: normalizeColor(source.color),
    advanced: normalizeParticleAdvancedModules(
      source.advanced,
      normalizeParticleScalarValue,
      normalizeParticleGradient,
    ),
  };
}

function normalizeSpawn(value: unknown): ParticleSpawnSettings {
  const source = isRecord(value) ? value : {};
  const rate = clampNumber(
    numberOr(source.rate, DEFAULT_EMITTER.spawn.rate),
    0,
    3000,
  );
  const rateOverDistance = clampNumber(
    numberOr(source.rateOverDistance, DEFAULT_EMITTER.spawn.rateOverDistance),
    0,
    1000,
  );
  const radius = clampNumber(
    numberOr(source.radius, DEFAULT_EMITTER.spawn.radius),
    0,
    24,
  );
  const shape =
    source.shape === "point" ||
    source.shape === "box" ||
    source.shape === "cone" ||
    source.shape === "sphere" ||
    source.shape === "hemisphere" ||
    source.shape === "mesh"
      ? source.shape
      : source.shape === "circle"
        ? "circle"
        : DEFAULT_EMITTER.spawn.shape;
  return {
    rate,
    rateValue: normalizeParticleScalarValue(source.rateValue, rate, 0, 3000),
    rateOverDistance,
    rateOverDistanceValue: normalizeParticleScalarValue(
      source.rateOverDistanceValue,
      rateOverDistance,
      0,
      1000,
    ),
    bursts: normalizeBurstSchedules(source, DEFAULT_EMITTER.spawn.bursts),
    shape,
    radius,
    radiusValue: normalizeParticleScalarValue(
      source.radiusValue,
      radius,
      0,
      24,
    ),
    box: normalizeVec3(source.box, DEFAULT_EMITTER.spawn.box, 0, 48),
    angle: clampNumber(
      numberOr(source.angle, DEFAULT_EMITTER.spawn.angle),
      0,
      90,
    ),
    radiusThickness: clampNumber(
      numberOr(source.radiusThickness, DEFAULT_EMITTER.spawn.radiusThickness),
      0,
      1,
    ),
    arc: clampNumber(numberOr(source.arc, DEFAULT_EMITTER.spawn.arc), 0, 360),
    arcMode: normalizeSpawnArcMode(source.arcMode),
    arcSpread: clampNumber(
      numberOr(source.arcSpread, DEFAULT_EMITTER.spawn.arcSpread),
      0,
      1,
    ),
    arcSpeedValue: normalizeParticleScalarValue(
      source.arcSpeedValue,
      0,
      -360,
      360,
    ),
    length: clampNumber(
      numberOr(source.length, DEFAULT_EMITTER.spawn.length),
      0,
      48,
    ),
    emitFrom: source.emitFrom === "volume" ? "volume" : "base",
    meshAsset: normalizeParticleMeshAssetRef(source.meshAsset),
    meshEmitFrom: source.meshEmitFrom === "vertices" ? "vertices" : "surface",
    position: normalizeVec3(
      source.position,
      DEFAULT_EMITTER.spawn.position,
      -100,
      100,
    ),
    rotation: normalizeVec3(
      source.rotation,
      DEFAULT_EMITTER.spawn.rotation,
      -360,
      360,
    ),
    scale: normalizeVec3(source.scale, DEFAULT_EMITTER.spawn.scale, 0, 100),
    simulationSpace: source.simulationSpace === "local" ? "local" : "world",
    alignToDirection: source.alignToDirection === true,
    randomDirectionAmount: clampNumber(
      numberOr(
        source.randomDirectionAmount,
        DEFAULT_EMITTER.spawn.randomDirectionAmount,
      ),
      0,
      1,
    ),
    sphericalDirectionAmount: clampNumber(
      numberOr(
        source.sphericalDirectionAmount,
        DEFAULT_EMITTER.spawn.sphericalDirectionAmount,
      ),
      0,
      1,
    ),
    randomPositionAmount: clampNumber(
      numberOr(
        source.randomPositionAmount,
        DEFAULT_EMITTER.spawn.randomPositionAmount,
      ),
      0,
      24,
    ),
  };
}

function normalizeBurstSchedules(
  source: Record<string, unknown>,
  fallback: readonly ParticleBurstSchedule[] = [],
): ParticleBurstSchedule[] {
  const raw = Array.isArray(source.bursts)
    ? source.bursts
    : Array.isArray(source.burstSchedules) && source.burstSchedules.length > 0
      ? source.burstSchedules
      : Array.isArray(source.burstSchedule)
        ? source.burstSchedule
        : fallback;
  return raw
    .map((item): ParticleBurstSchedule | undefined => {
      if (!isRecord(item)) return undefined;
      const count = Math.round(clampNumber(numberOr(item.count, 0), 0, 4096));
      const cycles = Math.round(
        clampNumber(
          numberOr(item.cycles, numberOr(item.cycleCount, 1)),
          1,
          256,
        ),
      );
      if (count <= 0 || cycles <= 0) return undefined;
      return {
        time: clampNumber(numberOr(item.time, 0), 0, 60),
        count,
        cycles,
        interval: clampNumber(
          numberOr(item.interval, numberOr(item.repeatInterval, 0)),
          0,
          60,
        ),
        probability: clampNumber(numberOr(item.probability, 1), 0, 1),
      };
    })
    .filter((item): item is ParticleBurstSchedule => Boolean(item))
    .slice(0, PARTICLE_BURST_SCHEDULE_LIMIT)
    .sort((a, b) => a.time - b.time || a.interval - b.interval);
}

function normalizeForces(value: unknown): ParticleForceSettings {
  const source = isRecord(value) ? value : {};
  const gravity = clampNumber(
    numberOr(source.gravity, DEFAULT_EMITTER.forces.gravity),
    -80,
    80,
  );
  const drag = clampNumber(
    numberOr(source.drag, DEFAULT_EMITTER.forces.drag),
    0,
    12,
  );
  return {
    gravity,
    gravityValue: normalizeParticleScalarValue(
      source.gravityValue,
      gravity,
      -80,
      80,
    ),
    drag,
    dragValue: normalizeParticleScalarValue(source.dragValue, drag, 0, 12),
  };
}

const PARTICLE_COLOR_VALUE_MODES: ReadonlySet<ParticleColorValueMode> = new Set(
  ["constant", "random", "gradient", "randomGradient"],
);

export function normalizeParticleColorValue(
  value: unknown,
  fallback: ParticleColorValue,
): ParticleColorValue {
  const source = isRecord(value) ? value : {};
  const mode: ParticleColorValueMode =
    typeof source.mode === "string" &&
    PARTICLE_COLOR_VALUE_MODES.has(source.mode as ParticleColorValueMode)
      ? (source.mode as ParticleColorValueMode)
      : fallback.mode;
  const color = normalizeVec4(source.color, fallback.color, 0, 16);
  const colorB = normalizeVec4(source.colorB, fallback.colorB, 0, 16);
  const fallbackAlpha =
    fallback.alpha ??
    createConstantParticleScalar(
      fallback.mode === "random" ? fallback.color[3] : fallback.color[3],
      0,
      1,
    );
  const legacyAlpha =
    mode === "random"
      ? {
          mode: "random",
          value: color[3],
          min: color[3],
          max: colorB[3],
          editorMin: 0,
          editorMax: 1,
          curve: [
            { x: 0, y: color[3] },
            { x: 1, y: color[3] },
          ],
          curveB: [
            { x: 0, y: colorB[3] },
            { x: 1, y: colorB[3] },
          ],
        }
      : {
          mode: "constant",
          value: mode === "constant" ? color[3] : 1,
          min: mode === "constant" ? color[3] : 1,
          max: mode === "constant" ? color[3] : 1,
          editorMin: 0,
          editorMax: 1,
          curve: [
            { x: 0, y: mode === "constant" ? color[3] : 1 },
            { x: 1, y: mode === "constant" ? color[3] : 1 },
          ],
          curveB: [
            { x: 0, y: mode === "constant" ? color[3] : 1 },
            { x: 1, y: mode === "constant" ? color[3] : 1 },
          ],
        };
  return {
    mode,
    color,
    colorB,
    gradient: normalizeParticleGradient(
      source.gradient,
      [color[0], color[1], color[2], color[3]],
      [colorB[0], colorB[1], colorB[2], colorB[3]],
    ),
    gradientB: normalizeParticleGradient(
      source.gradientB,
      [colorB[0], colorB[1], colorB[2], colorB[3]],
      [color[0], color[1], color[2], color[3]],
    ),
    alpha: normalizeParticleScalarValue(
      source.alpha ?? legacyAlpha,
      particleScalarRepresentative(fallbackAlpha),
      0,
      1,
    ),
    intensity: normalizeParticleScalarValue(
      source.intensity,
      particleScalarRepresentative(fallback.intensity),
      0,
      16,
      undefined,
      PARTICLE_HDR_COLOR_INTENSITY_VALUE_LIMIT,
    ),
  };
}

export function normalizeParticleInitializeSettings(
  value: unknown,
  fallback: ParticleInitializeSettings,
): ParticleInitializeSettings {
  const source = isRecord(value) ? value : {};
  const size = normalizeParticleScalarValue(
    source.size,
    particleScalarRepresentative(fallback.size),
    0,
    24,
  );
  const rotation = normalizeParticleScalarValue(
    source.rotation,
    particleScalarRepresentative(fallback.rotation),
    -PARTICLE_TAU,
    PARTICLE_TAU,
  );
  const angularVelocity = normalizeParticleScalarValue(
    source.angularVelocity,
    particleScalarRepresentative(fallback.angularVelocity),
    -24,
    24,
  );
  return {
    lifetime: normalizeParticleScalarValue(
      source.lifetime,
      particleScalarRepresentative(fallback.lifetime),
      0.02,
      30,
    ),
    color: normalizeParticleColorValue(source.color, fallback.color),
    size,
    size3D: normalizeParticleVec3ScalarSettings(
      source.size3D,
      scalarVec3Fallback(size, size, size),
      0,
      24,
    ),
    startSizeSeparateAxes:
      typeof source.startSizeSeparateAxes === "boolean"
        ? source.startSizeSeparateAxes
        : (fallback.startSizeSeparateAxes ?? false),
    rotation,
    rotation3D: normalizeParticleVec3ScalarSettings(
      source.rotation3D,
      scalarVec3Fallback(
        createConstantParticleScalar(0, -PARTICLE_TAU, PARTICLE_TAU),
        createConstantParticleScalar(0, -PARTICLE_TAU, PARTICLE_TAU),
        rotation,
      ),
      -PARTICLE_TAU,
      PARTICLE_TAU,
    ),
    startRotationSeparateAxes:
      typeof source.startRotationSeparateAxes === "boolean"
        ? source.startRotationSeparateAxes
        : (fallback.startRotationSeparateAxes ?? false),
    angularVelocitySeparateAxes:
      typeof source.angularVelocitySeparateAxes === "boolean"
        ? source.angularVelocitySeparateAxes
        : (fallback.angularVelocitySeparateAxes ?? false),
    angularVelocity,
    angularVelocity3D: normalizeParticleVec3ScalarSettings(
      source.angularVelocity3D,
      scalarVec3Fallback(
        createConstantParticleScalar(0, -24, 24),
        createConstantParticleScalar(0, -24, 24),
        angularVelocity,
      ),
      -24,
      24,
    ),
    velocity: normalizeParticleInitializeVelocity(
      source.velocity,
      fallback.velocity,
    ),
  };
}

function scalarVec3Fallback(
  x: ParticleScalarValue,
  y: ParticleScalarValue,
  z: ParticleScalarValue,
): ParticleVec3ScalarSettings {
  return { x, y, z };
}

function normalizeParticleVec3ScalarSettings(
  value: unknown,
  fallback: ParticleVec3ScalarSettings,
  editorMin: number,
  editorMax: number,
): ParticleVec3ScalarSettings {
  const source = isRecord(value) ? value : {};
  return {
    x: normalizeParticleScalarValueWithFallbackMode(
      source.x,
      fallback.x,
      editorMin,
      editorMax,
    ),
    y: normalizeParticleScalarValueWithFallbackMode(
      source.y,
      fallback.y,
      editorMin,
      editorMax,
    ),
    z: normalizeParticleScalarValueWithFallbackMode(
      source.z,
      fallback.z,
      editorMin,
      editorMax,
    ),
  };
}

function normalizeParticleScalarValueWithFallbackMode(
  value: unknown,
  fallback: ParticleScalarValue,
  editorMin: number,
  editorMax: number,
): ParticleScalarValue {
  const source = value === undefined ? fallback : value;
  return normalizeParticleScalarValue(
    source,
    particleScalarRepresentative(fallback),
    editorMin,
    editorMax,
    fallback.curve,
  );
}

function normalizeParticleInitializeVelocity(
  value: unknown,
  fallback: ParticleInitializeVelocity,
): ParticleInitializeVelocity {
  const source = isRecord(value) ? value : {};
  const mode: ParticleInitializeVelocityMode =
    source.mode === "vector" || source.mode === "shapeDirection"
      ? source.mode
      : fallback.mode;
  return {
    mode,
    // B2: velocity has no natural range — clamp only to the global safety guard
    // so large/negative initial velocities are honored (UI now allows them too).
    min: normalizeVec3(source.min, fallback.min, -100000, 100000),
    max: normalizeVec3(source.max, fallback.max, -100000, 100000),
    speed: normalizeParticleScalarValue(
      source.speed,
      particleScalarRepresentative(fallback.speed),
      0,
      80,
    ),
  };
}

function normalizeRender(
  value: unknown,
  legacyAlignToDirection = false,
): ParticleRenderSettings {
  const source = isRecord(value) ? value : {};
  const legacyAlignment = normalizeRenderAlignment(
    source.alignment,
    legacyAlignToDirection,
  );
  const hasExplicitAlignAxis =
    typeof source.alignAxis === "string" &&
    PARTICLE_RENDER_ALIGN_AXES.has(source.alignAxis as ParticleRenderAlignAxis);
  const alignAxis = normalizeRenderAlignAxis(source.alignAxis, legacyAlignment);
  const facing = normalizeRenderFacing(
    source.facing,
    legacyAlignment,
    hasExplicitAlignAxis,
  );
  return {
    blend:
      typeof source.blend === "string" &&
      PARTICLE_BLEND_MODES.has(source.blend as ParticleBlendMode)
        ? (source.blend as ParticleBlendMode)
        : "alpha",
    shading: source.shading === "lit" ? "lit" : "unlit",
    depthTest: source.depthTest !== false,
    depthWrite: source.depthWrite === true,
    depthInk: source.depthInk !== false,
    orderInLayer: Math.round(
      clampNumber(numberOr(source.orderInLayer, 0), -1024, 1024),
    ),
    sortMode: normalizeSortMode(source.sortMode),
    alignment: renderAlignmentFromAlignAxis(alignAxis),
    alignAxis,
    facing,
    alignmentVector: normalizeVec3(source.alignmentVector, [0, 1, 0], -1, 1),
    opacitySource: normalizeOpacitySource(source.opacitySource),
    opacityInvert: source.opacityInvert === true,
    texture:
      typeof source.texture === "string" && source.texture.trim()
        ? source.texture.trim()
        : null,
    material: normalizeOptionalMaterialInstance(source.material),
  };
}

export function resolveParticleDepthWrite(
  render: Pick<ParticleRenderSettings, "blend" | "depthWrite">,
  alpha = 1,
): boolean {
  return (
    render.depthWrite === true &&
    render.blend !== "additive" &&
    render.blend !== "premultiplied" &&
    alpha >= 0.999
  );
}

const PARTICLE_BLEND_MODES: ReadonlySet<ParticleBlendMode> = new Set([
  "alpha",
  "additive",
  "premultiplied",
]);

const PARTICLE_SORT_MODES: ReadonlySet<ParticleSortMode> = new Set([
  "none",
  "distanceFarFirst",
  "distanceNearFirst",
  "oldestFirst",
  "youngestFirst",
]);

function normalizeSortMode(value: unknown): ParticleSortMode {
  return typeof value === "string" &&
    PARTICLE_SORT_MODES.has(value as ParticleSortMode)
    ? (value as ParticleSortMode)
    : "distanceFarFirst";
}

function normalizeRenderAlignment(
  value: unknown,
  legacyAlignToDirection: boolean,
): ParticleRenderAlignment {
  if (
    value === "faceCamera" ||
    value === "spawnDirection" ||
    value === "velocity" ||
    value === "vector"
  ) {
    return value;
  }
  return legacyAlignToDirection ? "spawnDirection" : "faceCamera";
}

const PARTICLE_RENDER_ALIGN_AXES: ReadonlySet<ParticleRenderAlignAxis> =
  new Set(["screen", "spawnDirection", "velocity", "vector"]);

function normalizeRenderAlignAxis(
  value: unknown,
  legacyAlignment: ParticleRenderAlignment,
): ParticleRenderAlignAxis {
  if (
    typeof value === "string" &&
    PARTICLE_RENDER_ALIGN_AXES.has(value as ParticleRenderAlignAxis)
  ) {
    return value as ParticleRenderAlignAxis;
  }
  return legacyAlignment === "faceCamera" ? "screen" : legacyAlignment;
}

const PARTICLE_RENDER_FACINGS: ReadonlySet<ParticleRenderFacing> = new Set([
  "cameraPlane",
  "cameraPosition",
  "off",
]);

function normalizeRenderFacing(
  value: unknown,
  legacyAlignment: ParticleRenderAlignment,
  hasExplicitAlignAxis: boolean,
): ParticleRenderFacing {
  if (
    typeof value === "string" &&
    PARTICLE_RENDER_FACINGS.has(value as ParticleRenderFacing)
  ) {
    return value as ParticleRenderFacing;
  }
  if (hasExplicitAlignAxis) return "cameraPlane";
  return legacyAlignment === "faceCamera" ? "cameraPlane" : "off";
}

function renderAlignmentFromAlignAxis(
  alignAxis: ParticleRenderAlignAxis,
): ParticleRenderAlignment {
  return alignAxis === "screen" ? "faceCamera" : alignAxis;
}

const PARTICLE_OPACITY_SOURCES: ReadonlySet<ParticleOpacitySource> = new Set([
  "textureAlpha",
  "red",
  "green",
  "blue",
  "luminance",
  "inverseLuminance",
  "constant",
]);

function normalizeOpacitySource(value: unknown): ParticleOpacitySource {
  return typeof value === "string" &&
    PARTICLE_OPACITY_SOURCES.has(value as ParticleOpacitySource)
    ? (value as ParticleOpacitySource)
    : "textureAlpha";
}

function normalizeBillboard(value: unknown): ParticleBillboardSettings {
  const source = isRecord(value) ? value : {};
  const sizeStart = clampNumber(
    numberOr(source.sizeStart, DEFAULT_EMITTER.billboard.sizeStart),
    0.001,
    24,
  );
  const sizeEnd = clampNumber(
    numberOr(source.sizeEnd, DEFAULT_EMITTER.billboard.sizeEnd),
    0.001,
    24,
  );
  const sizeStartY = clampNumber(
    numberOr(source.sizeStartY, sizeStart),
    0.001,
    24,
  );
  const sizeEndY = clampNumber(numberOr(source.sizeEndY, sizeEnd), 0.001, 24);
  const sizeValue = normalizeParticleScalarValue(
    source.sizeValue,
    sizeStart,
    0.001,
    24,
    [
      { x: 0, y: sizeStart },
      { x: 1, y: sizeEnd },
    ],
  );
  return {
    shape: source.shape === "square" ? "square" : "circle",
    sizeStart,
    sizeEnd,
    sizeValue,
    separateAxes: source.separateAxes === true,
    sizeStartY,
    sizeEndY,
    sizeValueY: normalizeParticleScalarValue(
      source.sizeValueY === undefined ? sizeValue : source.sizeValueY,
      sizeStartY,
      0.001,
      24,
      [
        { x: 0, y: sizeStartY },
        { x: 1, y: sizeEndY },
      ],
    ),
    softness: clampNumber(
      numberOr(source.softness, DEFAULT_EMITTER.billboard.softness),
      0,
      1,
    ),
    pivot: normalizeVec2(
      source.pivot,
      DEFAULT_EMITTER.billboard.pivot,
      -10,
      10,
    ),
  };
}

function normalizeMesh(value: unknown): ParticleMeshSettings {
  const source = isRecord(value) ? value : {};
  const asset = normalizeParticleMeshAssetRef(source.asset);
  const renderMode =
    source.renderMode === "meshAsset" ? "meshAsset" : "pixiShard";
  const template =
    source.template === "grassShard" ||
    source.template === "quadShard" ||
    source.template === "triangleShard"
      ? source.template
      : DEFAULT_EMITTER.mesh.template;
  const sizeStart = clampNumber(
    numberOr(source.sizeStart, DEFAULT_EMITTER.mesh.sizeStart),
    0.001,
    24,
  );
  const sizeEnd = clampNumber(
    numberOr(source.sizeEnd, DEFAULT_EMITTER.mesh.sizeEnd),
    0.001,
    24,
  );
  const sizeValue = normalizeMeshSizeValue(source, sizeStart, sizeEnd);
  return {
    renderMode,
    template,
    asset,
    sizeStart,
    sizeEnd,
    sizeValue,
    separateAxes: source.separateAxes === true,
    sizeValueY: normalizeParticleScalarValue(
      source.sizeValueY === undefined ? sizeValue : source.sizeValueY,
      sizeStart,
      0.001,
      24,
      [
        { x: 0, y: sizeStart },
        { x: 1, y: sizeEnd },
      ],
    ),
    sizeValueZ: normalizeParticleScalarValue(
      source.sizeValueZ === undefined ? sizeValue : source.sizeValueZ,
      sizeStart,
      0.001,
      24,
      [
        { x: 0, y: sizeStart },
        { x: 1, y: sizeEnd },
      ],
    ),
    thickness: clampNumber(
      numberOr(source.thickness, DEFAULT_EMITTER.mesh.thickness),
      0.02,
      4,
    ),
    pivot: normalizeVec3(source.pivot, DEFAULT_EMITTER.mesh.pivot, -10, 10),
    flipWinding: source.flipWinding === true,
    recomputeNormals: source.recomputeNormals === true,
  };
}

function normalizeMeshSizeValue(
  source: Record<string, unknown>,
  sizeStart: number,
  sizeEnd: number,
): ParticleScalarValue {
  return normalizeParticleScalarValue(source.sizeValue, sizeStart, 0.001, 24, [
    { x: 0, y: sizeStart },
    { x: 1, y: sizeEnd },
  ]);
}

function normalizeParticleMeshAssetRef(
  value: unknown,
): ParticleMeshAssetRef | null {
  if (!isRecord(value)) return null;
  const path = safeString(value.path, "");
  if (!path) return null;
  const bounds = normalizeParticleMeshBounds(value.bounds);
  return {
    type: "mesh",
    id: safeString(value.id, path),
    path,
    ...(typeof value.name === "string" && value.name.trim()
      ? { name: value.name.trim() }
      : {}),
    ...(bounds ? { bounds } : {}),
  };
}

function normalizeParticleMeshBounds(
  value: unknown,
): ParticleMeshAssetRef["bounds"] | null {
  if (!isRecord(value)) return null;
  return {
    min: normalizeVec3(value.min, [0, 0, 0], -100000, 100000),
    max: normalizeVec3(value.max, [0, 0, 0], -100000, 100000),
  };
}

function normalizeColor(value: unknown): ParticleColorSettings {
  const source = isRecord(value) ? value : {};
  const start = normalizeVec4(source.start, DEFAULT_EMITTER.color.start, 0, 1);
  const end = normalizeVec4(source.end, DEFAULT_EMITTER.color.end, 0, 1);
  const gradient = normalizeParticleGradient(source.gradient, start, end);
  const endpoints = particleGradientEndpoints(gradient);
  return {
    start: endpoints.start,
    end: endpoints.end,
    gradient,
  };
}

export function normalizeParticleScalarValue(
  value: unknown,
  fallback: number,
  editorMin: number,
  editorMax: number,
  fallbackCurve?: ParticleCurvePoint[],
  valueLimit = PARTICLE_SCALAR_VALUE_LIMIT,
): ParticleScalarValue {
  const source = isRecord(value) ? value : {};
  const fallbackMin = Math.min(editorMin, editorMax);
  const fallbackMax = Math.max(editorMin, editorMax);
  const fallbackEditorMin = fallbackMin < 0 ? 0 : fallbackMin;
  const resolvedValueLimit =
    Number.isFinite(valueLimit) && valueLimit > 0
      ? valueLimit
      : PARTICLE_SCALAR_VALUE_LIMIT;
  const resolvedEditorMin = clampFiniteNumber(
    numberOr(source.editorMin, fallbackEditorMin),
    -resolvedValueLimit,
    resolvedValueLimit,
  );
  const resolvedEditorMaxRaw = clampFiniteNumber(
    numberOr(source.editorMax, fallbackMax),
    -resolvedValueLimit,
    resolvedValueLimit,
  );
  const resolvedEditorMax = Math.max(
    resolvedEditorMin + 0.000001,
    resolvedEditorMaxRaw,
  );
  const mode = normalizeScalarMode(source.mode);
  const normalizedFallback = clampFiniteNumber(
    numberOr(value, numberOr(source.value, fallback)),
    -resolvedValueLimit,
    resolvedValueLimit,
  );
  const minValue = clampFiniteNumber(
    numberOr(source.min, normalizedFallback),
    -resolvedValueLimit,
    resolvedValueLimit,
  );
  const maxValue = clampFiniteNumber(
    numberOr(source.max, normalizedFallback),
    -resolvedValueLimit,
    resolvedValueLimit,
  );
  const curve = normalizeCurvePoints(
    source.curve,
    fallbackCurve ?? [
      { x: 0, y: normalizedFallback },
      { x: 1, y: normalizedFallback },
    ],
    resolvedValueLimit,
  );
  const curveB = normalizeCurvePoints(
    source.curveB,
    fallbackCurve ?? [
      { x: 0, y: minValue },
      { x: 1, y: maxValue },
    ],
    resolvedValueLimit,
  );
  const multiplier = clampFiniteNumber(
    numberOr(source.multiplier, 1),
    -resolvedValueLimit,
    resolvedValueLimit,
  );
  const hasExplicitUnitMultiplier = source.multiplier === 1;
  // I13-E: the magnitude auto-fold canonicalises un-folded/legacy curves into
  // `editorMax = 1` + a magnitude `multiplier` (see normalizeScalarCurveMagnitude).
  // Re-running that fold during interactive point editing is where the
  // negative-value breakage lives: it re-derives the range/divisor from the
  // transient dragged point positions and, for all-non-positive points, flips
  // the multiplier sign on every commit. A curve already in the canonical folded
  // form keeps `editorMax === 1` through every point drag (clampY bounds points
  // to [editorMin, editorMax], and no drag/label edit moves editorMax off 1), so
  // gating on `editorMax !== 1` runs the fold on exactly the load/import/creation
  // shapes and never during editing. Byte-identical to the old fold for every
  // already-folded curve except the never-occurring all-negative+editorMax===1
  // case (which the fold would only invert); verified across all Pork6-4 fixtures.
  const isCanonicalFoldedRange = resolvedEditorMaxRaw === 1;
  const shouldFoldCurveMagnitude =
    (mode === "curve" || mode === "randomCurve") &&
    !hasExplicitUnitMultiplier &&
    !isCanonicalFoldedRange;
  const normalizedCurveData = shouldFoldCurveMagnitude
    ? normalizeScalarCurveMagnitude(
        curve,
        curveB,
        mode,
        multiplier,
        resolvedEditorMin,
        resolvedValueLimit,
      )
    : {
        curve,
        curveB,
        multiplier,
        editorMin: resolvedEditorMin,
        editorMax: resolvedEditorMax,
      };
  const xAxis = normalizeScalarXAxis(source.xAxis);
  return {
    mode,
    value: normalizedFallback,
    min: Math.min(minValue, maxValue),
    max: Math.max(minValue, maxValue),
    curve: normalizedCurveData.curve,
    curveB: normalizedCurveData.curveB,
    editorMin: normalizedCurveData.editorMin,
    editorMax: normalizedCurveData.editorMax,
    // Only persist when non-default so existing data and export hashes are
    // untouched until the feature is actually used (mirrors `slope`).
    ...(normalizedCurveData.multiplier !== 1
      ? { multiplier: normalizedCurveData.multiplier }
      : {}),
    ...(xAxis !== "lifetime" ? { xAxis } : {}),
  };
}

export function cloneParticleScalarValue(
  value: ParticleScalarValue,
): ParticleScalarValue {
  return normalizeParticleScalarValue(
    value,
    value.value,
    value.editorMin,
    value.editorMax,
  );
}

export function copyParticleScalarValue(
  value: ParticleScalarValue,
): ParticleScalarValue {
  return {
    ...value,
    curve: value.curve.map((point) => ({ ...point })),
    curveB: value.curveB.map((point) => ({ ...point })),
  };
}

function sampleParticleScalarValueAtTime(
  value: ParticleScalarValue,
  time: number,
  mix: number,
): number {
  if (value.mode === "random") {
    return value.min + (value.max - value.min) * mix;
  }
  const multiplier = value.multiplier ?? 1;
  if (value.mode === "curve") {
    return sampleParticleCurve(value.curve, time) * multiplier;
  }
  if (value.mode === "randomCurve") {
    const a = sampleParticleCurve(value.curve, time);
    const b = sampleParticleCurve(value.curveB, time);
    return (a + (b - a) * mix) * multiplier;
  }
  return value.value;
}

export function sampleParticleScalarValue(
  value: ParticleScalarValue,
  t: number,
  random: number,
  loopAgeT?: number,
): number {
  // `t` is the default (normalized lifetime) axis. When the curve opts into the
  // loop-age axis and the caller supplied it, sample against that instead.
  const axisT =
    value.xAxis === "loopAge" && loopAgeT !== undefined ? loopAgeT : t;
  const time = clampNumber(axisT, 0, 1);
  const mix = clampNumber(random, 0, 1);
  return sampleParticleScalarValueAtTime(value, time, mix);
}

export function integrateParticleScalarValue(
  value: ParticleScalarValue,
  t: number,
  random: number,
  loopAgeT?: number,
): number {
  const axisT =
    value.xAxis === "loopAge" && loopAgeT !== undefined ? loopAgeT : t;
  const end = clampNumber(axisT, 0, 1);
  const mix = clampNumber(random, 0, 1);
  if (end <= 0) return 0;
  if (value.mode === "random") {
    return (value.min + (value.max - value.min) * mix) * end;
  }
  if (value.mode === "constant") {
    return value.value * end;
  }
  const steps = Math.max(1, Math.ceil(end * PARTICLE_SCALAR_INTEGRAL_STEPS));
  let previous = sampleParticleScalarValueAtTime(value, 0, mix);
  let area = 0;
  for (let i = 1; i <= steps; i++) {
    const time = (end * i) / steps;
    const next = sampleParticleScalarValueAtTime(value, time, mix);
    area += (previous + next) * 0.5 * (end / steps);
    previous = next;
  }
  return area;
}

function sampleParticleScalarValueIntegralAverage(
  value: ParticleScalarValue,
  t: number,
  random: number,
  loopAgeT?: number,
): number {
  const axisT =
    value.xAxis === "loopAge" && loopAgeT !== undefined ? loopAgeT : t;
  const end = clampNumber(axisT, 0, 1);
  if (end <= 0) return sampleParticleScalarValue(value, t, random, loopAgeT);
  return integrateParticleScalarValue(value, t, random, loopAgeT) / end;
}

export function compileParticleScalarValue(
  value: ParticleScalarValue,
  samples = 64,
): CompiledParticleScalarValue {
  const sampleCount = normalizeSampleCount(samples);
  const curve = new Float32Array(sampleCount);
  const curveB = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const t = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
    curve[i] = sampleParticleCurve(value.curve, t);
    curveB[i] = sampleParticleCurve(value.curveB, t);
  }
  return {
    mode: value.mode,
    value: value.value,
    min: value.min,
    max: value.max,
    multiplier: value.multiplier ?? 1,
    samples: sampleCount,
    curve,
    curveB,
  };
}

export function sampleCompiledParticleScalar(
  value: CompiledParticleScalarValue,
  t: number,
  random: number,
): number {
  const mix = clampNumber(random, 0, 1);
  if (value.mode === "random") {
    return value.min + (value.max - value.min) * mix;
  }
  if (value.mode === "curve") {
    return sampleFloatLut(value.curve, t) * value.multiplier;
  }
  if (value.mode === "randomCurve") {
    const a = sampleFloatLut(value.curve, t);
    const b = sampleFloatLut(value.curveB, t);
    return (a + (b - a) * mix) * value.multiplier;
  }
  return value.value;
}

export function particleScalarRepresentative(
  value: ParticleScalarValue,
): number {
  if (value.mode === "random") return (value.min + value.max) * 0.5;
  // Curve summaries fold in the multiplier so derived numbers (badges, range
  // validation) match what the runtime actually samples.
  const multiplier = value.multiplier ?? 1;
  if (value.mode === "curve") {
    return sampleParticleCurve(value.curve, 0) * multiplier;
  }
  if (value.mode === "randomCurve") {
    return (
      (sampleParticleCurve(value.curve, 0) * 0.5 +
        sampleParticleCurve(value.curveB, 0) * 0.5) *
      multiplier
    );
  }
  return value.value;
}

export function particleScalarEndpoints(value: ParticleScalarValue): {
  start: number;
  end: number;
} {
  if (value.mode === "curve" || value.mode === "randomCurve") {
    return {
      start: sampleParticleScalarValue(value, 0, 0.5),
      end: sampleParticleScalarValue(value, 1, 0.5),
    };
  }
  const representative = particleScalarRepresentative(value);
  return { start: representative, end: representative };
}

export function particleScalarMinMax(
  value: ParticleScalarValue,
): ParticleNumberRange {
  if (value.mode === "random") return { min: value.min, max: value.max };
  const isCurve = value.mode === "curve" || value.mode === "randomCurve";
  const samples =
    value.mode === "randomCurve"
      ? [...value.curve, ...value.curveB]
      : value.mode === "curve"
        ? value.curve
        : [{ x: 0, y: particleScalarRepresentative(value) }];
  // Fold the curve multiplier into each value (it may be negative, so apply it
  // per-sample rather than to the resulting min/max).
  const multiplier = isCurve ? (value.multiplier ?? 1) : 1;
  const values = samples.map((point) => point.y * multiplier);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function sampleParticleCurve(
  points: readonly ParticleCurvePoint[],
  t: number,
): number {
  const sorted = isSampleReadyParticleCurve(points)
    ? points
    : normalizeCurvePoints(points, [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]);
  const x = clampNumber(t, 0, 1);
  if (x <= sorted[0]!.x) return sorted[0]!.y;
  const last = sorted[sorted.length - 1]!;
  if (x >= last.x) return last.y;
  const tangents = curveTangents(sorted);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (x > b.x) continue;
    return sampleParticleCurveSegment(a, b, tangents[i]!, tangents[i + 1]!, x);
  }
  return last.y;
}

function sampleParticleCurveSegment(
  a: ParticleCurvePoint,
  b: ParticleCurvePoint,
  autoSlopeOut: number,
  autoSlopeIn: number,
  x: number,
): number {
  const dx = Math.max(0.000001, b.x - a.x);
  const slopeOut = curvePointSlopeOut(a, autoSlopeOut);
  const slopeIn = curvePointSlopeIn(b, autoSlopeIn);
  const weightOut = curvePointWeightOut(a);
  const weightIn = curvePointWeightIn(b);
  const x1 = a.x + dx * weightOut;
  const y1 = a.y + slopeOut * dx * weightOut;
  const x2 = b.x - dx * weightIn;
  const y2 = b.y - slopeIn * dx * weightIn;
  const linearU = clampNumber((x - a.x) / dx, 0, 1);
  const u =
    weightOut === PARTICLE_CURVE_DEFAULT_WEIGHT &&
    weightIn === PARTICLE_CURVE_DEFAULT_WEIGHT
      ? linearU
      : solveBezierParameterForX(a.x, x1, x2, b.x, x, linearU);
  return cubicBezier(a.y, y1, y2, b.y, u);
}

function curvePointSlopeIn(
  point: ParticleCurvePoint,
  autoSlope: number,
): number {
  return point.slopeIn ?? point.slope ?? autoSlope;
}

function curvePointSlopeOut(
  point: ParticleCurvePoint,
  autoSlope: number,
): number {
  return point.slopeOut ?? point.slope ?? autoSlope;
}

function curvePointWeightIn(point: ParticleCurvePoint): number {
  return point.weightIn ?? PARTICLE_CURVE_DEFAULT_WEIGHT;
}

function curvePointWeightOut(point: ParticleCurvePoint): number {
  return point.weightOut ?? PARTICLE_CURVE_DEFAULT_WEIGHT;
}

function solveBezierParameterForX(
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  targetX: number,
  initial: number,
): number {
  let u = clampNumber(initial, 0, 1);
  for (let i = 0; i < 6; i++) {
    const x = cubicBezier(x0, x1, x2, x3, u) - targetX;
    const dx = cubicBezierDerivative(x0, x1, x2, x3, u);
    if (Math.abs(x) < 0.000001) return u;
    if (Math.abs(dx) < 0.000001) break;
    const next = u - x / dx;
    if (next < 0 || next > 1) break;
    u = next;
  }

  let bestStart = 0;
  let bestEnd = 1;
  let bestDistance = Infinity;
  let previousU = 0;
  let previousX = cubicBezier(x0, x1, x2, x3, previousU) - targetX;
  for (let i = 1; i <= 24; i++) {
    const nextU = i / 24;
    const nextX = cubicBezier(x0, x1, x2, x3, nextU) - targetX;
    const nextDistance = Math.abs(nextX);
    if (nextDistance < bestDistance) {
      bestDistance = nextDistance;
      bestStart = previousU;
      bestEnd = nextU;
    }
    if (
      previousX === 0 ||
      nextX === 0 ||
      (previousX < 0 && nextX > 0) ||
      (previousX > 0 && nextX < 0)
    ) {
      bestStart = previousU;
      bestEnd = nextU;
      break;
    }
    previousU = nextU;
    previousX = nextX;
  }

  let low = bestStart;
  let high = bestEnd;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) * 0.5;
    const midX = cubicBezier(x0, x1, x2, x3, mid) - targetX;
    const lowX = cubicBezier(x0, x1, x2, x3, low) - targetX;
    if (Math.abs(midX) < 0.000001) return mid;
    if ((lowX <= 0 && midX >= 0) || (lowX >= 0 && midX <= 0)) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return (low + high) * 0.5;
}

function cubicBezier(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  u: number,
): number {
  const v = 1 - u;
  return (
    v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3
  );
}

function cubicBezierDerivative(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  u: number,
): number {
  const v = 1 - u;
  return 3 * v * v * (p1 - p0) + 6 * v * u * (p2 - p1) + 3 * u * u * (p3 - p2);
}

export function normalizeParticleGradient(
  value: unknown,
  start: Vec4,
  end: Vec4,
): ParticleColorGradientSettings {
  const source = isRecord(value) ? value : {};
  const mode: ParticleGradientMode =
    source.mode === "fixed" ? "fixed" : "blend";
  const colorStops = normalizeGradientColorStops(source.colorStops, start, end);
  const alphaStops = normalizeGradientAlphaStops(source.alphaStops, start, end);
  return {
    mode,
    colorStops,
    alphaStops,
  };
}

export function particleGradientEndpoints(
  gradient: ParticleColorGradientSettings,
): { start: Vec4; end: Vec4 } {
  return {
    start: [
      ...sampleParticleGradientColor(gradient, 0),
      sampleParticleGradientAlpha(gradient, 0),
    ],
    end: [
      ...sampleParticleGradientColor(gradient, 1),
      sampleParticleGradientAlpha(gradient, 1),
    ],
  };
}

export function sampleParticleGradientColor(
  gradient: ParticleColorGradientSettings,
  t: number,
  out: Vec4,
): Vec4;
export function sampleParticleGradientColor(
  gradient: ParticleColorGradientSettings,
  t: number,
  out?: Vec3,
): Vec3;
export function sampleParticleGradientColor(
  gradient: ParticleColorGradientSettings,
  t: number,
  out: Vec3 | Vec4 = [1, 1, 1],
): Vec3 | Vec4 {
  const stops = gradient.colorStops;
  if (stops.length === 0) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    return out;
  }
  const x = clampNumber(t, 0, 1);
  let first = stops[0]!;
  let last = stops[0]!;
  for (let i = 1; i < stops.length; i++) {
    const stop = stops[i]!;
    if (stop.position < first.position) first = stop;
    if (stop.position > last.position) last = stop;
  }
  let lower = first;
  let upper = last;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]!;
    if (stop.position <= x && stop.position >= lower.position) lower = stop;
    if (stop.position >= x && stop.position <= upper.position) upper = stop;
  }
  let r: number;
  let g: number;
  let b: number;
  if (gradient.mode === "fixed" || x <= first.position) {
    const selected = gradient.mode === "fixed" ? lower : first;
    r = selected.color[0];
    g = selected.color[1];
    b = selected.color[2];
  } else if (x >= last.position) {
    r = last.color[0];
    g = last.color[1];
    b = last.color[2];
  } else {
    const u =
      (x - lower.position) /
      Math.max(0.000001, upper.position - lower.position);
    r = lerpSrgbInLinear(lower.color[0], upper.color[0], u);
    g = lerpSrgbInLinear(lower.color[1], upper.color[1], u);
    b = lerpSrgbInLinear(lower.color[2], upper.color[2], u);
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
  return out;
}

export function srgbToLinear(value: number): number {
  const c = clampNumber(value, 0, 1);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  const c = clampNumber(value, 0, 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function lerpSrgbInLinear(a: number, b: number, t: number): number {
  const u = clampNumber(t, 0, 1);
  return linearToSrgb(
    srgbToLinear(a) + (srgbToLinear(b) - srgbToLinear(a)) * u,
  );
}

export function lerpColorSrgbInLinear(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    lerpSrgbInLinear(a[0], b[0], t),
    lerpSrgbInLinear(a[1], b[1], t),
    lerpSrgbInLinear(a[2], b[2], t),
  ];
}

export function lerpVec4SrgbRgbInLinear(a: Vec4, b: Vec4, t: number): Vec4 {
  const u = clampNumber(t, 0, 1);
  return [
    lerpSrgbInLinear(a[0], b[0], u),
    lerpSrgbInLinear(a[1], b[1], u),
    lerpSrgbInLinear(a[2], b[2], u),
    a[3] + (b[3] - a[3]) * u,
  ];
}

export function sampleParticleGradientAlpha(
  gradient: ParticleColorGradientSettings,
  t: number,
): number {
  const stops = gradient.alphaStops;
  if (stops.length === 0) return 1;
  const x = clampNumber(t, 0, 1);
  let first = stops[0]!;
  let last = stops[0]!;
  for (let i = 1; i < stops.length; i++) {
    const stop = stops[i]!;
    if (stop.position < first.position) first = stop;
    if (stop.position > last.position) last = stop;
  }
  let lower = first;
  let upper = last;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]!;
    if (stop.position <= x && stop.position >= lower.position) lower = stop;
    if (stop.position >= x && stop.position <= upper.position) upper = stop;
  }
  if (gradient.mode === "fixed" || x <= first.position) {
    return gradient.mode === "fixed" ? lower.alpha : first.alpha;
  }
  if (x >= last.position) return last.alpha;
  const u =
    (x - lower.position) / Math.max(0.000001, upper.position - lower.position);
  return lower.alpha + (upper.alpha - lower.alpha) * u;
}

export function compileParticleGradient(
  gradient: ParticleColorGradientSettings,
  samples = 64,
): CompiledParticleGradient {
  const sampleCount = normalizeSampleCount(samples);
  const rgba = new Float32Array(sampleCount * 4);
  for (let i = 0; i < sampleCount; i++) {
    const t = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
    const color = sampleParticleGradientColor(gradient, t);
    const alpha = sampleParticleGradientAlpha(gradient, t);
    const offset = i * 4;
    rgba[offset + 0] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = alpha;
  }
  return {
    mode: gradient.mode,
    samples: sampleCount,
    rgba,
  };
}

export function sampleCompiledParticleGradient(
  gradient: CompiledParticleGradient,
  t: number,
  out: Vec4 = [1, 1, 1, 1],
): Vec4 {
  const position = clampNumber(t, 0, 1) * (gradient.samples - 1);
  const left =
    gradient.mode === "fixed"
      ? Math.floor(position)
      : Math.min(gradient.samples - 1, Math.floor(position));
  const right =
    gradient.mode === "fixed" ? left : Math.min(gradient.samples - 1, left + 1);
  const mix = gradient.mode === "fixed" ? 0 : position - left;
  const leftOffset = left * 4;
  const rightOffset = right * 4;
  out[0] =
    (gradient.rgba[leftOffset + 0] ?? 1) +
    ((gradient.rgba[rightOffset + 0] ?? 1) -
      (gradient.rgba[leftOffset + 0] ?? 1)) *
      mix;
  out[1] =
    (gradient.rgba[leftOffset + 1] ?? 1) +
    ((gradient.rgba[rightOffset + 1] ?? 1) -
      (gradient.rgba[leftOffset + 1] ?? 1)) *
      mix;
  out[2] =
    (gradient.rgba[leftOffset + 2] ?? 1) +
    ((gradient.rgba[rightOffset + 2] ?? 1) -
      (gradient.rgba[leftOffset + 2] ?? 1)) *
      mix;
  out[3] =
    (gradient.rgba[leftOffset + 3] ?? 1) +
    ((gradient.rgba[rightOffset + 3] ?? 1) -
      (gradient.rgba[leftOffset + 3] ?? 1)) *
      mix;
  return out;
}

function normalizeScalarMode(value: unknown): ParticleScalarValueMode {
  return value === "random" || value === "curve" || value === "randomCurve"
    ? value
    : "constant";
}

function normalizeScalarXAxis(value: unknown): ParticleScalarXAxis {
  return value === "loopAge" ? "loopAge" : "lifetime";
}

function normalizeSpawnArcMode(value: unknown): ParticleSpawnArcMode {
  return value === "loop" || value === "pingPong" || value === "burstSpread"
    ? value
    : "random";
}

function normalizeScalarCurveMagnitude(
  curve: ParticleCurvePoint[],
  curveB: ParticleCurvePoint[],
  mode: ParticleScalarValueMode,
  multiplier: number,
  requestedEditorMin: number,
  valueLimit = PARTICLE_SCALAR_VALUE_LIMIT,
): {
  curve: ParticleCurvePoint[];
  curveB: ParticleCurvePoint[];
  multiplier: number;
  editorMin: number;
  editorMax: number;
} {
  const points = mode === "randomCurve" ? [...curve, ...curveB] : curve;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return { curve, curveB, multiplier, editorMin: 0, editorMax: 1 };
  }

  let divisor = 1;
  let editorMin = 0;
  const editorMax = 1;
  if (minY >= 0) {
    divisor = Math.max(1, maxY);
  } else if (maxY <= 0) {
    divisor = -Math.max(1, Math.abs(minY));
  } else {
    divisor = Math.max(1, Math.abs(minY), Math.abs(maxY));
    editorMin = -1;
  }
  editorMin = Math.min(editorMin, requestedEditorMin / Math.abs(divisor || 1));

  const nextMultiplier = clampFiniteNumber(
    multiplier * divisor,
    -valueLimit,
    valueLimit,
  );
  const shouldScale = Math.abs(divisor) > 0.000001 && divisor !== 1;
  return {
    curve: shouldScale
      ? curve.map((point) => scaleCurvePointY(point, 1 / divisor, valueLimit))
      : curve,
    curveB:
      shouldScale && mode === "randomCurve"
        ? curveB.map((point) =>
            scaleCurvePointY(point, 1 / divisor, valueLimit),
          )
        : curveB,
    multiplier: nextMultiplier,
    editorMin,
    editorMax,
  };
}

function scaleCurvePointY(
  point: ParticleCurvePoint,
  scale: number,
  valueLimit = PARTICLE_SCALAR_VALUE_LIMIT,
): ParticleCurvePoint {
  return {
    ...point,
    y: clampFiniteNumber(point.y * scale, -valueLimit, valueLimit),
    ...(typeof point.slope === "number"
      ? {
          slope: clampFiniteNumber(
            point.slope * scale,
            -PARTICLE_CURVE_SLOPE_LIMIT,
            PARTICLE_CURVE_SLOPE_LIMIT,
          ),
        }
      : {}),
    ...(typeof point.slopeIn === "number"
      ? {
          slopeIn: clampFiniteNumber(
            point.slopeIn * scale,
            -PARTICLE_CURVE_SLOPE_LIMIT,
            PARTICLE_CURVE_SLOPE_LIMIT,
          ),
        }
      : {}),
    ...(typeof point.slopeOut === "number"
      ? {
          slopeOut: clampFiniteNumber(
            point.slopeOut * scale,
            -PARTICLE_CURVE_SLOPE_LIMIT,
            PARTICLE_CURVE_SLOPE_LIMIT,
          ),
        }
      : {}),
  };
}

function normalizeCurvePoint(
  value: unknown,
  valueLimit = PARTICLE_SCALAR_VALUE_LIMIT,
): ParticleCurvePoint | undefined {
  if (!isRecord(value)) return undefined;
  const point: ParticleCurvePoint = {
    x: clampNumber(numberOr(value.x, 0), 0, 1),
    y: clampFiniteNumber(numberOr(value.y, 0), -valueLimit, valueLimit),
  };
  const slope = normalizeCurveSlope(value.slope);
  const slopeIn = normalizeCurveSlope(value.slopeIn);
  const slopeOut = normalizeCurveSlope(value.slopeOut);
  const weightIn = normalizeCurveWeight(value.weightIn);
  const weightOut = normalizeCurveWeight(value.weightOut);
  if (slope !== undefined) point.slope = slope;
  if (slopeIn !== undefined) point.slopeIn = slopeIn;
  if (slopeOut !== undefined) point.slopeOut = slopeOut;
  if (weightIn !== undefined) point.weightIn = weightIn;
  if (weightOut !== undefined) point.weightOut = weightOut;
  return point;
}

function normalizeCurveSlope(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? clampFiniteNumber(
        value,
        -PARTICLE_CURVE_SLOPE_LIMIT,
        PARTICLE_CURVE_SLOPE_LIMIT,
      )
    : undefined;
}

function normalizeCurveWeight(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? clampFiniteNumber(value, 0, PARTICLE_CURVE_WEIGHT_LIMIT)
    : undefined;
}

function normalizeCurvePoints(
  value: unknown,
  fallback: readonly ParticleCurvePoint[],
  valueLimit = PARTICLE_SCALAR_VALUE_LIMIT,
): ParticleCurvePoint[] {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const points = source
    .map((point) => normalizeCurvePoint(point, valueLimit))
    .filter((point): point is ParticleCurvePoint => Boolean(point))
    .sort((a, b) => a.x - b.x)
    .slice(0, PARTICLE_SCALAR_CURVE_POINT_LIMIT);
  if (points.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
  }
  if (points.length === 1) {
    const only = points[0]!;
    return [
      { ...only, x: 0 },
      { ...only, x: 1 },
    ];
  }
  points[0]!.x = 0;
  points[points.length - 1]!.x = 1;
  return points;
}

function isSampleReadyParticleCurve(
  points: readonly ParticleCurvePoint[],
): boolean {
  if (points.length < 2) return false;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first.x !== 0 || last.x !== 1) return false;
  let previousX = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (!isFiniteOptionalCurveSlope(point.slope)) return false;
    if (!isFiniteOptionalCurveSlope(point.slopeIn)) return false;
    if (!isFiniteOptionalCurveSlope(point.slopeOut)) return false;
    if (!isFiniteOptionalCurveWeight(point.weightIn)) return false;
    if (!isFiniteOptionalCurveWeight(point.weightOut)) return false;
    if (point.x < previousX || point.x < 0 || point.x > 1) return false;
    previousX = point.x;
  }
  return true;
}

function isFiniteOptionalCurveSlope(value: number | undefined): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function isFiniteOptionalCurveWeight(value: number | undefined): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= PARTICLE_CURVE_WEIGHT_LIMIT)
  );
}

const curveTangentCache = new WeakMap<
  readonly ParticleCurvePoint[],
  readonly number[]
>();

/**
 * Memoized monotone tangents for a curve. Keyed on the points array identity;
 * the runtime normalizes curves once so the array reference is stable and this
 * hits the cache, while the editor recreates arrays on edit so it recomputes.
 */
function curveTangents(
  points: readonly ParticleCurvePoint[],
): readonly number[] {
  let cached = curveTangentCache.get(points);
  if (!cached) {
    cached = curveAutoTangents(points);
    curveTangentCache.set(points, cached);
  }
  return cached;
}

/**
 * Shape-preserving (monotone) cubic Hermite tangents using the Fritsch-Carlson
 * method. This is what keeps the drawn graph 1:1 with the sampled runtime curve
 * (B6): a "rise to a value and hold" curve no longer overshoots past the
 * endpoint and dips back down. Tangents flatten to zero at local extrema and are
 * limited so a monotone segment never overshoots its endpoints — matching
 * common auto/clamped-auto tangent behavior. Explicit
 * per-point `slope` values (authored tangent handles, F9) are honored as-is.
 */
export function curveAutoTangents(
  points: readonly ParticleCurvePoint[],
): number[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) {
    const only = points[0]!;
    return [
      typeof only.slope === "number" && Number.isFinite(only.slope)
        ? only.slope
        : 0,
    ];
  }
  const explicit = points.map(
    (point) => typeof point.slope === "number" && Number.isFinite(point.slope),
  );
  const secant = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    secant[i] = (b.y - a.y) / Math.max(0.000001, b.x - a.x);
  }
  const tangents = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (explicit[i]) {
      tangents[i] = points[i]!.slope!;
      continue;
    }
    if (i === 0) {
      tangents[i] = secant[0]!;
    } else if (i === n - 1) {
      tangents[i] = secant[n - 2]!;
    } else {
      const left = secant[i - 1]!;
      const right = secant[i]!;
      // Local extreme or a flat neighbour -> zero tangent (no overshoot).
      tangents[i] = left * right <= 0 ? 0 : (left + right) * 0.5;
    }
  }
  // Fritsch-Carlson limiter: keep each monotone segment from overshooting.
  // Only auto tangents are scaled; authored tangents are left intact.
  for (let i = 0; i < n - 1; i++) {
    const d = secant[i]!;
    if (d === 0) {
      if (!explicit[i]) tangents[i] = 0;
      if (!explicit[i + 1]) tangents[i + 1] = 0;
      continue;
    }
    const alpha = tangents[i]! / d;
    const beta = tangents[i + 1]! / d;
    const sumSq = alpha * alpha + beta * beta;
    if (sumSq > 9) {
      const tau = 3 / Math.sqrt(sumSq);
      if (!explicit[i]) tangents[i] = tau * alpha * d;
      if (!explicit[i + 1]) tangents[i + 1] = tau * beta * d;
    }
  }
  return tangents;
}

function normalizeGradientColorStops(
  value: unknown,
  start: Vec4,
  end: Vec4,
): ParticleGradientColorStop[] {
  const fallback: ParticleGradientColorStop[] = [
    { position: 0, color: [start[0], start[1], start[2]] },
    { position: 1, color: [end[0], end[1], end[2]] },
  ];
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const stops = source
    .map((stop): ParticleGradientColorStop | undefined => {
      if (!isRecord(stop)) return undefined;
      return {
        position: clampNumber(numberOr(stop.position, 0), 0, 1),
        color: normalizeVec3(stop.color, fallback[0]!.color, 0, 1),
      };
    })
    .filter((stop): stop is ParticleGradientColorStop => Boolean(stop))
    .sort((a, b) => a.position - b.position)
    .slice(0, PARTICLE_GRADIENT_STOP_LIMIT);
  if (stops.length === 0) return fallback;
  return stops;
}

function normalizeGradientAlphaStops(
  value: unknown,
  start: Vec4,
  end: Vec4,
): ParticleGradientAlphaStop[] {
  const fallback: ParticleGradientAlphaStop[] = [
    { position: 0, alpha: start[3] },
    { position: 1, alpha: end[3] },
  ];
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const stops = source
    .map((stop): ParticleGradientAlphaStop | undefined => {
      if (!isRecord(stop)) return undefined;
      return {
        position: clampNumber(numberOr(stop.position, 0), 0, 1),
        alpha: clampNumber(numberOr(stop.alpha, 1), 0, 1),
      };
    })
    .filter((stop): stop is ParticleGradientAlphaStop => Boolean(stop))
    .sort((a, b) => a.position - b.position)
    .slice(0, PARTICLE_GRADIENT_STOP_LIMIT);
  if (stops.length === 0) return fallback;
  return stops;
}

function sampleFloatLut(values: Float32Array, t: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0] ?? 0;
  const position = clampNumber(t, 0, 1) * (values.length - 1);
  const left = Math.floor(position);
  const right = Math.min(values.length - 1, left + 1);
  const mix = position - left;
  const a = values[left] ?? 0;
  const b = values[right] ?? a;
  return a + (b - a) * mix;
}

function normalizeSampleCount(samples: number): number {
  return Math.round(clampNumber(samples, 2, 1024));
}

function normalizeVec2(
  value: unknown,
  fallback: Vec2,
  min: number,
  max: number,
): Vec2 {
  if (!Array.isArray(value)) return [...fallback];
  return [
    clampNumber(numberOr(value[0], fallback[0]), min, max),
    clampNumber(numberOr(value[1], fallback[1]), min, max),
  ];
}

function normalizeVec3(
  value: unknown,
  fallback: Vec3,
  min: number,
  max: number,
): Vec3 {
  if (!Array.isArray(value)) return [...fallback];
  return [
    clampNumber(numberOr(value[0], fallback[0]), min, max),
    clampNumber(numberOr(value[1], fallback[1]), min, max),
    clampNumber(numberOr(value[2], fallback[2]), min, max),
  ];
}

function normalizeVec4(
  value: unknown,
  fallback: Vec4,
  min: number,
  max: number,
): Vec4 {
  if (!Array.isArray(value)) return [...fallback];
  return [
    clampNumber(numberOr(value[0], fallback[0]), min, max),
    clampNumber(numberOr(value[1], fallback[1]), min, max),
    clampNumber(numberOr(value[2], fallback[2]), min, max),
    clampNumber(numberOr(value[3], fallback[3]), min, max),
  ];
}

function safeId(value: unknown, fallback: string): string {
  const text = safeString(value, fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || fallback;
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampFiniteNumber(value: number, min: number, max: number): number {
  return clampNumber(Number.isFinite(value) ? value : min, min, max);
}

function normalizeRuntimeMultiplier(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ParticleRng {
  constructor(private state: number) {}

  reset(seed: number): void {
    this.state = seed >>> 0 || 0x7f4a7c15;
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
}

export class ParticleEmitterRuntimeState {
  readonly instanceData: Float32Array;
  readonly spawnLocalPositionData: Float32Array;
  readonly spawnDirectionData: Float32Array;
  readonly spawnOriginData: Float32Array;
  readonly runtimeFlagsData: Uint8Array;
  readonly triggerFlagsData: Uint8Array;
  readonly lastPosition: Vec3 = [0, 0, 0];
  readonly lastMoveVelocity: Vec3 = [0, 0, 0];
  activeCount = 0;
  emittedLastFrame = 0;
  uploadBytesLastFrame = 0;
  age = 0;
  loopIndex = -1;
  loopRandom = 0.5;
  accumulator = 0;
  distanceAccumulator = 0;
  hasLastPosition = false;
  hasPreviousEffectAge = false;
  previousEffectAge = 0;

  constructor(readonly capacity: number) {
    this.instanceData = new Float32Array(capacity * PARTICLE_INSTANCE_STRIDE);
    this.spawnLocalPositionData = new Float32Array(
      capacity * PARTICLE_RUNTIME_VECTOR_STRIDE,
    );
    this.spawnDirectionData = new Float32Array(
      capacity * PARTICLE_RUNTIME_VECTOR_STRIDE,
    );
    this.spawnOriginData = new Float32Array(
      capacity * PARTICLE_RUNTIME_VECTOR_STRIDE,
    );
    this.runtimeFlagsData = new Uint8Array(capacity);
    this.triggerFlagsData = new Uint8Array(capacity);
  }

  reset(): void {
    this.activeCount = 0;
    this.emittedLastFrame = 0;
    this.uploadBytesLastFrame = 0;
    this.age = 0;
    this.loopIndex = -1;
    this.loopRandom = 0.5;
    this.accumulator = 0;
    this.distanceAccumulator = 0;
    this.hasLastPosition = false;
    this.lastMoveVelocity[0] = 0;
    this.lastMoveVelocity[1] = 0;
    this.lastMoveVelocity[2] = 0;
    this.hasPreviousEffectAge = false;
    this.previousEffectAge = 0;
  }

  cloneWithCapacity(capacity: number): ParticleEmitterRuntimeState {
    const next = new ParticleEmitterRuntimeState(capacity);
    const activeCount = Math.min(this.activeCount, next.capacity);
    next.instanceData.set(
      this.instanceData.subarray(0, activeCount * PARTICLE_INSTANCE_STRIDE),
    );
    next.spawnLocalPositionData.set(
      this.spawnLocalPositionData.subarray(
        0,
        activeCount * PARTICLE_RUNTIME_VECTOR_STRIDE,
      ),
    );
    next.spawnDirectionData.set(
      this.spawnDirectionData.subarray(
        0,
        activeCount * PARTICLE_RUNTIME_VECTOR_STRIDE,
      ),
    );
    next.spawnOriginData.set(
      this.spawnOriginData.subarray(
        0,
        activeCount * PARTICLE_RUNTIME_VECTOR_STRIDE,
      ),
    );
    next.runtimeFlagsData.set(this.runtimeFlagsData.subarray(0, activeCount));
    next.triggerFlagsData.set(this.triggerFlagsData.subarray(0, activeCount));
    next.activeCount = activeCount;
    next.emittedLastFrame = this.emittedLastFrame;
    next.uploadBytesLastFrame = this.uploadBytesLastFrame;
    next.age = this.age;
    next.loopIndex = this.loopIndex;
    next.loopRandom = this.loopRandom;
    next.accumulator = this.accumulator;
    next.distanceAccumulator = this.distanceAccumulator;
    next.hasLastPosition = this.hasLastPosition;
    next.lastPosition[0] = this.lastPosition[0];
    next.lastPosition[1] = this.lastPosition[1];
    next.lastPosition[2] = this.lastPosition[2];
    next.lastMoveVelocity[0] = this.lastMoveVelocity[0];
    next.lastMoveVelocity[1] = this.lastMoveVelocity[1];
    next.lastMoveVelocity[2] = this.lastMoveVelocity[2];
    next.hasPreviousEffectAge = this.hasPreviousEffectAge;
    next.previousEffectAge = this.previousEffectAge;
    return next;
  }

  compact(
    timeSeconds: number,
    onDeath?: (particleIndex: number, deathTimeSeconds: number) => void,
  ): void {
    let i = 0;
    while (i < this.activeCount) {
      const offset = i * PARTICLE_INSTANCE_STRIDE;
      const start = this.instanceData[offset + 3] ?? 0;
      const life = this.instanceData[offset + 7] ?? 0;
      if (timeSeconds <= start + life) {
        i++;
        continue;
      }
      onDeath?.(i, start + life);
      this.activeCount--;
      if (i !== this.activeCount) {
        this.instanceData.copyWithin(
          offset,
          this.activeCount * PARTICLE_INSTANCE_STRIDE,
          (this.activeCount + 1) * PARTICLE_INSTANCE_STRIDE,
        );
        this.copyRuntimeSidecars(this.activeCount, i);
      }
    }
  }

  private copyRuntimeSidecars(fromIndex: number, toIndex: number): void {
    const from = fromIndex * PARTICLE_RUNTIME_VECTOR_STRIDE;
    const to = toIndex * PARTICLE_RUNTIME_VECTOR_STRIDE;
    this.spawnLocalPositionData[to + 0] = this.spawnLocalPositionData[from + 0];
    this.spawnLocalPositionData[to + 1] = this.spawnLocalPositionData[from + 1];
    this.spawnLocalPositionData[to + 2] = this.spawnLocalPositionData[from + 2];
    this.spawnDirectionData[to + 0] = this.spawnDirectionData[from + 0];
    this.spawnDirectionData[to + 1] = this.spawnDirectionData[from + 1];
    this.spawnDirectionData[to + 2] = this.spawnDirectionData[from + 2];
    this.spawnOriginData[to + 0] = this.spawnOriginData[from + 0];
    this.spawnOriginData[to + 1] = this.spawnOriginData[from + 1];
    this.spawnOriginData[to + 2] = this.spawnOriginData[from + 2];
    this.runtimeFlagsData[toIndex] = this.runtimeFlagsData[fromIndex] ?? 0;
    this.triggerFlagsData[toIndex] = this.triggerFlagsData[fromIndex] ?? 0;
  }
}

export class ParticleEffectRunner {
  readonly states: ParticleEmitterRuntimeState[];
  readonly events: ParticleEffectEvent[] = [];
  readonly subEmitterRequests: ParticleSubEmitterSpawnRequest[] = [];
  readonly stats: ParticleEffectRuntimeStats = {
    activeParticles: 0,
    capacity: 0,
    emittedLastFrame: 0,
    uploadBytesLastFrame: 0,
  };

  private readonly subEmitterDepth: number;
  private readonly maxSubEmitterDepth: number;
  private readonly maxEventsPerFrame: number;
  private readonly maxSubEmitterRequestsPerFrame: number;
  private rng = new ParticleRng(0x7f4a7c15);
  private effect: ParticleEffectDefinition;
  private position: Vec3 = [0, 0, 0];
  private readonly spawnSample = createParticleSpawnSample();
  /**
   * Host-bound emission sources for the "mesh" spawn shape, keyed by emitter
   * id. Deliberately survives reset()/updateDefinition(): the binding belongs
   * to the host, not to any one definition revision.
   */
  private readonly emissionGeometries = new Map<
    string,
    CompiledParticleEmissionGeometry
  >();
  private readonly runtimeParameterValues: ParticleEffectRuntimeParameters = {
    emissionRateMultiplier: 1,
    initialVelocityMultiplier: 1,
  };
  /** Emitter-scoped multipliers, composed over the effect-level values. */
  private readonly emitterRuntimeParameterValues = new Map<
    string,
    ParticleEmitterRuntimeParameters
  >();
  /** Wall-clock of the latest update()/reset(), for host-triggered bursts. */
  private lastTimeSeconds = 0;
  private startedAt = 0;
  private active = false;
  private emissionAllowed = true;

  constructor(
    effect: ParticleEffectDefinition,
    options: ParticleEffectRunnerOptions = {},
  ) {
    this.subEmitterDepth = Math.max(
      0,
      Math.floor(numberOr(options.subEmitterDepth, 0)),
    );
    this.maxSubEmitterDepth = Math.max(
      0,
      Math.floor(
        numberOr(options.maxSubEmitterDepth, DEFAULT_SUB_EMITTER_DEPTH_LIMIT),
      ),
    );
    this.maxEventsPerFrame = Math.max(
      0,
      Math.floor(
        numberOr(options.maxEventsPerFrame, DEFAULT_PARTICLE_EVENT_LIMIT),
      ),
    );
    this.maxSubEmitterRequestsPerFrame = Math.max(
      0,
      Math.floor(
        numberOr(
          options.maxSubEmitterRequestsPerFrame,
          DEFAULT_SUB_EMITTER_REQUEST_LIMIT,
        ),
      ),
    );
    this.effect = cloneParticleEffect(effect);
    this.states = this.effect.emitters.map(
      (emitter) => new ParticleEmitterRuntimeState(emitter.maxParticles),
    );
    this.refreshCapacity();
  }

  get definition(): ParticleEffectDefinition {
    return this.effect;
  }

  get isActive(): boolean {
    return this.active;
  }

  get runtimeParameters(): Readonly<ParticleEffectRuntimeParameters> {
    return this.runtimeParameterValues;
  }

  reset(
    effect: ParticleEffectDefinition,
    position: Vec3,
    timeSeconds: number,
    seed = 0x7f4a7c15,
  ): void {
    this.effect = cloneParticleEffect(effect);
    this.position[0] = position[0];
    this.position[1] = position[1];
    this.position[2] = position[2];
    this.startedAt = timeSeconds;
    this.lastTimeSeconds = timeSeconds;
    this.active = true;
    this.emissionAllowed = true;
    this.clearFrameEvents();
    this.rng.reset(seed ^ hashString(this.effect.id));
    this.resizeStates();
    for (const state of this.states) state.reset();
    this.refreshCapacity();
  }

  setPosition(position: Vec3): void {
    this.position[0] = position[0];
    this.position[1] = position[1];
    this.position[2] = position[2];
  }

  updateDefinition(effect: ParticleEffectDefinition): void {
    this.effect = cloneParticleEffect(effect);
    this.resizeStates();
    this.refreshCapacity();
  }

  allowCompletion(): void {
    this.emissionAllowed = false;
  }

  resumeEmission(): void {
    if (this.active) this.emissionAllowed = true;
  }

  /**
   * Binds (or clears, with null) the emission source geometry used by an
   * emitter whose spawn shape is "mesh". Compilation happens once here;
   * passing invalid geometry (no vertices, out-of-range indices) clears the
   * binding. Returns true when a geometry is bound after the call.
   */
  setEmissionGeometry(
    emitterId: string,
    geometry: ParticleEmissionGeometryInput | null,
  ): boolean {
    if (!geometry) {
      this.emissionGeometries.delete(emitterId);
      return false;
    }
    const compiled = compileParticleEmissionGeometry(geometry);
    if (!compiled) {
      this.emissionGeometries.delete(emitterId);
      return false;
    }
    this.emissionGeometries.set(emitterId, compiled);
    return true;
  }

  getEmissionGeometry(
    emitterId: string,
  ): CompiledParticleEmissionGeometry | null {
    return this.emissionGeometries.get(emitterId) ?? null;
  }

  setRuntimeParameters(parameters: ParticleEffectRuntimeParameterPatch): void {
    if (parameters.emissionRateMultiplier !== undefined) {
      this.runtimeParameterValues.emissionRateMultiplier =
        normalizeRuntimeMultiplier(parameters.emissionRateMultiplier);
    }
    if (parameters.initialVelocityMultiplier !== undefined) {
      this.runtimeParameterValues.initialVelocityMultiplier =
        normalizeRuntimeMultiplier(parameters.initialVelocityMultiplier);
    }
  }

  /**
   * Patches emitter-scoped runtime multipliers (merging over previous
   * patches; unspecified fields keep their value, which starts at 1). They
   * multiply the effect-level parameters, so hosts can e.g. mute one emitter
   * (emissionRateMultiplier: 0) while a global slider scales the rest.
   */
  setEmitterRuntimeParameters(
    emitterId: string,
    parameters: ParticleEmitterRuntimeParameterPatch,
  ): void {
    const current = this.emitterRuntimeParameterValues.get(emitterId) ?? {
      emissionRateMultiplier: 1,
      initialVelocityMultiplier: 1,
    };
    if (parameters.emissionRateMultiplier !== undefined) {
      current.emissionRateMultiplier = normalizeRuntimeMultiplier(
        parameters.emissionRateMultiplier,
      );
    }
    if (parameters.initialVelocityMultiplier !== undefined) {
      current.initialVelocityMultiplier = normalizeRuntimeMultiplier(
        parameters.initialVelocityMultiplier,
      );
    }
    this.emitterRuntimeParameterValues.set(emitterId, current);
  }

  getEmitterRuntimeParameters(
    emitterId: string,
  ): Readonly<ParticleEmitterRuntimeParameters> | null {
    return this.emitterRuntimeParameterValues.get(emitterId) ?? null;
  }

  /** Effect-level × emitter-level emission rate multiplier. */
  effectiveEmissionRateMultiplier(emitterId: string): number {
    return (
      this.runtimeParameterValues.emissionRateMultiplier *
      (this.emitterRuntimeParameterValues.get(emitterId)
        ?.emissionRateMultiplier ?? 1)
    );
  }

  /** Effect-level × emitter-level initial velocity multiplier. */
  effectiveInitialVelocityMultiplier(emitterId: string): number {
    return (
      this.runtimeParameterValues.initialVelocityMultiplier *
      (this.emitterRuntimeParameterValues.get(emitterId)
        ?.initialVelocityMultiplier ?? 1)
    );
  }

  /**
   * Emits an immediate host-triggered burst from one emitter at the current
   * runner time, bypassing the authored burst schedule. Returns how many
   * particles were actually emitted (capacity-clamped; 0 when the runner is
   * inactive or the emitter is unknown/disabled). `position` temporarily
   * relocates the emitter for just this burst.
   */
  emitBurst(emitterId: string, options: ParticleBurstEmitOptions = {}): number {
    if (!this.active) return 0;
    const index = this.effect.emitters.findIndex(
      (emitter) => emitter.id === emitterId,
    );
    if (index < 0) return 0;
    const emitter = this.effect.emitters[index];
    const state = this.states[index];
    if (!emitter || !state || !emitter.enabled) return 0;
    const count = Math.max(1, Math.floor(numberOr(options.count, 1)));
    const before = state.activeCount;
    const savedX = this.position[0];
    const savedY = this.position[1];
    const savedZ = this.position[2];
    if (options.position) {
      this.position[0] = options.position[0];
      this.position[1] = options.position[1];
      this.position[2] = options.position[2];
    }
    this.emitParticles(emitter, state, count, this.lastTimeSeconds);
    this.position[0] = savedX;
    this.position[1] = savedY;
    this.position[2] = savedZ;
    return state.activeCount - before;
  }

  stop(): void {
    this.active = false;
    this.clearFrameEvents();
    for (const state of this.states) state.reset();
    this.refreshStats();
  }

  update(dt: number, timeSeconds: number): boolean {
    this.clearFrameEvents();
    this.lastTimeSeconds = timeSeconds;
    if (!this.active) return false;
    let anyAlive = false;
    let allEmittersDone = true;
    for (let i = 0; i < this.effect.emitters.length; i++) {
      const emitter = this.effect.emitters[i]!;
      const state = this.states[i]!;
      state.emittedLastFrame = 0;
      state.uploadBytesLastFrame = 0;
      this.recordParticleFrameEvents(emitter, state, i, dt, timeSeconds);
      state.compact(timeSeconds, (particleIndex, deathTimeSeconds) =>
        this.recordParticleDeathEvent(
          emitter,
          state,
          i,
          particleIndex,
          deathTimeSeconds,
        ),
      );
      if (!emitter.enabled) {
        anyAlive = anyAlive || state.activeCount > 0;
        continue;
      }
      const emitterAge =
        timeSeconds - this.startedAt - Math.max(0, emitter.timeline.start);
      state.age = emitterAge;
      if (emitterAge < 0) {
        if (this.emissionAllowed) allEmittersDone = false;
        anyAlive = anyAlive || state.activeCount > 0;
        continue;
      }
      const emitting =
        emitter.loop || state.age <= Math.max(0.001, emitter.duration);
      if (emitting && this.emissionAllowed) {
        allEmittersDone = false;
        this.updateEmitter(emitter, state, dt, timeSeconds);
      } else if (emitting) {
        this.advanceEmitterWithoutEmission(emitter, state, emitterAge);
      }
      anyAlive = anyAlive || state.activeCount > 0;
    }
    this.refreshStats();
    if (allEmittersDone && !anyAlive) {
      this.active = false;
      return false;
    }
    return true;
  }

  private advanceEmitterWithoutEmission(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterAge: number,
  ): void {
    const duration = Math.max(0.001, emitter.duration);
    const movedX = state.hasLastPosition
      ? this.position[0] - state.lastPosition[0]
      : 0;
    const movedY = state.hasLastPosition
      ? this.position[1] - state.lastPosition[1]
      : 0;
    const movedZ = state.hasLastPosition
      ? this.position[2] - state.lastPosition[2]
      : 0;
    if (state.hasLastPosition) {
      translateLocalSpaceParticles(state, movedX, movedY, movedZ);
    }
    state.age = emitter.loop ? emitterAge % duration : emitterAge;
    state.previousEffectAge = Math.max(0, emitterAge);
    state.hasPreviousEffectAge = true;
    state.lastPosition[0] = this.position[0];
    state.lastPosition[1] = this.position[1];
    state.lastPosition[2] = this.position[2];
    state.lastMoveVelocity[0] = 0;
    state.lastMoveVelocity[1] = 0;
    state.lastMoveVelocity[2] = 0;
    state.hasLastPosition = true;
  }

  private updateEmitter(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    dt: number,
    timeSeconds: number,
  ): void {
    const duration = Math.max(0.001, emitter.duration);
    const effectAge = Math.max(0, state.age);
    const previousEffectAge = state.hasPreviousEffectAge
      ? state.previousEffectAge
      : 0;
    const loopIndex = emitter.loop ? Math.floor(effectAge / duration) : 0;
    if (loopIndex !== state.loopIndex) {
      state.loopIndex = loopIndex;
      state.loopRandom = this.rng.next();
    }
    if (emitter.loop) {
      state.age = effectAge % duration;
    }
    this.emitDueBursts(
      emitter,
      state,
      previousEffectAge,
      effectAge,
      timeSeconds,
      duration,
    );
    const ageT = clampNumber(state.age / duration, 0, 1);
    const emissionRateMultiplier = this.effectiveEmissionRateMultiplier(
      emitter.id,
    );
    const rate =
      sampleParticleScalarValue(
        emitter.spawn.rateValue,
        ageT,
        state.loopRandom,
      ) * emissionRateMultiplier;
    const distanceRate =
      sampleParticleScalarValue(
        emitter.spawn.rateOverDistanceValue,
        ageT,
        state.loopRandom,
      ) * emissionRateMultiplier;
    const movedX = state.hasLastPosition
      ? this.position[0] - state.lastPosition[0]
      : 0;
    const movedY = state.hasLastPosition
      ? this.position[1] - state.lastPosition[1]
      : 0;
    const movedZ = state.hasLastPosition
      ? this.position[2] - state.lastPosition[2]
      : 0;
    const movedDistance = Math.hypot(movedX, movedY, movedZ);
    const inverseDt = dt > 0 ? 1 / dt : 0;
    state.lastMoveVelocity[0] = movedX * inverseDt;
    state.lastMoveVelocity[1] = movedY * inverseDt;
    state.lastMoveVelocity[2] = movedZ * inverseDt;
    if (state.hasLastPosition) {
      translateLocalSpaceParticles(state, movedX, movedY, movedZ);
    }
    state.lastPosition[0] = this.position[0];
    state.lastPosition[1] = this.position[1];
    state.lastPosition[2] = this.position[2];
    state.hasLastPosition = true;
    state.accumulator += Math.max(0, rate) * Math.max(0, dt);
    state.distanceAccumulator +=
      Math.max(0, distanceRate) * Math.max(0, movedDistance);
    if (state.distanceAccumulator >= 1) {
      state.accumulator += Math.floor(state.distanceAccumulator);
      state.distanceAccumulator %= 1;
    }
    const count = Math.floor(state.accumulator);
    if (count > 0) {
      state.accumulator -= count;
      this.emitParticles(emitter, state, count, timeSeconds);
    }
    state.previousEffectAge = effectAge;
    state.hasPreviousEffectAge = true;
  }

  private emitDueBursts(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    previousEffectAge: number,
    effectAge: number,
    timeSeconds: number,
    duration: number,
  ): void {
    if (effectAge < previousEffectAge) return;
    const firstLoop = emitter.loop
      ? Math.max(0, Math.floor(previousEffectAge / duration))
      : 0;
    const lastLoop = emitter.loop
      ? Math.max(0, Math.floor(effectAge / duration))
      : 0;
    const loopStart = Math.max(
      firstLoop,
      lastLoop - PARTICLE_BURST_CATCHUP_LOOP_LIMIT + 1,
    );
    for (let loop = loopStart; loop <= lastLoop; loop++) {
      for (const schedule of emitter.spawn.bursts) {
        this.emitScheduleIfDue(
          emitter,
          state,
          schedule,
          previousEffectAge,
          effectAge,
          timeSeconds,
          duration,
          loop,
        );
      }
      if (!emitter.loop) break;
    }
  }

  private emitScheduleIfDue(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    schedule: ParticleBurstSchedule,
    previousEffectAge: number,
    effectAge: number,
    timeSeconds: number,
    duration: number,
    loopIndex: number,
  ): void {
    const loopStart = emitter.loop ? loopIndex * duration : 0;
    for (let cycle = 0; cycle < schedule.cycles; cycle++) {
      const localTime = schedule.time + schedule.interval * cycle;
      if (localTime > duration && !emitter.loop) break;
      if (localTime > duration) continue;
      const eventTime = loopStart + localTime;
      if (!isBurstTimeDue(eventTime, previousEffectAge, effectAge, state)) {
        continue;
      }
      if (schedule.probability <= 0) continue;
      if (schedule.probability < 1 && this.rng.next() > schedule.probability) {
        continue;
      }
      this.emitParticles(emitter, state, schedule.count, timeSeconds);
    }
  }

  private emitParticles(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    count: number,
    timeSeconds: number,
  ): void {
    const emitCount = Math.min(count, state.capacity - state.activeCount);
    for (let i = 0; i < emitCount; i++) {
      this.emitParticle(emitter, state, timeSeconds, i, emitCount);
    }
    state.emittedLastFrame += emitCount;
  }

  private emitParticle(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    timeSeconds: number,
    emitIndex: number,
    emitCount: number,
  ): void {
    const slot = state.activeCount * PARTICLE_INSTANCE_STRIDE;
    const spawn = emitter.spawn;
    const emitterT = clampNumber(
      state.age / Math.max(0.001, emitter.duration),
      0,
      1,
    );
    const spawnSample = this.spawnSample;
    sampleParticleSpawn(
      spawn,
      this.rng,
      emitterT,
      emitIndex,
      emitCount,
      spawnSample,
      spawn.shape === "mesh"
        ? (this.emissionGeometries.get(emitter.id) ?? null)
        : null,
    );
    const x = this.position[0] + spawnSample.position[0];
    const y = this.position[1] + spawnSample.position[1];
    const z = this.position[2] + spawnSample.position[2];
    const init = emitter.initializeParticle;
    let life = Math.max(
      0.001,
      sampleParticleScalarValue(init.lifetime, emitterT, this.rng.next()),
    );
    const initVelocity = init.velocity;
    let velocityX = 0;
    let velocityY = 0;
    let velocityZ = 0;
    if (initVelocity.mode === "vector") {
      velocityX = randomBetween(
        this.rng,
        initVelocity.min[0],
        initVelocity.max[0],
      );
      velocityY = randomBetween(
        this.rng,
        initVelocity.min[1],
        initVelocity.max[1],
      );
      velocityZ = randomBetween(
        this.rng,
        initVelocity.min[2],
        initVelocity.max[2],
      );
    } else {
      const startSpeed = Math.max(
        0,
        sampleParticleScalarValue(
          initVelocity.speed,
          emitterT,
          scalarRandom(initVelocity.speed, this.rng),
        ),
      );
      velocityX = spawnSample.direction[0] * startSpeed;
      velocityY = spawnSample.direction[1] * startSpeed;
      velocityZ = spawnSample.direction[2] * startSpeed;
    }
    if (emitter.modules.inheritVelocity) {
      const multiplier = sampleParticleScalarValue(
        emitter.advanced.inheritVelocity.multiplier,
        emitterT,
        this.rng.next(),
      );
      velocityX += state.lastMoveVelocity[0] * multiplier;
      velocityY += state.lastMoveVelocity[1] * multiplier;
      velocityZ += state.lastMoveVelocity[2] * multiplier;
    }
    if (emitter.modules.limitVelocityOverLifetime) {
      const settings = emitter.advanced.limitVelocityOverLifetime;
      const dampen = settings.dampen;
      const drag = sampleParticleScalarValue(
        settings.drag,
        emitterT,
        this.rng.next(),
      );
      const sizeFactor =
        settings.multiplyBySize && emitter.modules.size
          ? Math.max(
              0.001,
              sampleParticleScalarValue(
                emitter.mode === "billboard"
                  ? emitter.billboard.sizeValue
                  : emitter.mesh.sizeValue,
                emitterT,
                this.rng.next(),
              ),
            )
          : 1;
      if (settings.separateAxes) {
        velocityX = limitVelocityAxis(
          velocityX,
          sampleParticleScalarValue(settings.x, emitterT, this.rng.next()) *
            sizeFactor,
          dampen,
        );
        velocityY = limitVelocityAxis(
          velocityY,
          sampleParticleScalarValue(settings.y, emitterT, this.rng.next()) *
            sizeFactor,
          dampen,
        );
        velocityZ = limitVelocityAxis(
          velocityZ,
          sampleParticleScalarValue(settings.z, emitterT, this.rng.next()) *
            sizeFactor,
          dampen,
        );
      } else {
        const maxSpeed =
          sampleParticleScalarValue(settings.speed, emitterT, this.rng.next()) *
          sizeFactor;
        const speed = Math.hypot(velocityX, velocityY, velocityZ);
        if (speed > Math.max(0, maxSpeed)) {
          const targetSpeed =
            Math.max(0, maxSpeed) +
            (speed - Math.max(0, maxSpeed)) * (1 - dampen);
          const scale = targetSpeed / Math.max(0.000001, speed);
          velocityX *= scale;
          velocityY *= scale;
          velocityZ *= scale;
        }
      }
      if (drag > 0) {
        const dragScale = Math.max(0, 1 - drag * 0.05);
        velocityX *= dragScale;
        velocityY *= dragScale;
        velocityZ *= dragScale;
      }
    }
    if (emitter.modules.lifetimeByEmitterSpeed) {
      const speedT = particleSpeedRangeRatio(
        emitter.advanced.lifetimeByEmitterSpeed.speedRange,
        Math.hypot(velocityX, velocityY, velocityZ),
      );
      life = Math.max(
        0.001,
        life *
          sampleParticleScalarValue(
            emitter.advanced.lifetimeByEmitterSpeed.multiplier,
            speedT,
            this.rng.next(),
          ),
      );
    }
    const particleIndex = state.activeCount;
    const runtimeVectorSlot = particleIndex * PARTICLE_RUNTIME_VECTOR_STRIDE;
    state.spawnLocalPositionData[runtimeVectorSlot + 0] =
      spawnSample.position[0];
    state.spawnLocalPositionData[runtimeVectorSlot + 1] =
      spawnSample.position[1];
    state.spawnLocalPositionData[runtimeVectorSlot + 2] =
      spawnSample.position[2];
    state.spawnOriginData[runtimeVectorSlot + 0] = this.position[0];
    state.spawnOriginData[runtimeVectorSlot + 1] = this.position[1];
    state.spawnOriginData[runtimeVectorSlot + 2] = this.position[2];
    writeParticleDirection(
      state.spawnDirectionData,
      runtimeVectorSlot,
      velocityX,
      velocityY,
      velocityZ,
      spawnSample.direction,
    );
    state.runtimeFlagsData[particleIndex] =
      (spawn.simulationSpace === "local"
        ? PARTICLE_RUNTIME_FLAG_LOCAL_SPACE
        : 0) |
      (spawn.alignToDirection || emitter.render.alignAxis === "spawnDirection"
        ? PARTICLE_RUNTIME_FLAG_ALIGN_TO_DIRECTION
        : 0);
    state.instanceData[slot + 0] = x;
    state.instanceData[slot + 1] = y;
    state.instanceData[slot + 2] = z;
    state.instanceData[slot + 3] = timeSeconds;
    state.instanceData[slot + 4] = velocityX;
    state.instanceData[slot + 5] = velocityY;
    state.instanceData[slot + 6] = velocityZ;
    state.instanceData[slot + 7] = life;
    state.instanceData[slot + 8] = this.rng.next();
    // B4/F10: Start Rotation always sets the particle's initial orientation,
    // independent of the Rotation-over-Lifetime toggle. One correlated draw is
    // used for all start-rotation axes, and one for angular velocity, so older
    // scalar effects keep their downstream RNG sequence. Mesh emitters have
    // always used XYZ; billboards opt into XYZ with startRotationSeparateAxes.
    // The rotation module toggle only decides whether the angular-velocity
    // (over-life spin) terms are written.
    const rotationRandom = this.rng.next();
    const useStartRotation3D =
      emitter.mode === "mesh" || init.startRotationSeparateAxes;
    const startRotationX = useStartRotation3D
      ? sampleParticleScalarValue(init.rotation3D.x, emitterT, rotationRandom)
      : 0;
    const startRotationY = useStartRotation3D
      ? sampleParticleScalarValue(init.rotation3D.y, emitterT, rotationRandom)
      : 0;
    const startRotationZ = useStartRotation3D
      ? sampleParticleScalarValue(init.rotation3D.z, emitterT, rotationRandom)
      : sampleParticleScalarValue(init.rotation, emitterT, rotationRandom);
    state.instanceData[slot + 9] = startRotationZ;
    state.instanceData[slot + 13] = startRotationX;
    state.instanceData[slot + 14] = startRotationY;
    const angularVelocityRandom = this.rng.next();
    const angularVelocityX = init.angularVelocitySeparateAxes
      ? sampleParticleScalarValue(
          init.angularVelocity3D.x,
          emitterT,
          angularVelocityRandom,
        )
      : 0;
    const angularVelocityY = init.angularVelocitySeparateAxes
      ? sampleParticleScalarValue(
          init.angularVelocity3D.y,
          emitterT,
          angularVelocityRandom,
        )
      : 0;
    const angularVelocityZ = init.angularVelocitySeparateAxes
      ? sampleParticleScalarValue(
          init.angularVelocity3D.z,
          emitterT,
          angularVelocityRandom,
        )
      : sampleParticleScalarValue(
          init.angularVelocity,
          emitterT,
          angularVelocityRandom,
        );
    state.instanceData[slot + 10] = emitter.modules.rotation
      ? angularVelocityZ
      : 0;
    state.instanceData[slot + 15] = emitter.modules.rotation
      ? angularVelocityX
      : 0;
    state.instanceData[slot + 16] = emitter.modules.rotation
      ? angularVelocityY
      : 0;
    // Slots 11/12/17 store the per-particle INITIAL X/Y/Z size. Flat renderers
    // draw X/Y only; Three mesh assets also consume Z for true depth scale.
    if (emitter.mode === "mesh") {
      // I13-C: independent per-axis random draws so X/Y/Z decorrelate.
      // scalarRandom draws rng.next() only for
      // random/randomCurve axes and returns 0.5 (no draw) otherwise, so
      // constant/curve axes stay byte-identical. Draw order is fixed X, Y, Z.
      const sizeRandomX = scalarRandom(init.size3D.x, this.rng);
      const sizeRandomY = scalarRandom(init.size3D.y, this.rng);
      const sizeRandomZ = scalarRandom(init.size3D.z, this.rng);
      state.instanceData[slot + 11] = Math.max(
        0,
        sampleParticleScalarValue(init.size3D.x, emitterT, sizeRandomX),
      );
      state.instanceData[slot + 12] = Math.max(
        0,
        sampleParticleScalarValue(init.size3D.y, emitterT, sizeRandomY),
      );
      state.instanceData[slot + 17] = Math.max(
        0,
        sampleParticleScalarValue(init.size3D.z, emitterT, sizeRandomZ),
      );
    } else if (init.startSizeSeparateAxes) {
      // I13-C: independent per-axis random draws for X and Y. Z is unused by
      // billboards (only mesh reads
      // slot 17) and stays a copy of X — no rng draw for Z. Constant/curve axes
      // stay byte-identical (scalarRandom returns 0.5 without drawing).
      const sizeRandomX = scalarRandom(init.size3D.x, this.rng);
      const sizeRandomY = scalarRandom(init.size3D.y, this.rng);
      state.instanceData[slot + 11] = Math.max(
        0,
        sampleParticleScalarValue(init.size3D.x, emitterT, sizeRandomX),
      );
      state.instanceData[slot + 12] = Math.max(
        0,
        sampleParticleScalarValue(init.size3D.y, emitterT, sizeRandomY),
      );
      state.instanceData[slot + 17] = state.instanceData[slot + 11];
    } else {
      const initSize = Math.max(
        0,
        sampleParticleScalarValue(
          init.size,
          emitterT,
          scalarRandom(init.size, this.rng),
        ),
      );
      state.instanceData[slot + 11] = initSize;
      state.instanceData[slot + 12] = initSize;
      state.instanceData[slot + 17] = initSize;
    }
    state.activeCount++;
    this.recordParticleBirthEvent(
      emitter,
      state,
      Math.max(0, this.effect.emitters.indexOf(emitter)),
      particleIndex,
      timeSeconds,
    );
  }

  private clearFrameEvents(): void {
    this.events.length = 0;
    this.subEmitterRequests.length = 0;
  }

  private recordParticleFrameEvents(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterIndex: number,
    dt: number,
    timeSeconds: number,
  ): void {
    if (
      state.activeCount <= 0 ||
      (!emitter.modules.triggers &&
        !emitter.modules.subEmitters &&
        !emitter.modules.collision)
    ) {
      return;
    }
    const previousTimeSeconds = timeSeconds - Math.max(0, dt);
    for (
      let particleIndex = 0;
      particleIndex < state.activeCount;
      particleIndex++
    ) {
      this.recordNormalizedTimeEventIfDue(
        emitter,
        state,
        emitterIndex,
        particleIndex,
        previousTimeSeconds,
        timeSeconds,
      );
      this.recordCollisionEventIfDue(
        emitter,
        state,
        emitterIndex,
        particleIndex,
        previousTimeSeconds,
        timeSeconds,
      );
    }
  }

  private recordParticleBirthEvent(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterIndex: number,
    particleIndex: number,
    timeSeconds: number,
  ): void {
    const event = this.createParticleEvent(
      "birth",
      emitter,
      state,
      emitterIndex,
      particleIndex,
      timeSeconds,
      0,
      0,
      emitter.advanced.triggers.birthEvent,
    );
    if (emitter.modules.triggers && event.eventName) {
      this.pushParticleEvent(event);
    }
    this.queueSubEmitterRequest(
      event,
      state,
      emitter.advanced.subEmitters.birth,
    );
    if (
      emitter.modules.triggers &&
      emitter.advanced.triggers.normalizedTime <= 0
    ) {
      state.triggerFlagsData[particleIndex] |=
        PARTICLE_TRIGGER_FLAG_NORMALIZED_TIME;
      const timeEvent = {
        ...event,
        kind: "normalizedTime" as const,
        eventName: "normalized-time",
      };
      this.pushParticleEvent(timeEvent);
    }
  }

  private recordParticleDeathEvent(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterIndex: number,
    particleIndex: number,
    deathTimeSeconds: number,
  ): void {
    const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
    const start = state.instanceData[offset + 3] ?? deathTimeSeconds;
    const life = Math.max(0.001, state.instanceData[offset + 7] ?? 0.001);
    const event = this.createParticleEvent(
      "death",
      emitter,
      state,
      emitterIndex,
      particleIndex,
      deathTimeSeconds,
      Math.max(0, deathTimeSeconds - start),
      1,
      emitter.advanced.triggers.deathEvent,
    );
    if (emitter.modules.triggers && event.eventName) {
      this.pushParticleEvent(event);
    }
    if (
      emitter.modules.triggers &&
      emitter.advanced.triggers.normalizedTime >= 1 &&
      (state.triggerFlagsData[particleIndex] &
        PARTICLE_TRIGGER_FLAG_NORMALIZED_TIME) ===
        0
    ) {
      state.triggerFlagsData[particleIndex] |=
        PARTICLE_TRIGGER_FLAG_NORMALIZED_TIME;
      this.pushParticleEvent({
        ...event,
        kind: "normalizedTime",
        eventName: "normalized-time",
        particleAge: life,
        normalizedAge: 1,
      });
    }
    this.queueSubEmitterRequest(
      event,
      state,
      emitter.advanced.subEmitters.death,
    );
  }

  private recordNormalizedTimeEventIfDue(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterIndex: number,
    particleIndex: number,
    previousTimeSeconds: number,
    timeSeconds: number,
  ): void {
    if (!emitter.modules.triggers) return;
    const threshold = emitter.advanced.triggers.normalizedTime;
    if (threshold <= 0 || threshold >= 1) return;
    const flag = state.triggerFlagsData[particleIndex] ?? 0;
    if (
      emitter.advanced.triggers.oneShot &&
      flag & PARTICLE_TRIGGER_FLAG_NORMALIZED_TIME
    ) {
      return;
    }
    const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
    const start = state.instanceData[offset + 3] ?? 0;
    const life = Math.max(0.001, state.instanceData[offset + 7] ?? 0.001);
    const previousNormalizedAge = clampNumber(
      (previousTimeSeconds - start) / life,
      0,
      1,
    );
    const normalizedAge = clampNumber((timeSeconds - start) / life, 0, 1);
    const crossed =
      emitter.advanced.triggers.oneShot || previousNormalizedAge < threshold
        ? previousNormalizedAge < threshold - PARTICLE_TIME_EPSILON &&
          normalizedAge + PARTICLE_TIME_EPSILON >= threshold
        : normalizedAge + PARTICLE_TIME_EPSILON >= threshold;
    if (!crossed) return;
    state.triggerFlagsData[particleIndex] |=
      PARTICLE_TRIGGER_FLAG_NORMALIZED_TIME;
    const eventTimeSeconds = start + life * threshold;
    const event = this.createParticleEvent(
      "normalizedTime",
      emitter,
      state,
      emitterIndex,
      particleIndex,
      eventTimeSeconds,
      life * threshold,
      threshold,
      "normalized-time",
    );
    this.pushParticleEvent(event);
  }

  private recordCollisionEventIfDue(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterIndex: number,
    particleIndex: number,
    previousTimeSeconds: number,
    timeSeconds: number,
  ): void {
    if (!emitter.modules.collision) return;
    const collision = emitter.advanced.collision;
    if (collision.mode !== "plane") return;
    const wantsSubEmitter =
      emitter.modules.subEmitters &&
      Boolean(emitter.advanced.subEmitters.collision.effectFile);
    if (!emitter.modules.triggers && !wantsSubEmitter) return;
    if (
      (state.triggerFlagsData[particleIndex] ?? 0) &
      PARTICLE_TRIGGER_FLAG_COLLISION
    ) {
      return;
    }
    const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
    const start = state.instanceData[offset + 3] ?? 0;
    const life = Math.max(0.001, state.instanceData[offset + 7] ?? 0.001);
    const previousAge = clampNumber(previousTimeSeconds - start, 0, life);
    const age = clampNumber(timeSeconds - start, 0, life);
    if (age <= 0) return;
    const previousPosition = sampleParticleKinematicPosition(
      emitter,
      state,
      particleIndex,
      previousAge,
      previousAge / life,
      this.position,
    );
    const position = sampleParticleKinematicPosition(
      emitter,
      state,
      particleIndex,
      age,
      age / life,
      this.position,
    );
    const floor = collision.planeY + collision.radius;
    if (!(previousPosition[1] >= floor && position[1] < floor)) return;
    state.triggerFlagsData[particleIndex] |= PARTICLE_TRIGGER_FLAG_COLLISION;
    const event = this.createParticleEvent(
      "collision",
      emitter,
      state,
      emitterIndex,
      particleIndex,
      timeSeconds,
      age,
      age / life,
      "collision",
    );
    if (emitter.modules.triggers) {
      this.pushParticleEvent(event);
    }
    this.queueSubEmitterRequest(
      event,
      state,
      emitter.advanced.subEmitters.collision,
    );
  }

  private createParticleEvent(
    kind: ParticleEffectEventKind,
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterIndex: number,
    particleIndex: number,
    timeSeconds: number,
    particleAge: number,
    normalizedAge: number,
    eventName: string,
  ): ParticleEffectEvent {
    const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
    const seed = state.instanceData[offset + 8] ?? 0;
    return {
      kind,
      eventName,
      effectId: this.effect.id,
      emitterId: emitter.id,
      emitterIndex,
      particleIndex,
      particleSeed: seed,
      timeSeconds,
      effectAge: Math.max(0, timeSeconds - this.startedAt),
      particleAge,
      normalizedAge: clampNumber(normalizedAge, 0, 1),
      position: sampleParticleKinematicPosition(
        emitter,
        state,
        particleIndex,
        particleAge,
        normalizedAge,
        this.position,
      ),
      velocity: sampleParticleKinematicVelocity(
        emitter,
        state,
        particleIndex,
        particleAge,
        normalizedAge,
        this.position,
      ),
    };
  }

  private pushParticleEvent(event: ParticleEffectEvent): void {
    if (this.events.length >= this.maxEventsPerFrame) return;
    this.events.push(event);
  }

  private queueSubEmitterRequest(
    event: ParticleEffectEvent,
    state: ParticleEmitterRuntimeState,
    slot: ParticleSubEmitterSlotSettings,
  ): void {
    const emitter = this.effect.emitters[event.emitterIndex];
    if (!emitter?.modules.subEmitters) return;
    if (!slot.effectFile || this.subEmitterDepth >= this.maxSubEmitterDepth) {
      return;
    }
    if (this.subEmitterRequests.length >= this.maxSubEmitterRequestsPerFrame) {
      return;
    }
    if (
      slot.probability <= 0 ||
      deterministicSubEmitterProbability(event, slot.effectFile) >
        slot.probability
    ) {
      return;
    }
    this.subEmitterRequests.push({
      hook: event.kind,
      effectFile: slot.effectFile,
      sourceEffectId: event.effectId,
      sourceEmitterId: event.emitterId,
      sourceEmitterIndex: event.emitterIndex,
      sourceParticleIndex: event.particleIndex,
      sourceParticleSeed: event.particleSeed,
      timeSeconds: event.timeSeconds,
      position: [...event.position],
      velocity: [...event.velocity],
      normalizedAge: event.normalizedAge,
      inheritColor: slot.inheritColor,
      inheritSize: slot.inheritSize,
      inheritedColor: slot.inheritColor
        ? sampleParticleInheritedColor(emitter, event.normalizedAge)
        : null,
      inheritedSize: slot.inheritSize
        ? sampleParticleInheritedSize(
            emitter,
            state,
            event.particleIndex,
            event.normalizedAge,
          )
        : null,
      depth: this.subEmitterDepth,
      nextDepth: this.subEmitterDepth + 1,
      maxDepth: this.maxSubEmitterDepth,
    });
  }

  private resizeStates(): void {
    while (this.states.length < this.effect.emitters.length) {
      const emitter = this.effect.emitters[this.states.length]!;
      this.states.push(new ParticleEmitterRuntimeState(emitter.maxParticles));
    }
    for (let i = 0; i < this.effect.emitters.length; i++) {
      const emitter = this.effect.emitters[i]!;
      const state = this.states[i]!;
      if (state.capacity !== emitter.maxParticles) {
        this.states[i] = state.cloneWithCapacity(emitter.maxParticles);
      }
    }
    this.states.length = this.effect.emitters.length;
  }

  private refreshStats(): void {
    let activeParticles = 0;
    let emittedLastFrame = 0;
    let uploadBytesLastFrame = 0;
    for (const state of this.states) {
      activeParticles += state.activeCount;
      emittedLastFrame += state.emittedLastFrame;
      uploadBytesLastFrame += state.uploadBytesLastFrame;
    }
    this.stats.activeParticles = activeParticles;
    this.stats.emittedLastFrame = emittedLastFrame;
    this.stats.uploadBytesLastFrame = uploadBytesLastFrame;
  }

  private refreshCapacity(): void {
    let capacity = 0;
    for (const state of this.states) capacity += state.capacity;
    this.stats.capacity = capacity;
  }
}

/** Normalized 0..1 loop age of the emitter, the "loopAge" curve x-axis source. */
export function emitterLoopAgeT(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
): number {
  return clampNumber(state.age / Math.max(0.001, emitter.duration), 0, 1);
}

/** Analytic position + velocity of a particle at a given age. */
export interface ParticleMotionResult {
  position: Vec3;
  velocity: Vec3;
  scratchA?: Vec3;
  scratchB?: Vec3;
}

/**
 * Unified, deterministic motion evaluator: the single source of truth for a
 * particle's analytic position AND velocity at a given age. It layers gravity /
 * drag (gated by `modules.velocity`) and Velocity over Lifetime (linear /
 * orbital / radial, gated by `modules.velocityOverLifetime`) on top of the
 * particle's spawn state.
 *
 * `currentEmitterPosition` is the emitter's CURRENT world position (the runner
 * threads in `this.position`). It is only consulted for local-space orbital /
 * radial centers so a moving emitter carries the orbit center; world space uses
 * the per-particle spawn origin instead. When omitted, the spawn origin is used
 * for both (correct for world space and a stable fallback for local space).
 */
export function sampleParticleMotion(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  ageSeconds: number,
  normalizedAge: number,
  currentEmitterPosition?: Vec3,
  out: ParticleMotionResult = {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
  },
  initialVelocityMultiplier = 1,
): ParticleMotionResult {
  const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
  const loopAgeT = emitterLoopAgeT(emitter, state);
  const seed = state.instanceData[offset + 8] ?? 0.5;

  // --- Base gravity / drag (gated by the velocity module) -----------------
  const dragValue = emitter.modules.velocity
    ? sampleParticleScalarValue(
        emitter.forces.dragValue,
        normalizedAge,
        seed,
        loopAgeT,
      )
    : 0;
  const gravityValue = emitter.modules.velocity
    ? sampleParticleScalarValue(
        emitter.forces.gravityValue,
        normalizedAge,
        seed,
        loopAgeT,
      )
    : 0;
  const drag = Math.max(0, 1 - Math.max(0, dragValue) * ageSeconds);
  const velocityMultiplier = normalizeRuntimeMultiplier(
    initialVelocityMultiplier,
  );
  const baseVx = (state.instanceData[offset + 4] ?? 0) * velocityMultiplier;
  const baseVy = (state.instanceData[offset + 5] ?? 0) * velocityMultiplier;
  const baseVz = (state.instanceData[offset + 6] ?? 0) * velocityMultiplier;
  const speedModifierValue =
    emitter.advanced.velocityOverLifetime.speedModifier;
  const speedModifier = emitter.modules.velocityOverLifetime
    ? sampleParticleScalarValue(
        speedModifierValue,
        normalizedAge,
        seed,
        loopAgeT,
      )
    : 1;
  const integratedSpeedModifier = emitter.modules.velocityOverLifetime
    ? sampleParticleScalarValueIntegralAverage(
        speedModifierValue,
        normalizedAge,
        seed,
        loopAgeT,
      )
    : 1;

  const velocity = out.velocity;
  velocity[0] = baseVx * speedModifier;
  velocity[1] = baseVy * speedModifier - gravityValue * ageSeconds * 2;
  velocity[2] = baseVz * speedModifier;
  const position = out.position;
  position[0] =
    (state.instanceData[offset + 0] ?? 0) +
    baseVx * ageSeconds * drag * integratedSpeedModifier;
  position[1] =
    (state.instanceData[offset + 1] ?? 0) +
    baseVy * ageSeconds * drag * integratedSpeedModifier -
    gravityValue * ageSeconds * ageSeconds;
  position[2] =
    (state.instanceData[offset + 2] ?? 0) +
    baseVz * ageSeconds * drag * integratedSpeedModifier;

  // --- Velocity over Lifetime (linear / orbital / radial) -----------------
  if (emitter.modules.velocityOverLifetime) {
    applyVelocityOverLifetime(
      emitter,
      state,
      particleIndex,
      ageSeconds,
      normalizedAge,
      loopAgeT,
      seed,
      speedModifier,
      integratedSpeedModifier,
      position,
      velocity,
      currentEmitterPosition,
      out.scratchA ?? [0, 0, 0],
      out.scratchB ?? [0, 0, 0],
    );
  }

  return out;
}

/**
 * Mutates `position` and `velocity` in place with the Velocity over Lifetime
 * contribution. Velocity deltas use the instantaneous speed modifier; analytic
 * displacement uses its integrated average so particles keep already-traveled
 * distance when the modifier changes. Order: linear, then orbital, then radial.
 */
function applyVelocityOverLifetime(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  ageSeconds: number,
  normalizedAge: number,
  loopAgeT: number,
  seed: number,
  speedModifier: number,
  integratedSpeedModifier: number,
  position: Vec3,
  velocity: Vec3,
  currentEmitterPosition?: Vec3,
  scratchA: Vec3 = [0, 0, 0],
  scratchB: Vec3 = [0, 0, 0],
): void {
  const vol = emitter.advanced.velocityOverLifetime;
  const local = vol.space === "local";
  // 1) LINEAR. World axes in world space; spawn-rotated axes in local space.
  const linRaw = scratchA;
  linRaw[0] = sampleParticleScalarValue(
    vol.linear.x,
    normalizedAge,
    seed,
    loopAgeT,
  );
  linRaw[1] = sampleParticleScalarValue(
    vol.linear.y,
    normalizedAge,
    seed,
    loopAgeT,
  );
  linRaw[2] = sampleParticleScalarValue(
    vol.linear.z,
    normalizedAge,
    seed,
    loopAgeT,
  );
  const lin = scratchB;
  if (local) {
    rotateEulerDegreesInto(
      linRaw[0],
      linRaw[1],
      linRaw[2],
      emitter.spawn.rotation,
      lin,
    );
  } else {
    lin[0] = linRaw[0];
    lin[1] = linRaw[1];
    lin[2] = linRaw[2];
  }
  velocity[0] += lin[0] * speedModifier;
  velocity[1] += lin[1] * speedModifier;
  velocity[2] += lin[2] * speedModifier;
  position[0] += lin[0] * ageSeconds * integratedSpeedModifier;
  position[1] += lin[1] * ageSeconds * integratedSpeedModifier;
  position[2] += lin[2] * ageSeconds * integratedSpeedModifier;

  // 2) CENTER for orbital / radial. World space anchors on the per-particle
  // spawn origin; local space follows the current emitter position.
  const runtimeOffset = particleIndex * PARTICLE_RUNTIME_VECTOR_STRIDE;
  const originX = local
    ? (currentEmitterPosition?.[0] ??
      state.spawnOriginData[runtimeOffset + 0] ??
      0)
    : (state.spawnOriginData[runtimeOffset + 0] ?? 0);
  const originY = local
    ? (currentEmitterPosition?.[1] ??
      state.spawnOriginData[runtimeOffset + 1] ??
      0)
    : (state.spawnOriginData[runtimeOffset + 1] ?? 0);
  const originZ = local
    ? (currentEmitterPosition?.[2] ??
      state.spawnOriginData[runtimeOffset + 2] ??
      0)
    : (state.spawnOriginData[runtimeOffset + 2] ?? 0);
  const offRaw = scratchA;
  offRaw[0] = sampleParticleScalarValue(
    vol.orbitalOffset.x,
    normalizedAge,
    seed,
    loopAgeT,
  );
  offRaw[1] = sampleParticleScalarValue(
    vol.orbitalOffset.y,
    normalizedAge,
    seed,
    loopAgeT,
  );
  offRaw[2] = sampleParticleScalarValue(
    vol.orbitalOffset.z,
    normalizedAge,
    seed,
    loopAgeT,
  );
  const off = scratchB;
  if (local) {
    rotateEulerDegreesInto(
      offRaw[0],
      offRaw[1],
      offRaw[2],
      emitter.spawn.rotation,
      off,
    );
  } else {
    off[0] = offRaw[0];
    off[1] = offRaw[1];
    off[2] = offRaw[2];
  }
  const centerX = originX + off[0];
  const centerY = originY + off[1];
  const centerZ = originZ + off[2];

  // 3) ORBITAL. Rotate the running relative position around X, then Y, then Z
  // by the sampled angular velocities (radians/sec) * age. Add tangential
  // velocity cross(w, rel).
  const wx = sampleParticleScalarValue(
    vol.orbital.x,
    normalizedAge,
    seed,
    loopAgeT,
  );
  const wy = sampleParticleScalarValue(
    vol.orbital.y,
    normalizedAge,
    seed,
    loopAgeT,
  );
  const wz = sampleParticleScalarValue(
    vol.orbital.z,
    normalizedAge,
    seed,
    loopAgeT,
  );
  if (wx !== 0 || wy !== 0 || wz !== 0) {
    let relX = position[0] - centerX;
    let relY = position[1] - centerY;
    let relZ = position[2] - centerZ;
    // Tangential velocity (cross product w x rel) at the current position.
    const tangX = wy * relZ - wz * relY;
    const tangY = wz * relX - wx * relZ;
    const tangZ = wx * relY - wy * relX;
    // Rotate rel about X.
    const ax = wx * ageSeconds * integratedSpeedModifier;
    const cosAx = Math.cos(ax);
    const sinAx = Math.sin(ax);
    let ry = relY * cosAx - relZ * sinAx;
    const rz = relY * sinAx + relZ * cosAx;
    relY = ry;
    relZ = rz;
    // Rotate about Y.
    const ay = wy * ageSeconds * integratedSpeedModifier;
    const cosAy = Math.cos(ay);
    const sinAy = Math.sin(ay);
    const rx2 = relX * cosAy + relZ * sinAy;
    const rz2 = -relX * sinAy + relZ * cosAy;
    relX = rx2;
    relZ = rz2;
    // Rotate about Z.
    const az = wz * ageSeconds * integratedSpeedModifier;
    const cosAz = Math.cos(az);
    const sinAz = Math.sin(az);
    const rx3 = relX * cosAz - relY * sinAz;
    ry = relX * sinAz + relY * cosAz;
    relX = rx3;
    relY = ry;
    position[0] = centerX + relX;
    position[1] = centerY + relY;
    position[2] = centerZ + relZ;
    velocity[0] += tangX * speedModifier;
    velocity[1] += tangY * speedModifier;
    velocity[2] += tangZ * speedModifier;
  }

  // 4) RADIAL. Push along the normalized (running position - center) direction.
  const radial = sampleParticleScalarValue(
    vol.radial,
    normalizedAge,
    seed,
    loopAgeT,
  );
  if (radial !== 0) {
    const dirX = position[0] - centerX;
    const dirY = position[1] - centerY;
    const dirZ = position[2] - centerZ;
    const length = Math.hypot(dirX, dirY, dirZ);
    if (length > 0.000001) {
      const inv = 1 / length;
      const nx = dirX * inv;
      const ny = dirY * inv;
      const nz = dirZ * inv;
      position[0] += nx * radial * ageSeconds * integratedSpeedModifier;
      position[1] += ny * radial * ageSeconds * integratedSpeedModifier;
      position[2] += nz * radial * ageSeconds * integratedSpeedModifier;
      velocity[0] += nx * radial * speedModifier;
      velocity[1] += ny * radial * speedModifier;
      velocity[2] += nz * radial * speedModifier;
    }
  }
}

function sampleParticleKinematicPosition(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  ageSeconds: number,
  normalizedAge: number,
  currentEmitterPosition?: Vec3,
): Vec3 {
  return sampleParticleMotion(
    emitter,
    state,
    particleIndex,
    ageSeconds,
    normalizedAge,
    currentEmitterPosition,
  ).position;
}

function sampleParticleKinematicVelocity(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  ageSeconds: number,
  normalizedAge: number,
  currentEmitterPosition?: Vec3,
): Vec3 {
  return sampleParticleMotion(
    emitter,
    state,
    particleIndex,
    ageSeconds,
    normalizedAge,
    currentEmitterPosition,
  ).velocity;
}

function sampleParticleInheritedColor(
  emitter: ParticleEmitterDefinition,
  normalizedAge: number,
): Vec4 {
  return emitter.modules.color
    ? [
        ...sampleParticleGradientColor(emitter.color.gradient, normalizedAge),
        sampleParticleGradientAlpha(emitter.color.gradient, normalizedAge),
      ]
    : [1, 1, 1, 1];
}

function sampleParticleInheritedSize(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  normalizedAge: number,
): number {
  const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
  const initSize = Math.max(0, state.instanceData[offset + 11] ?? 1);
  if (!emitter.modules.size) return initSize;
  const sizeValue =
    emitter.mode === "billboard"
      ? emitter.billboard.sizeValue
      : emitter.mesh.sizeValue;
  return (
    initSize *
    Math.max(0, sampleParticleScalarValue(sizeValue, normalizedAge, 0.5))
  );
}

function deterministicSubEmitterProbability(
  event: ParticleEffectEvent,
  effectFile: string,
): number {
  const seed =
    Math.floor(event.particleSeed * 0xffffffff) ^
    hashString(
      `${event.kind}:${effectFile}:${event.effectId}:${event.emitterId}:${event.particleIndex}`,
    );
  return ((Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0) / 0x100000000;
}

function randomBetween(rng: ParticleRng, min: number, max: number): number {
  return min + (max - min) * rng.next();
}

function limitVelocityAxis(
  value: number,
  maxAbsValue: number,
  dampen: number,
): number {
  const limit = Math.max(0, maxAbsValue);
  const magnitude = Math.abs(value);
  if (magnitude <= limit) return value;
  const target = limit + (magnitude - limit) * (1 - dampen);
  return Math.sign(value) * target;
}

function isBurstTimeDue(
  eventTime: number,
  previousEffectAge: number,
  effectAge: number,
  state: ParticleEmitterRuntimeState,
): boolean {
  if (!Number.isFinite(eventTime)) return false;
  const startsAtWindow = !state.hasPreviousEffectAge && eventTime === 0;
  if (startsAtWindow) return effectAge >= 0;
  return (
    eventTime > previousEffectAge + PARTICLE_TIME_EPSILON &&
    eventTime <= effectAge + PARTICLE_TIME_EPSILON
  );
}

function translateLocalSpaceParticles(
  state: ParticleEmitterRuntimeState,
  deltaX: number,
  deltaY: number,
  deltaZ: number,
): void {
  if (
    state.activeCount <= 0 ||
    (Math.abs(deltaX) <= 0.000001 &&
      Math.abs(deltaY) <= 0.000001 &&
      Math.abs(deltaZ) <= 0.000001)
  ) {
    return;
  }
  for (let i = 0; i < state.activeCount; i++) {
    if ((state.runtimeFlagsData[i] ?? 0) & PARTICLE_RUNTIME_FLAG_LOCAL_SPACE) {
      const slot = i * PARTICLE_INSTANCE_STRIDE;
      state.instanceData[slot + 0] += deltaX;
      state.instanceData[slot + 1] += deltaY;
      state.instanceData[slot + 2] += deltaZ;
    }
  }
}

function writeParticleDirection(
  out: Float32Array,
  offset: number,
  velocityX: number,
  velocityY: number,
  velocityZ: number,
  fallback: Vec3,
): void {
  let directionX = velocityX;
  let directionY = velocityY;
  let directionZ = velocityZ;
  const velocityLength = Math.hypot(directionX, directionY, directionZ);
  if (velocityLength <= 0.000001) {
    directionX = fallback[0];
    directionY = fallback[1];
    directionZ = fallback[2];
  }
  const directionLength = Math.hypot(directionX, directionY, directionZ);
  if (directionLength <= 0.000001) {
    out[offset + 0] = 0;
    out[offset + 1] = 1;
    out[offset + 2] = 0;
    return;
  }
  const inverseLength = 1 / directionLength;
  out[offset + 0] = directionX * inverseLength;
  out[offset + 1] = directionY * inverseLength;
  out[offset + 2] = directionZ * inverseLength;
}

/**
 * Plain-array geometry a host binds as an emission source for the "mesh"
 * spawn shape. Backend-neutral on purpose: the engine never touches three.js.
 * Non-indexed geometry treats consecutive position triples as triangles.
 */
export interface ParticleEmissionGeometryInput {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number> | null;
  normals?: ArrayLike<number> | null;
}

/**
 * Compiled sampling table for mesh emission: an area-weighted triangle CDF so
 * surface sampling is uniform per unit area regardless of tessellation, plus
 * precomputed face normals when vertex normals are not provided. Built once
 * per bind (ParticleEffectRunner.setEmissionGeometry), sampled per particle.
 */
export interface CompiledParticleEmissionGeometry {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array | null;
  faceNormals: Float32Array | null;
  triangleCdf: Float32Array;
  totalArea: number;
  vertexCount: number;
  triangleCount: number;
}

export function compileParticleEmissionGeometry(
  input: ParticleEmissionGeometryInput,
): CompiledParticleEmissionGeometry | null {
  const rawPositions = input.positions;
  const vertexCount = Math.floor(rawPositions.length / 3);
  if (vertexCount < 1) return null;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = rawPositions[i];

  let normals: Float32Array | null = null;
  if (input.normals && input.normals.length >= vertexCount * 3) {
    normals = new Float32Array(vertexCount * 3);
    for (let i = 0; i < normals.length; i++) normals[i] = input.normals[i];
  }

  let indices: Uint32Array | null = null;
  if (input.indices && input.indices.length >= 3) {
    const triangleVertexCount =
      input.indices.length - (input.indices.length % 3);
    indices = new Uint32Array(triangleVertexCount);
    for (let i = 0; i < triangleVertexCount; i++) {
      const index = Math.floor(input.indices[i]);
      if (index < 0 || index >= vertexCount) return null;
      indices[i] = index;
    }
  } else if (vertexCount >= 3) {
    const triangleVertexCount = vertexCount - (vertexCount % 3);
    indices = new Uint32Array(triangleVertexCount);
    for (let i = 0; i < triangleVertexCount; i++) indices[i] = i;
  }

  const triangleCount = indices ? indices.length / 3 : 0;
  const triangleCdf = new Float32Array(triangleCount);
  const faceNormals =
    triangleCount > 0 && !normals ? new Float32Array(triangleCount * 3) : null;
  let totalArea = 0;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const i0 = indices![triangle * 3 + 0] * 3;
    const i1 = indices![triangle * 3 + 1] * 3;
    const i2 = indices![triangle * 3 + 2] * 3;
    const edge1X = positions[i1 + 0] - positions[i0 + 0];
    const edge1Y = positions[i1 + 1] - positions[i0 + 1];
    const edge1Z = positions[i1 + 2] - positions[i0 + 2];
    const edge2X = positions[i2 + 0] - positions[i0 + 0];
    const edge2Y = positions[i2 + 1] - positions[i0 + 1];
    const edge2Z = positions[i2 + 2] - positions[i0 + 2];
    const crossX = edge1Y * edge2Z - edge1Z * edge2Y;
    const crossY = edge1Z * edge2X - edge1X * edge2Z;
    const crossZ = edge1X * edge2Y - edge1Y * edge2X;
    const crossLength = Math.hypot(crossX, crossY, crossZ);
    totalArea += crossLength * 0.5;
    triangleCdf[triangle] = totalArea;
    if (faceNormals) {
      const inverseLength = crossLength > 0.000001 ? 1 / crossLength : 0;
      faceNormals[triangle * 3 + 0] = crossX * inverseLength;
      faceNormals[triangle * 3 + 1] = crossY * inverseLength;
      faceNormals[triangle * 3 + 2] = crossZ * inverseLength;
    }
  }

  return {
    positions,
    normals,
    indices,
    faceNormals,
    triangleCdf,
    totalArea,
    vertexCount,
    triangleCount,
  };
}

/**
 * Writes a spawn position + direction sampled from the bound mesh into the
 * local/direction registers of sampleParticleSpawn. Surface mode: CDF-pick a
 * triangle by area, then a uniform barycentric point; direction is the
 * interpolated vertex normal (or the face normal). Vertices mode: uniform
 * vertex pick. Degenerate/absent triangles fall back to vertex sampling.
 */
function sampleMeshSpawnPoint(
  geometry: CompiledParticleEmissionGeometry,
  emitFrom: ParticleSpawnMeshEmitFrom,
  rng: ParticleRng,
  outPosition: Vec3,
  outDirection: Vec3,
): void {
  const useSurface =
    emitFrom === "surface" &&
    geometry.triangleCount > 0 &&
    geometry.totalArea > 0.000001;
  if (!useSurface) {
    const vertex = Math.min(
      geometry.vertexCount - 1,
      Math.floor(rng.next() * geometry.vertexCount),
    );
    outPosition[0] = geometry.positions[vertex * 3 + 0];
    outPosition[1] = geometry.positions[vertex * 3 + 1];
    outPosition[2] = geometry.positions[vertex * 3 + 2];
    if (geometry.normals) {
      outDirection[0] = geometry.normals[vertex * 3 + 0];
      outDirection[1] = geometry.normals[vertex * 3 + 1];
      outDirection[2] = geometry.normals[vertex * 3 + 2];
    }
    return;
  }

  const target = rng.next() * geometry.totalArea;
  let low = 0;
  let high = geometry.triangleCount - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (geometry.triangleCdf[middle] < target) low = middle + 1;
    else high = middle;
  }
  const triangle = low;
  const i0 = geometry.indices![triangle * 3 + 0] * 3;
  const i1 = geometry.indices![triangle * 3 + 1] * 3;
  const i2 = geometry.indices![triangle * 3 + 2] * 3;
  let u = rng.next();
  let v = rng.next();
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }
  const w = 1 - u - v;
  const positions = geometry.positions;
  outPosition[0] = positions[i0] * w + positions[i1] * u + positions[i2] * v;
  outPosition[1] =
    positions[i0 + 1] * w + positions[i1 + 1] * u + positions[i2 + 1] * v;
  outPosition[2] =
    positions[i0 + 2] * w + positions[i1 + 2] * u + positions[i2 + 2] * v;
  const normals = geometry.normals;
  if (normals) {
    outDirection[0] = normals[i0] * w + normals[i1] * u + normals[i2] * v;
    outDirection[1] =
      normals[i0 + 1] * w + normals[i1 + 1] * u + normals[i2 + 1] * v;
    outDirection[2] =
      normals[i0 + 2] * w + normals[i1 + 2] * u + normals[i2 + 2] * v;
  } else if (geometry.faceNormals) {
    outDirection[0] = geometry.faceNormals[triangle * 3 + 0];
    outDirection[1] = geometry.faceNormals[triangle * 3 + 1];
    outDirection[2] = geometry.faceNormals[triangle * 3 + 2];
  }
}

interface ParticleSpawnSample {
  position: Vec3;
  direction: Vec3;
}

function createParticleSpawnSample(): ParticleSpawnSample {
  return {
    position: [0, 0, 0],
    direction: [0, 1, 0],
  };
}

const meshSpawnPositionScratch: Vec3 = [0, 0, 0];
const meshSpawnDirectionScratch: Vec3 = [0, 1, 0];

function sampleParticleSpawn(
  spawn: ParticleSpawnSettings,
  rng: ParticleRng,
  emitterT: number,
  emitIndex: number,
  emitCount: number,
  out: ParticleSpawnSample,
  meshGeometry: CompiledParticleEmissionGeometry | null = null,
): void {
  const radius = Math.max(
    0,
    sampleParticleScalarValue(
      spawn.radiusValue,
      emitterT,
      scalarRandom(spawn.radiusValue, rng),
    ),
  );
  const arcAngle = sampleArcAngleRadians(
    spawn,
    rng,
    emitterT,
    emitIndex,
    emitCount,
  );
  const arcX = Math.cos(arcAngle);
  const arcZ = Math.sin(arcAngle);
  let localX = 0;
  let localY = 0;
  let localZ = 0;
  let directionX = 0;
  let directionY = 1;
  let directionZ = 0;

  if (spawn.shape === "circle") {
    const r = sampleRadiusWithThickness(radius, spawn.radiusThickness, rng);
    localX = arcX * r;
    localZ = arcZ * r;
  } else if (spawn.shape === "box") {
    localX = (rng.next() - 0.5) * spawn.box[0];
    localY = (rng.next() - 0.5) * spawn.box[1];
    localZ = (rng.next() - 0.5) * spawn.box[2];
  } else if (spawn.shape === "cone") {
    const length = Math.max(0, spawn.length);
    const volumeT = spawn.emitFrom === "volume" && length > 0 ? rng.next() : 0;
    localY = length * volumeT;
    const radiusAtY = radius * (1 - volumeT);
    const r = sampleRadiusWithThickness(radiusAtY, spawn.radiusThickness, rng);
    const edgeT = radiusAtY > 0.000001 ? r / radiusAtY : 0;
    const theta = degreesToRadians(spawn.angle) * edgeT;
    const sinTheta = Math.sin(theta);
    localX = arcX * r;
    localZ = arcZ * r;
    directionX = arcX * sinTheta;
    directionY = Math.cos(theta);
    directionZ = arcZ * sinTheta;
  } else if (spawn.shape === "mesh") {
    // No geometry bound (or an empty one) degrades to point emission so the
    // effect still plays while a host/preview is loading the mesh.
    if (meshGeometry && meshGeometry.vertexCount > 0) {
      meshSpawnPositionScratch[0] = 0;
      meshSpawnPositionScratch[1] = 0;
      meshSpawnPositionScratch[2] = 0;
      meshSpawnDirectionScratch[0] = 0;
      meshSpawnDirectionScratch[1] = 1;
      meshSpawnDirectionScratch[2] = 0;
      sampleMeshSpawnPoint(
        meshGeometry,
        spawn.meshEmitFrom,
        rng,
        meshSpawnPositionScratch,
        meshSpawnDirectionScratch,
      );
      localX = meshSpawnPositionScratch[0];
      localY = meshSpawnPositionScratch[1];
      localZ = meshSpawnPositionScratch[2];
      const directionLength = Math.hypot(
        meshSpawnDirectionScratch[0],
        meshSpawnDirectionScratch[1],
        meshSpawnDirectionScratch[2],
      );
      if (directionLength > 0.000001) {
        const inverseDirectionLength = 1 / directionLength;
        directionX = meshSpawnDirectionScratch[0] * inverseDirectionLength;
        directionY = meshSpawnDirectionScratch[1] * inverseDirectionLength;
        directionZ = meshSpawnDirectionScratch[2] * inverseDirectionLength;
      }
    }
  } else if (spawn.shape === "sphere" || spawn.shape === "hemisphere") {
    // Uniform point on the (hemi)sphere. The polar component uses cosTheta in
    // [-1, 1] for a full sphere; a hemisphere restricts it to the local +Y half
    // ([0, 1]). The azimuth reuses the arc sampling so Arc / Arc Mode still
    // shape the emission, and radiusThickness selects surface vs volume.
    const cosTheta =
      spawn.shape === "hemisphere" ? rng.next() : rng.next() * 2 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const normalizedDirectionX = arcX * sinTheta;
    const normalizedDirectionY = cosTheta;
    const normalizedDirectionZ = arcZ * sinTheta;
    const r = sampleRadiusWithThickness(radius, spawn.radiusThickness, rng);
    localX = normalizedDirectionX * r;
    localY = normalizedDirectionY * r;
    localZ = normalizedDirectionZ * r;
    // Direction defaults outward from the sampled position.
    directionX = normalizedDirectionX;
    directionY = normalizedDirectionY;
    directionZ = normalizedDirectionZ;
  }

  const sphericalAmount = clampNumber(spawn.sphericalDirectionAmount, 0, 1);
  if (sphericalAmount > 0) {
    let sphericalX = directionX;
    let sphericalY = directionY;
    let sphericalZ = directionZ;
    const positionLength = Math.hypot(localX, localY, localZ);
    if (positionLength > 0.000001) {
      const inversePositionLength = 1 / positionLength;
      sphericalX = localX * inversePositionLength;
      sphericalY = localY * inversePositionLength;
      sphericalZ = localZ * inversePositionLength;
    }
    const mixedX = directionX + (sphericalX - directionX) * sphericalAmount;
    const mixedY = directionY + (sphericalY - directionY) * sphericalAmount;
    const mixedZ = directionZ + (sphericalZ - directionZ) * sphericalAmount;
    const mixedLength = Math.hypot(mixedX, mixedY, mixedZ);
    if (mixedLength > 0.000001) {
      const inverseMixedLength = 1 / mixedLength;
      directionX = mixedX * inverseMixedLength;
      directionY = mixedY * inverseMixedLength;
      directionZ = mixedZ * inverseMixedLength;
    }
  }

  const randomDirectionAmount = clampNumber(spawn.randomDirectionAmount, 0, 1);
  if (randomDirectionAmount > 0) {
    const randomY = rng.next() * 2 - 1;
    const randomAngle = rng.next() * PARTICLE_TAU;
    const randomRadius = Math.sqrt(Math.max(0, 1 - randomY * randomY));
    const randomX = Math.cos(randomAngle) * randomRadius;
    const randomZ = Math.sin(randomAngle) * randomRadius;
    const mixedX = directionX + (randomX - directionX) * randomDirectionAmount;
    const mixedY = directionY + (randomY - directionY) * randomDirectionAmount;
    const mixedZ = directionZ + (randomZ - directionZ) * randomDirectionAmount;
    const mixedLength = Math.hypot(mixedX, mixedY, mixedZ);
    if (mixedLength > 0.000001) {
      const inverseMixedLength = 1 / mixedLength;
      directionX = mixedX * inverseMixedLength;
      directionY = mixedY * inverseMixedLength;
      directionZ = mixedZ * inverseMixedLength;
    }
  }

  const randomPositionAmount = Math.max(0, spawn.randomPositionAmount);
  if (randomPositionAmount > 0) {
    const randomY = rng.next() * 2 - 1;
    const randomAngle = rng.next() * PARTICLE_TAU;
    const randomRadius = Math.sqrt(Math.max(0, 1 - randomY * randomY));
    const distance = Math.cbrt(rng.next()) * randomPositionAmount;
    localX += Math.cos(randomAngle) * randomRadius * distance;
    localY += randomY * distance;
    localZ += Math.sin(randomAngle) * randomRadius * distance;
  }

  rotateEulerDegreesInto(
    localX * spawn.scale[0],
    localY * spawn.scale[1],
    localZ * spawn.scale[2],
    spawn.rotation,
    out.position,
  );
  out.position[0] += spawn.position[0];
  out.position[1] += spawn.position[1];
  out.position[2] += spawn.position[2];

  rotateEulerDegreesInto(
    directionX,
    directionY,
    directionZ,
    spawn.rotation,
    out.direction,
  );
  normalizeVec3InPlace(out.direction, 0, 1, 0);
}

function sampleArcAngleRadians(
  spawn: ParticleSpawnSettings,
  rng: ParticleRng,
  emitterT: number,
  emitIndex: number,
  emitCount: number,
): number {
  const arcDegrees = clampNumber(spawn.arc, 0, 360);
  const fullArc = arcDegrees >= 359.999;
  const arcSpeedDegrees =
    sampleParticleScalarValue(spawn.arcSpeedValue, emitterT, 0.5) * emitterT;
  const arcSpeedTurns =
    arcDegrees > 0.000001 ? arcSpeedDegrees / arcDegrees : 0;
  let t: number;
  if (spawn.arcMode === "loop") {
    t = positiveModulo(emitterT + arcSpeedTurns, 1);
  } else if (spawn.arcMode === "pingPong") {
    t = pingPong01(emitterT + arcSpeedTurns);
  } else if (spawn.arcMode === "burstSpread") {
    if (emitCount <= 1) {
      t = 0.5;
    } else {
      const denominator = fullArc ? emitCount : emitCount - 1;
      t = emitIndex / Math.max(1, denominator);
    }
  } else {
    t = rng.next();
  }
  const spread = clampNumber(spawn.arcSpread, 0, 1);
  if (spread > 0) {
    const steps = Math.max(1, Math.round(1 / spread));
    t = Math.round(t * steps) / steps;
  }
  const animatedOffset =
    spawn.arcMode === "random" || spawn.arcMode === "burstSpread"
      ? arcSpeedDegrees
      : 0;
  return degreesToRadians(
    positiveModulo(arcDegrees * clampNumber(t, 0, 1) + animatedOffset, 360),
  );
}

function sampleRadiusWithThickness(
  radius: number,
  radiusThickness: number,
  rng: ParticleRng,
): number {
  const outer = Math.max(0, radius);
  const thickness = clampNumber(radiusThickness, 0, 1);
  if (outer <= 0 || thickness <= 0) return outer;
  const inner = outer * (1 - thickness);
  return Math.sqrt(
    inner * inner + (outer * outer - inner * inner) * rng.next(),
  );
}

function scalarRandom(value: ParticleScalarValue, rng: ParticleRng): number {
  return value.mode === "random" || value.mode === "randomCurve"
    ? rng.next()
    : 0.5;
}

function rotateEulerDegreesInto(
  x: number,
  y: number,
  z: number,
  rotation: Vec3,
  out: Vec3,
): void {
  const xRadians = degreesToRadians(rotation[0]);
  const xCos = Math.cos(xRadians);
  const xSin = Math.sin(xRadians);
  const yAfterX = y * xCos - z * xSin;
  const zAfterX = y * xSin + z * xCos;

  const yRadians = degreesToRadians(rotation[1]);
  const yCos = Math.cos(yRadians);
  const ySin = Math.sin(yRadians);
  const xAfterY = x * yCos - zAfterX * ySin;
  const zAfterY = x * ySin + zAfterX * yCos;

  const zRadians = degreesToRadians(rotation[2]);
  const zCos = Math.cos(zRadians);
  const zSin = Math.sin(zRadians);
  out[0] = xAfterY * zCos - yAfterX * zSin;
  out[1] = xAfterY * zSin + yAfterX * zCos;
  out[2] = zAfterY;
}

function normalizeVec3InPlace(
  value: Vec3,
  fallbackX: number,
  fallbackY: number,
  fallbackZ: number,
): void {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= 0.000001) {
    value[0] = fallbackX;
    value[1] = fallbackY;
    value[2] = fallbackZ;
    return;
  }
  const inverseLength = 1 / length;
  value[0] *= inverseLength;
  value[1] *= inverseLength;
  value[2] *= inverseLength;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function pingPong01(value: number): number {
  const phase = positiveModulo(value * 2, 2);
  return phase <= 1 ? phase : 2 - phase;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
