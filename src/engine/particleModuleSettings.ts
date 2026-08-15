import type { Vec2, Vec3, Vec4 } from "./math";
import type {
  ParticleColorGradientSettings,
  ParticleScalarValue,
} from "./particles";
import {
  clampNumber,
  createConstantScalar,
  createCurveScalar,
  createGradient,
  isRecord,
  normalizeRange,
  normalizeScalarWithFallbackMode,
  normalizeVec2,
  normalizeVec3,
  normalizeVec4,
  numberOr,
  safeString,
  type NormalizeScalarValue,
} from "./particleModuleSettingUtils";
export const PARTICLE_EMITTER_MODULE_KEYS = [
  "velocity",
  "velocityOverLifetime",
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
] as const;
export type ParticleEmitterModuleKey =
  (typeof PARTICLE_EMITTER_MODULE_KEYS)[number];
export type ParticleEmitterModuleSettings = Record<
  ParticleEmitterModuleKey,
  boolean
>;

/**
 * How faithfully each emitter module is represented by the runtime + export
 * contract. `full` modules have deterministic Pixi semantics matching their
 * authored intent. `partial` modules are approximations, or smaller in scope
 * than the full reference feature they are named after, and surface as
 * validation warnings plus export `support.status: "partial"`.
 *
 * This is the single source of truth for module partiality. Both the authoring
 * validator (`src/runtime/schema/validation.ts`) and the Pixi renderer support
 * reporter derive from it, so a module's support level is changed in exactly
 * one place when a feature is promoted from approximate to faithful.
 */
export type ParticleModuleSupportLevel = "full" | "partial";

export const PARTICLE_MODULE_SUPPORT: Record<
  ParticleEmitterModuleKey,
  ParticleModuleSupportLevel
> = {
  velocity: "full",
  velocityOverLifetime: "full",
  limitVelocityOverLifetime: "partial",
  inheritVelocity: "partial",
  color: "full",
  size: "full",
  rotation: "full",
  lifetimeByEmitterSpeed: "full",
  forceOverLifetime: "partial",
  colorBySpeed: "partial",
  sizeBySpeed: "partial",
  rotationBySpeed: "partial",
  externalForces: "partial",
  noise: "partial",
  collision: "partial",
  triggers: "partial",
  subEmitters: "partial",
  textureSheetAnimation: "partial",
  lights: "partial",
  trails: "partial",
  customData: "partial",
};

/** Modules whose runtime/export support is approximate (`partial`). */
export const PARTIAL_PARTICLE_MODULE_KEYS: readonly ParticleEmitterModuleKey[] =
  PARTICLE_EMITTER_MODULE_KEYS.filter(
    (key) => PARTICLE_MODULE_SUPPORT[key] === "partial",
  );
export interface ParticleValueRange {
  min: number;
  max: number;
}
export interface ParticleLifetimeByEmitterSpeedSettings {
  speedRange: ParticleValueRange;
  multiplier: ParticleScalarValue;
}
export interface ParticleForceOverLifetimeSettings {
  force: Vec3;
  randomized: Vec3;
  multiplier: ParticleScalarValue;
}
export type ParticleVelocitySpace = "local" | "world";
export type ParticleVelocityOverLifetimeSpace = "local" | "world";
export interface ParticleVec3ScalarSettings {
  x: ParticleScalarValue;
  y: ParticleScalarValue;
  z: ParticleScalarValue;
}
export interface ParticleVelocityOverLifetimeSettings {
  space: ParticleVelocityOverLifetimeSpace;
  linear: ParticleVec3ScalarSettings;
  orbital: ParticleVec3ScalarSettings;
  orbitalOffset: ParticleVec3ScalarSettings;
  radial: ParticleScalarValue;
  speedModifier: ParticleScalarValue;
}
export interface ParticleLimitVelocityOverLifetimeSettings {
  separateAxes: boolean;
  speed: ParticleScalarValue;
  x: ParticleScalarValue;
  y: ParticleScalarValue;
  z: ParticleScalarValue;
  dampen: number;
  drag: ParticleScalarValue;
  multiplyBySize: boolean;
  space: ParticleVelocitySpace;
}
export type ParticleInheritVelocityMode = "initial" | "current";
export interface ParticleInheritVelocitySettings {
  mode: ParticleInheritVelocityMode;
  multiplier: ParticleScalarValue;
}
export interface ParticleColorBySpeedSettings {
  speedRange: ParticleValueRange;
  gradient: ParticleColorGradientSettings;
  blend: number;
}
export interface ParticleSizeBySpeedSettings {
  speedRange: ParticleValueRange;
  multiplier: ParticleScalarValue;
  blend: number;
}
export interface ParticleRotationBySpeedSettings {
  speedRange: ParticleValueRange;
  angularVelocity: ParticleScalarValue;
  blend: number;
}
export interface ParticleExternalForcesSettings {
  wind: Vec3;
  gravityMultiplier: ParticleScalarValue;
  drag: ParticleScalarValue;
  vortexStrength: number;
}
/**
 * "sine": legacy per-axis sine displacement — cheap, per-particle independent
 * jitter. "curl": divergence-free 3-D curl-noise field — one coherent flow
 * shared by all particles, reads as real turbulence.
 */
export type ParticleNoiseMode = "sine" | "curl";
export interface ParticleNoiseSettings {
  mode: ParticleNoiseMode;
  strength: ParticleScalarValue;
  frequency: number;
  speed: number;
  scroll: Vec3;
  octaves: number;
  damping: number;
}
export type ParticleCollisionMode = "none" | "plane";
export interface ParticleCollisionSettings {
  mode: ParticleCollisionMode;
  planeY: number;
  radius: number;
  bounce: number;
  dampen: number;
  killBelow: number;
}
export interface ParticleTriggerSettings {
  birthEvent: string;
  deathEvent: string;
  normalizedTime: number;
  oneShot: boolean;
}
export interface ParticleSubEmitterSlotSettings {
  effectFile: string;
  probability: number;
  inheritColor: boolean;
  inheritSize: boolean;
}
export interface ParticleSubEmitterSettings {
  birth: ParticleSubEmitterSlotSettings;
  collision: ParticleSubEmitterSlotSettings;
  death: ParticleSubEmitterSlotSettings;
}
export interface ParticleTextureSheetAnimationSettings {
  tiles: Vec2;
  startFrame: number;
  endFrame: number; // I13-G: inclusive top of the loop range; 255 = "to last frame"
  frameOverTime: ParticleScalarValue;
  cycles: number;
  randomStartFrame: boolean;
}
export interface ParticleLightSettings {
  color: Vec3;
  intensity: ParticleScalarValue;
  radius: ParticleScalarValue;
  additive: boolean;
}
export type ParticleTrailTextureMode = "stretch" | "tile";
/**
 * Trail rendering strategy. Only `particleHistory` is implemented: pooled,
 * stretched "particle history" quads (an approximation, not a real ribbon
 * mesh). `ribbon` is reserved for forward-compat and a future real ribbon
 * renderer; if it appears it is rendered as `particleHistory`.
 */
export type ParticleTrailMode = "particleHistory" | "ribbon";
export interface ParticleTrailSettings {
  mode: ParticleTrailMode;
  ratio: number;
  lifetime: ParticleScalarValue;
  length: ParticleScalarValue;
  width: ParticleScalarValue;
  /** Width multiplier sampled by normalized trail position. */
  widthOverTrail: ParticleScalarValue;
  color: ParticleColorGradientSettings | null;
  inheritColor: boolean;
  textureMode: ParticleTrailTextureMode;
  texture: string | null;
  minVertexDistance: number;
  worldSpace: boolean;
}
export interface ParticleCustomDataSettings {
  label: string;
  channels: [
    ParticleScalarValue,
    ParticleScalarValue,
    ParticleScalarValue,
    ParticleScalarValue,
  ];
}
export interface ParticleAdvancedModuleSettings {
  velocityOverLifetime: ParticleVelocityOverLifetimeSettings;
  limitVelocityOverLifetime: ParticleLimitVelocityOverLifetimeSettings;
  inheritVelocity: ParticleInheritVelocitySettings;
  lifetimeByEmitterSpeed: ParticleLifetimeByEmitterSpeedSettings;
  forceOverLifetime: ParticleForceOverLifetimeSettings;
  colorBySpeed: ParticleColorBySpeedSettings;
  sizeBySpeed: ParticleSizeBySpeedSettings;
  rotationBySpeed: ParticleRotationBySpeedSettings;
  externalForces: ParticleExternalForcesSettings;
  noise: ParticleNoiseSettings;
  collision: ParticleCollisionSettings;
  triggers: ParticleTriggerSettings;
  subEmitters: ParticleSubEmitterSettings;
  textureSheetAnimation: ParticleTextureSheetAnimationSettings;
  lights: ParticleLightSettings;
  trails: ParticleTrailSettings;
  customData: ParticleCustomDataSettings;
}
type NormalizeGradientValue = (
  value: unknown,
  start: Vec4,
  end: Vec4,
) => ParticleColorGradientSettings;
const CORE_ENABLED_MODULES = new Set<ParticleEmitterModuleKey>([
  "velocity",
  "color",
  "size",
  "rotation",
]);
export function createDefaultParticleModuleSettings(): ParticleEmitterModuleSettings {
  return createParticleModuleSettings((key) => CORE_ENABLED_MODULES.has(key));
}
export function createBareParticleModuleSettings(): ParticleEmitterModuleSettings {
  return createParticleModuleSettings(() => false);
}
export function normalizeEmitterModules(
  value: unknown,
  fallback: ParticleEmitterModuleSettings,
): ParticleEmitterModuleSettings {
  const source = isRecord(value) ? value : {};
  return createParticleModuleSettings((key) =>
    typeof source[key] === "boolean" ? source[key] : fallback[key],
  );
}
export function createDefaultParticleAdvancedModules(): ParticleAdvancedModuleSettings {
  return {
    velocityOverLifetime: {
      space: "local",
      linear: {
        x: createConstantScalar(0, -32, 32),
        y: createConstantScalar(0, -32, 32),
        z: createConstantScalar(0, -32, 32),
      },
      orbital: {
        x: createConstantScalar(0, -32, 32),
        y: createConstantScalar(0, -32, 32),
        z: createConstantScalar(0, -32, 32),
      },
      orbitalOffset: {
        x: createConstantScalar(0, -32, 32),
        y: createConstantScalar(0, -32, 32),
        z: createConstantScalar(0, -32, 32),
      },
      radial: createConstantScalar(0, -32, 32),
      speedModifier: createConstantScalar(1, 0, 4),
    },
    limitVelocityOverLifetime: {
      separateAxes: false,
      speed: createCurveScalar(16, 16, 0, 120),
      x: createCurveScalar(16, 16, 0, 120),
      y: createCurveScalar(16, 16, 0, 120),
      z: createCurveScalar(16, 16, 0, 120),
      dampen: 0.5,
      drag: createConstantScalar(0, 0, 12),
      multiplyBySize: false,
      space: "local",
    },
    inheritVelocity: {
      mode: "initial",
      multiplier: createCurveScalar(0, 0, -4, 4),
    },
    lifetimeByEmitterSpeed: {
      speedRange: { min: 0, max: 16 },
      multiplier: createCurveScalar(1, 1, 0, 3),
    },
    forceOverLifetime: {
      force: [0, 0, 0],
      randomized: [0, 0, 0],
      multiplier: createConstantScalar(1, -10, 10),
    },
    colorBySpeed: {
      speedRange: { min: 0, max: 16 },
      gradient: createGradient([1, 1, 1, 1], [1, 0.65, 0.2, 1]),
      blend: 0,
    },
    sizeBySpeed: {
      speedRange: { min: 0, max: 16 },
      multiplier: createCurveScalar(1, 1, 0, 4),
      blend: 1,
    },
    rotationBySpeed: {
      speedRange: { min: 0, max: 16 },
      angularVelocity: createCurveScalar(0, 0, -24, 24),
      blend: 1,
    },
    externalForces: {
      wind: [0, 0, 0],
      gravityMultiplier: createConstantScalar(1, -4, 4),
      drag: createConstantScalar(0, 0, 12),
      vortexStrength: 0,
    },
    noise: {
      mode: "sine",
      strength: createConstantScalar(0, 0, 8),
      frequency: 1.5,
      speed: 1,
      scroll: [1, 0, 0],
      octaves: 2,
      damping: 0.5,
    },
    collision: {
      mode: "none",
      planeY: 0,
      radius: 0,
      bounce: 0.35,
      dampen: 0.45,
      killBelow: 20,
    },
    triggers: {
      birthEvent: "",
      deathEvent: "",
      normalizedTime: 1,
      oneShot: true,
    },
    subEmitters: {
      birth: createSubEmitterSlot(),
      collision: createSubEmitterSlot(),
      death: createSubEmitterSlot(),
    },
    textureSheetAnimation: {
      tiles: [1, 1],
      startFrame: 0,
      endFrame: 255, // sentinel → sampler clamps to totalFrames-1 (whole sheet, any tiles)
      frameOverTime: createCurveScalar(0, 0, 0, 64),
      cycles: 1,
      randomStartFrame: false,
    },
    lights: {
      color: [1, 0.85, 0.55],
      intensity: createConstantScalar(0, 0, 5),
      radius: createConstantScalar(1, 0, 32),
      additive: true,
    },
    trails: {
      mode: "particleHistory",
      ratio: 1,
      lifetime: createConstantScalar(0.5, 0, 8),
      length: createConstantScalar(0, 0, 12),
      width: createConstantScalar(1, 0.01, 4),
      widthOverTrail: createConstantScalar(1, 0, 1),
      color: null,
      inheritColor: true,
      textureMode: "stretch",
      texture: null,
      minVertexDistance: 0.02,
      worldSpace: true,
    },
    customData: {
      label: "",
      channels: createCustomDataChannels(),
    },
  };
}
export function normalizeParticleAdvancedModules(
  value: unknown,
  normalizeScalar: NormalizeScalarValue,
  normalizeGradient: NormalizeGradientValue,
): ParticleAdvancedModuleSettings {
  const source = isRecord(value) ? value : {};
  const fallback = createDefaultParticleAdvancedModules();
  return {
    velocityOverLifetime: normalizeVelocityOverLifetime(
      source.velocityOverLifetime,
      fallback.velocityOverLifetime,
      normalizeScalar,
    ),
    limitVelocityOverLifetime: normalizeLimitVelocityOverLifetime(
      source.limitVelocityOverLifetime,
      fallback.limitVelocityOverLifetime,
      normalizeScalar,
    ),
    inheritVelocity: normalizeInheritVelocity(
      source.inheritVelocity,
      fallback.inheritVelocity,
      normalizeScalar,
    ),
    lifetimeByEmitterSpeed: normalizeLifetimeByEmitterSpeed(
      source.lifetimeByEmitterSpeed,
      fallback.lifetimeByEmitterSpeed,
      normalizeScalar,
    ),
    forceOverLifetime: normalizeForceOverLifetime(
      source.forceOverLifetime,
      fallback.forceOverLifetime,
      normalizeScalar,
    ),
    colorBySpeed: normalizeColorBySpeed(
      source.colorBySpeed,
      fallback.colorBySpeed,
      normalizeGradient,
    ),
    sizeBySpeed: normalizeSizeBySpeed(
      source.sizeBySpeed,
      fallback.sizeBySpeed,
      normalizeScalar,
    ),
    rotationBySpeed: normalizeRotationBySpeed(
      source.rotationBySpeed,
      fallback.rotationBySpeed,
      normalizeScalar,
    ),
    externalForces: normalizeExternalForces(
      source.externalForces,
      fallback.externalForces,
      normalizeScalar,
    ),
    noise: normalizeNoise(source.noise, fallback.noise, normalizeScalar),
    collision: normalizeCollision(source.collision, fallback.collision),
    triggers: normalizeTriggers(source.triggers, fallback.triggers),
    subEmitters: normalizeSubEmitters(source.subEmitters, fallback.subEmitters),
    textureSheetAnimation: normalizeTextureSheetAnimation(
      source.textureSheetAnimation,
      fallback.textureSheetAnimation,
      normalizeScalar,
    ),
    lights: normalizeLights(source.lights, fallback.lights, normalizeScalar),
    trails: normalizeTrails(
      source.trails,
      fallback.trails,
      normalizeScalar,
      normalizeGradient,
    ),
    customData: normalizeCustomData(
      source.customData,
      fallback.customData,
      normalizeScalar,
    ),
  };
}
export function particleSpeedRangeRatio(
  range: ParticleValueRange,
  speed: number,
): number {
  return clampNumber(
    (speed - range.min) / Math.max(0.000001, range.max - range.min),
    0,
    1,
  );
}
function normalizeVec3Scalar(
  value: unknown,
  fallback: ParticleVec3ScalarSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleVec3ScalarSettings {
  const source = isRecord(value) ? value : {};
  return {
    x: normalizeScalarWithFallbackMode(source.x, fallback.x, normalizeScalar),
    y: normalizeScalarWithFallbackMode(source.y, fallback.y, normalizeScalar),
    z: normalizeScalarWithFallbackMode(source.z, fallback.z, normalizeScalar),
  };
}
function normalizeVelocityOverLifetime(
  value: unknown,
  fallback: ParticleVelocityOverLifetimeSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleVelocityOverLifetimeSettings {
  const source = isRecord(value) ? value : {};
  return {
    space: source.space === "world" ? "world" : "local",
    linear: normalizeVec3Scalar(
      source.linear,
      fallback.linear,
      normalizeScalar,
    ),
    orbital: normalizeVec3Scalar(
      source.orbital,
      fallback.orbital,
      normalizeScalar,
    ),
    orbitalOffset: normalizeVec3Scalar(
      source.orbitalOffset,
      fallback.orbitalOffset,
      normalizeScalar,
    ),
    radial: normalizeScalarWithFallbackMode(
      source.radial,
      fallback.radial,
      normalizeScalar,
    ),
    speedModifier: normalizeScalarWithFallbackMode(
      source.speedModifier,
      fallback.speedModifier,
      normalizeScalar,
    ),
  };
}
function normalizeLimitVelocityOverLifetime(
  value: unknown,
  fallback: ParticleLimitVelocityOverLifetimeSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleLimitVelocityOverLifetimeSettings {
  const source = isRecord(value) ? value : {};
  return {
    separateAxes:
      typeof source.separateAxes === "boolean"
        ? source.separateAxes
        : fallback.separateAxes,
    speed: normalizeScalarWithFallbackMode(
      source.speed,
      fallback.speed,
      normalizeScalar,
    ),
    x: normalizeScalarWithFallbackMode(source.x, fallback.x, normalizeScalar),
    y: normalizeScalarWithFallbackMode(source.y, fallback.y, normalizeScalar),
    z: normalizeScalarWithFallbackMode(source.z, fallback.z, normalizeScalar),
    dampen: clampNumber(numberOr(source.dampen, fallback.dampen), 0, 1),
    drag: normalizeScalar(source.drag, 0, 0, 12),
    multiplyBySize:
      typeof source.multiplyBySize === "boolean"
        ? source.multiplyBySize
        : fallback.multiplyBySize,
    space: source.space === "world" ? "world" : "local",
  };
}
function normalizeInheritVelocity(
  value: unknown,
  fallback: ParticleInheritVelocitySettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleInheritVelocitySettings {
  const source = isRecord(value) ? value : {};
  return {
    mode: source.mode === "current" ? "current" : "initial",
    multiplier: normalizeScalarWithFallbackMode(
      source.multiplier,
      fallback.multiplier,
      normalizeScalar,
    ),
  };
}
function normalizeLifetimeByEmitterSpeed(
  value: unknown,
  fallback: ParticleLifetimeByEmitterSpeedSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleLifetimeByEmitterSpeedSettings {
  const source = isRecord(value) ? value : {};
  return {
    speedRange: normalizeRange(source.speedRange, fallback.speedRange, 0, 80),
    multiplier: normalizeScalarWithFallbackMode(
      source.multiplier,
      fallback.multiplier,
      normalizeScalar,
    ),
  };
}
function normalizeForceOverLifetime(
  value: unknown,
  fallback: ParticleForceOverLifetimeSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleForceOverLifetimeSettings {
  const source = isRecord(value) ? value : {};
  return {
    force: normalizeVec3(source.force, fallback.force, -160, 160),
    randomized: normalizeVec3(source.randomized, fallback.randomized, 0, 160),
    multiplier: normalizeScalar(source.multiplier, 1, -10, 10),
  };
}
function normalizeColorBySpeed(
  value: unknown,
  fallback: ParticleColorBySpeedSettings,
  normalizeGradient: NormalizeGradientValue,
): ParticleColorBySpeedSettings {
  const source = isRecord(value) ? value : {};
  return {
    speedRange: normalizeRange(source.speedRange, fallback.speedRange, 0, 80),
    gradient: normalizeGradient(
      source.gradient,
      [1, 1, 1, 1],
      [1, 0.65, 0.2, 1],
    ),
    blend: clampNumber(numberOr(source.blend, fallback.blend), 0, 1),
  };
}
function normalizeSizeBySpeed(
  value: unknown,
  fallback: ParticleSizeBySpeedSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleSizeBySpeedSettings {
  const source = isRecord(value) ? value : {};
  return {
    speedRange: normalizeRange(source.speedRange, fallback.speedRange, 0, 80),
    multiplier: normalizeScalarWithFallbackMode(
      source.multiplier,
      fallback.multiplier,
      normalizeScalar,
    ),
    blend: clampNumber(numberOr(source.blend, fallback.blend), 0, 1),
  };
}
function normalizeRotationBySpeed(
  value: unknown,
  fallback: ParticleRotationBySpeedSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleRotationBySpeedSettings {
  const source = isRecord(value) ? value : {};
  return {
    speedRange: normalizeRange(source.speedRange, fallback.speedRange, 0, 80),
    angularVelocity: normalizeScalarWithFallbackMode(
      source.angularVelocity,
      fallback.angularVelocity,
      normalizeScalar,
    ),
    blend: clampNumber(numberOr(source.blend, fallback.blend), 0, 1),
  };
}
function normalizeExternalForces(
  value: unknown,
  fallback: ParticleExternalForcesSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleExternalForcesSettings {
  const source = isRecord(value) ? value : {};
  return {
    wind: normalizeVec3(source.wind, fallback.wind, -160, 160),
    gravityMultiplier: normalizeScalar(source.gravityMultiplier, 1, -4, 4),
    drag: normalizeScalar(source.drag, 0, 0, 12),
    vortexStrength: clampNumber(
      numberOr(source.vortexStrength, fallback.vortexStrength),
      -80,
      80,
    ),
  };
}
function normalizeNoise(
  value: unknown,
  fallback: ParticleNoiseSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleNoiseSettings {
  const source = isRecord(value) ? value : {};
  return {
    mode: source.mode === "curl" ? "curl" : "sine",
    strength: normalizeScalar(source.strength, 0, 0, 8),
    frequency: clampNumber(
      numberOr(source.frequency, fallback.frequency),
      0,
      32,
    ),
    speed: clampNumber(numberOr(source.speed, fallback.speed), -16, 16),
    scroll: normalizeVec3(source.scroll, fallback.scroll, -16, 16),
    octaves: Math.round(
      clampNumber(numberOr(source.octaves, fallback.octaves), 1, 6),
    ),
    damping: clampNumber(numberOr(source.damping, fallback.damping), 0, 1),
  };
}
function normalizeCollision(
  value: unknown,
  fallback: ParticleCollisionSettings,
): ParticleCollisionSettings {
  const source = isRecord(value) ? value : {};
  return {
    mode: source.mode === "plane" ? "plane" : "none",
    planeY: clampNumber(numberOr(source.planeY, fallback.planeY), -100, 100),
    radius: clampNumber(numberOr(source.radius, fallback.radius), 0, 16),
    bounce: clampNumber(numberOr(source.bounce, fallback.bounce), 0, 1),
    dampen: clampNumber(numberOr(source.dampen, fallback.dampen), 0, 1),
    killBelow: clampNumber(
      numberOr(source.killBelow, fallback.killBelow),
      0,
      200,
    ),
  };
}
function normalizeTriggers(
  value: unknown,
  fallback: ParticleTriggerSettings,
): ParticleTriggerSettings {
  const source = isRecord(value) ? value : {};
  return {
    birthEvent: safeString(source.birthEvent, fallback.birthEvent),
    deathEvent: safeString(source.deathEvent, fallback.deathEvent),
    normalizedTime: clampNumber(
      numberOr(source.normalizedTime, fallback.normalizedTime),
      0,
      1,
    ),
    oneShot:
      typeof source.oneShot === "boolean" ? source.oneShot : fallback.oneShot,
  };
}
function normalizeSubEmitters(
  value: unknown,
  fallback: ParticleSubEmitterSettings,
): ParticleSubEmitterSettings {
  const source = isRecord(value) ? value : {};
  return {
    birth: normalizeSubEmitterSlot(source.birth, fallback.birth),
    collision: normalizeSubEmitterSlot(source.collision, fallback.collision),
    death: normalizeSubEmitterSlot(source.death, fallback.death),
  };
}
function normalizeSubEmitterSlot(
  value: unknown,
  fallback: ParticleSubEmitterSlotSettings,
): ParticleSubEmitterSlotSettings {
  const source = isRecord(value) ? value : {};
  return {
    effectFile: safeString(source.effectFile, fallback.effectFile),
    probability: clampNumber(
      numberOr(source.probability, fallback.probability),
      0,
      1,
    ),
    inheritColor:
      typeof source.inheritColor === "boolean"
        ? source.inheritColor
        : fallback.inheritColor,
    inheritSize:
      typeof source.inheritSize === "boolean"
        ? source.inheritSize
        : fallback.inheritSize,
  };
}
function normalizeTextureSheetAnimation(
  value: unknown,
  fallback: ParticleTextureSheetAnimationSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleTextureSheetAnimationSettings {
  const source = isRecord(value) ? value : {};
  return {
    tiles: normalizeVec2(source.tiles, fallback.tiles, 1, 16, true),
    startFrame: Math.round(
      clampNumber(numberOr(source.startFrame, fallback.startFrame), 0, 255),
    ),
    endFrame: Math.round(
      clampNumber(numberOr(source.endFrame, fallback.endFrame), 0, 255),
    ),
    frameOverTime: normalizeScalarWithFallbackMode(
      source.frameOverTime,
      fallback.frameOverTime,
      normalizeScalar,
    ),
    cycles: clampNumber(numberOr(source.cycles, fallback.cycles), 0, 32),
    randomStartFrame:
      typeof source.randomStartFrame === "boolean"
        ? source.randomStartFrame
        : fallback.randomStartFrame,
  };
}
function normalizeLights(
  value: unknown,
  fallback: ParticleLightSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleLightSettings {
  const source = isRecord(value) ? value : {};
  return {
    color: normalizeVec3(source.color, fallback.color, 0, 1),
    intensity: normalizeScalar(source.intensity, 0, 0, 5),
    radius: normalizeScalar(source.radius, 1, 0, 32),
    additive:
      typeof source.additive === "boolean"
        ? source.additive
        : fallback.additive,
  };
}
function normalizeTrails(
  value: unknown,
  fallback: ParticleTrailSettings,
  normalizeScalar: NormalizeScalarValue,
  normalizeGradient: NormalizeGradientValue,
): ParticleTrailSettings {
  const source = isRecord(value) ? value : {};
  const color =
    source.color === null || source.color === undefined
      ? null
      : normalizeGradient(source.color, [1, 1, 1, 1], [1, 1, 1, 0]);
  return {
    mode: source.mode === "ribbon" ? "ribbon" : "particleHistory",
    ratio: clampNumber(numberOr(source.ratio, fallback.ratio), 0, 1),
    lifetime: normalizeScalar(source.lifetime, 0.5, 0, 8),
    length: normalizeScalar(source.length, 0, 0, 12),
    width: normalizeScalar(source.width, 1, 0.01, 4),
    widthOverTrail: normalizeScalar(source.widthOverTrail, 1, 0, 1),
    color,
    inheritColor:
      typeof source.inheritColor === "boolean"
        ? source.inheritColor
        : fallback.inheritColor,
    textureMode: source.textureMode === "tile" ? "tile" : "stretch",
    texture:
      typeof source.texture === "string" && source.texture.trim()
        ? source.texture.trim()
        : null,
    minVertexDistance: clampNumber(
      numberOr(source.minVertexDistance, fallback.minVertexDistance),
      0,
      1,
    ),
    worldSpace:
      typeof source.worldSpace === "boolean"
        ? source.worldSpace
        : fallback.worldSpace,
  };
}
function normalizeCustomData(
  value: unknown,
  fallback: ParticleCustomDataSettings,
  normalizeScalar: NormalizeScalarValue,
): ParticleCustomDataSettings {
  const source = isRecord(value) ? value : {};
  const sourceChannels = Array.isArray(source.channels)
    ? source.channels
    : null;
  const legacyVector1 = sourceChannels
    ? null
    : normalizeVec4(source.vector1, [0, 0, 0, 0], -100000, 100000);
  const fallbackChannels = fallback.channels ?? createCustomDataChannels();
  const channels = [0, 1, 2, 3].map((index) => {
    const fallbackChannel = sourceChannels
      ? fallbackChannels[index]!
      : createConstantScalar(legacyVector1?.[index] ?? 0, -1, 1);
    return normalizeScalarWithFallbackMode(
      sourceChannels?.[index],
      fallbackChannel,
      normalizeScalar,
    );
  }) as ParticleCustomDataSettings["channels"];
  return {
    label: safeString(source.label, fallback.label),
    channels,
  };
}

function createCustomDataChannels(): ParticleCustomDataSettings["channels"] {
  return [
    createConstantScalar(0, -1, 1),
    createConstantScalar(0, -1, 1),
    createConstantScalar(0, -1, 1),
    createConstantScalar(0, -1, 1),
  ];
}
function createParticleModuleSettings(
  enabled: (key: ParticleEmitterModuleKey) => boolean,
): ParticleEmitterModuleSettings {
  return PARTICLE_EMITTER_MODULE_KEYS.reduce((settings, key) => {
    settings[key] = enabled(key);
    return settings;
  }, {} as ParticleEmitterModuleSettings);
}
function createSubEmitterSlot(): ParticleSubEmitterSlotSettings {
  return {
    effectFile: "",
    probability: 1,
    inheritColor: true,
    inheritSize: true,
  };
}
