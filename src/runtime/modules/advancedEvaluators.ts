import type { Vec3, Vec4 } from "@/engine/math";
import {
  particleSpeedRangeRatio,
  type ParticleExternalForcesSettings,
  type ParticleForceOverLifetimeSettings,
  type ParticleLightSettings,
  type ParticleNoiseSettings,
  type ParticleTextureSheetAnimationSettings,
  type ParticleTrailSettings,
} from "@/engine/particleModuleSettings";
import {
  lerpVec4SrgbRgbInLinear,
  sampleParticleGradientAlpha,
  sampleParticleGradientColor,
  sampleParticleMotion,
  sampleParticleScalarValue,
  type ParticleEmitterDefinition,
  type ParticleEmitterRuntimeState,
  type ParticleMotionResult,
} from "@/engine/particles";
import { sampleCurlNoise3 } from "../materials/noise";

export interface ParticleModuleMotionInput {
  emitter: ParticleEmitterDefinition;
  seed: number;
  normalizedAge: number;
  /** Normalized loop age; when omitted curves fall back to the lifetime axis. */
  loopAge?: number;
  ageSeconds: number;
  timeSeconds: number;
  world: Vec3;
  velocity: Vec3;
}

export interface ParticleMotionSample {
  seed: number;
  normalizedAge: number;
  loopAge?: number;
  ageSeconds: number;
  timeSeconds: number;
  world: Vec3;
  velocity: Vec3;
}

export interface ParticleTrailSample {
  scaleX: number;
  scaleY: number;
  stretchesAlongMotion: boolean;
}

export interface ParticleTextureSheetFrameSample {
  frame: number;
  column: number;
  row: number;
  tilesX: number;
  tilesY: number;
  totalFrames: number;
}

export function applyParticleMotionModules({
  emitter,
  seed,
  normalizedAge,
  loopAge,
  ageSeconds,
  timeSeconds,
  world,
  velocity,
}: ParticleModuleMotionInput): boolean {
  return applyParticleMotionModulesToSample(emitter, {
    seed,
    normalizedAge,
    loopAge,
    ageSeconds,
    timeSeconds,
    world,
    velocity,
  });
}

/**
 * Positional displacement modules only (force → external → noise), in order.
 * Never culls. Collision is intentionally excluded so callers that need the
 * un-collided displaced position (I13-F effective-velocity finite difference)
 * can reuse exactly this. See docs/request-13/design/i13-h-design.md §Contract.
 */
export function applyPositionalMotionModules(
  emitter: ParticleEmitterDefinition,
  sample: ParticleMotionSample,
): void {
  if (emitter.modules.forceOverLifetime) {
    applyForceOverLifetime(emitter.advanced.forceOverLifetime, sample);
  }

  if (emitter.modules.externalForces) {
    applyExternalForces(emitter.advanced.externalForces, sample);
  }

  if (emitter.modules.noise) {
    applyNoiseDisplacement(emitter.advanced.noise, sample);
  }
}

export function applyParticleMotionModulesToSample(
  emitter: ParticleEmitterDefinition,
  sample: ParticleMotionSample,
): boolean {
  applyPositionalMotionModules(emitter, sample);

  if (emitter.modules.collision) {
    return applyCollisionResponse(emitter, sample);
  }

  return true;
}

export function applyForceOverLifetime(
  settings: ParticleForceOverLifetimeSettings,
  { seed, normalizedAge, loopAge, ageSeconds, world }: ParticleMotionSample,
): void {
  const multiplier = sampleParticleScalarValue(
    settings.multiplier,
    normalizedAge,
    seed,
    loopAge,
  );
  const randomX = seededSigned(seed, 11) * settings.randomized[0];
  const randomY = seededSigned(seed, 23) * settings.randomized[1];
  const randomZ = seededSigned(seed, 37) * settings.randomized[2];
  const factor = 0.5 * ageSeconds * ageSeconds * multiplier;
  world[0] += (settings.force[0] + randomX) * factor;
  world[1] += (settings.force[1] + randomY) * factor;
  world[2] += (settings.force[2] + randomZ) * factor;
}

export function applyExternalForces(
  settings: ParticleExternalForcesSettings,
  {
    seed,
    normalizedAge,
    loopAge,
    ageSeconds,
    world,
    velocity,
  }: ParticleMotionSample,
): void {
  const gravityMultiplier = sampleParticleScalarValue(
    settings.gravityMultiplier,
    normalizedAge,
    seed,
    loopAge,
  );
  const drag = sampleParticleScalarValue(
    settings.drag,
    normalizedAge,
    seed,
    loopAge,
  );
  const forceFactor = 0.5 * ageSeconds * ageSeconds;
  world[0] += settings.wind[0] * forceFactor;
  world[1] +=
    settings.wind[1] * forceFactor -
    velocity[1] * Math.max(0, gravityMultiplier - 1) * forceFactor;
  world[2] += settings.wind[2] * forceFactor;
  if (drag > 0) {
    const dragFactor = Math.max(0, 1 - drag * ageSeconds * 0.15);
    world[0] *= dragFactor;
    world[2] *= dragFactor;
  }
  if (Math.abs(settings.vortexStrength) > 0.0001) {
    const swirl = settings.vortexStrength * ageSeconds * 0.03;
    const x = world[0];
    const z = world[2];
    world[0] += -z * swirl;
    world[2] += x * swirl;
  }
}

// Particles are born exactly on their Shape; noise ramps in over the first
// fraction of the particle's own life so it doesn't displace them at spawn.
const NOISE_SPAWN_RAMP_FRACTION = 0.1;

const COLLISION_EPS = 1e-6;
const COLLISION_MAX_BOUNCES = 64;

// Finite-difference step for the velocity-alignment effective velocity (I13-F).
// ~half a 60fps frame; direction-only, so magnitude scale is moot.
const EFFECTIVE_VELOCITY_DT_SECONDS = 1 / 120;

const effVelMotionPlus: ParticleMotionResult = {
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  scratchA: [0, 0, 0],
  scratchB: [0, 0, 0],
};
const effVelSamplePlus: ParticleMotionSample = {
  seed: 0,
  normalizedAge: 0,
  loopAge: 0,
  ageSeconds: 0,
  timeSeconds: 0,
  world: effVelMotionPlus.position,
  velocity: effVelMotionPlus.velocity,
};

const curlScratch: [number, number, number] = [0, 0, 0];

export function applyNoiseDisplacement(
  settings: ParticleNoiseSettings,
  { seed, normalizedAge, loopAge, timeSeconds, world }: ParticleMotionSample,
): void {
  const strength = sampleParticleScalarValue(
    settings.strength,
    normalizedAge,
    seed,
    loopAge,
  );
  if (strength <= 0) return;

  const frequency = Math.max(0.0001, settings.frequency);
  let amplitude = strength;
  let totalX = 0;
  let totalY = 0;
  let totalZ = 0;
  if (settings.mode === "curl") {
    // One coherent divergence-free field shared by every particle: the domain
    // is world position only (no per-particle seed offset), scrolled over time
    // like sine mode. `speed` alone also evolves the field so the flow stays
    // alive even with zero scroll.
    const phase = timeSeconds * settings.speed;
    for (let octave = 0; octave < settings.octaves; octave++) {
      const f = frequency * 2 ** octave;
      sampleCurlNoise3(
        (world[0] + settings.scroll[0] * phase) * f + phase * 0.35,
        (world[1] + settings.scroll[1] * phase) * f + phase * 0.61,
        (world[2] + settings.scroll[2] * phase) * f + phase * 0.83,
        octave * 101,
        curlScratch,
      );
      totalX += curlScratch[0] * amplitude;
      totalY += curlScratch[1] * amplitude;
      totalZ += curlScratch[2] * amplitude;
      amplitude *= settings.damping;
    }
  } else {
    const phase = timeSeconds * settings.speed + seed * 17.17;
    for (let octave = 0; octave < settings.octaves; octave++) {
      const f = frequency * 2 ** octave;
      totalX +=
        Math.sin(
          (world[0] + settings.scroll[0] * phase + seed) * f + octave * 5.31,
        ) * amplitude;
      totalY +=
        Math.sin(
          (world[1] + settings.scroll[1] * phase + seed) * f + octave * 7.13,
        ) * amplitude;
      totalZ +=
        Math.sin(
          (world[2] + settings.scroll[2] * phase + seed) * f + octave * 3.77,
        ) * amplitude;
      amplitude *= settings.damping;
    }
  }
  const t = Math.min(1, Math.max(0, normalizedAge / NOISE_SPAWN_RAMP_FRACTION));
  const ramp = t * t * (3 - 2 * t);
  world[0] += totalX * ramp;
  world[1] += totalY * ramp;
  world[2] += totalZ * ramp;
}

export function applyCollisionResponse(
  emitter: ParticleEmitterDefinition,
  sample: ParticleMotionSample,
): boolean {
  const settings = emitter.advanced.collision;
  if (settings.mode !== "plane") return true;

  const world = sample.world;
  const velocity = sample.velocity;
  const floor = settings.planeY + settings.radius;
  const rawY = world[1];

  // Cull against the RAW analytic trajectory (unchanged semantics, D5).
  if (rawY < floor - settings.killBelow) return false;
  // Above the plane: still in free-fall — leave position/velocity analytic.
  if (rawY >= floor) return true;

  // Gravity coefficient G of the parabola y = y0 + Vy·t − G·t² (accel = −2G),
  // gated on modules.velocity exactly like sampleParticleMotion.
  const gravityValue = emitter.modules.velocity
    ? sampleParticleScalarValue(
        emitter.forces.gravityValue,
        sample.normalizedAge,
        sample.seed,
        sample.loopAge,
      )
    : 0;
  const g = Math.max(0, gravityValue);

  const vyNow = velocity[1];
  const gap = floor - rawY; // > 0
  const disc = vyNow * vyNow - 4 * g * gap;

  const keep = 1 - settings.dampen;
  const vx = velocity[0];
  const vz = velocity[2];

  // Reflect only for a genuine downward crossing from above the plane. Settle if
  // the particle never crossed from above (disc <= 0: spawned below / grazing) or
  // is not moving downward now (vyNow >= 0 — e.g. a collision plane above the
  // emitter, or noise/VOL displacing an upward-moving particle below a floor).
  // When vyNow >= 0 the impact-time denominator sqrtDisc − vyNow is <= 0, which
  // would drive `elapsed` negative (g>0: shoves the particle further below the
  // floor) or to ±Infinity/NaN (g=0: divide-by-zero). Settling keeps output finite.
  if (disc <= 0 || vyNow >= 0) {
    world[1] = floor;
    velocity[0] = vx * keep;
    velocity[1] = 0;
    velocity[2] = vz * keep;
    return true;
  }

  const sqrtDisc = Math.sqrt(disc);
  // Time since the (first) impact, > 0 (vyNow < 0 ⇒ sqrtDisc − vyNow > 0);
  // rationalized so it cancels g (safe g=0).
  const elapsed = (2 * gap) / (sqrtDisc - vyNow);

  // Horizontal: dampen tangential VELOCITY; back-project to impact, relaunch.
  world[0] = world[0] - vx * settings.dampen * elapsed;
  world[2] = world[2] - vz * settings.dampen * elapsed;
  velocity[0] = vx * keep;
  velocity[2] = vz * keep;

  // Vertical: reflected sub-trajectory, re-folding on each floor return (D3).
  let vUp = settings.bounce * sqrtDisc; // = bounce·(−vImpact), ≥ 0
  let tau = elapsed;
  if (g > COLLISION_EPS && vUp > COLLISION_EPS) {
    for (let i = 0; i < COLLISION_MAX_BOUNCES; i++) {
      const tReturn = vUp / g; // time for this arc to fall back to the plane
      if (tau <= tReturn) break;
      tau -= tReturn;
      vUp *= settings.bounce; // energy loss per bounce
      if (vUp <= COLLISION_EPS) {
        vUp = 0;
        break;
      }
    }
  }
  // The arc formula floor + vUp·τ − g·τ² only holds while τ is inside the current
  // arc (0 ≤ τ ≤ vUp/g); beyond it the raw parabola is below the plane. A
  // near-elastic bounce (bounce → 1) can exhaust the 64-fold cap with τ still past
  // the arc — evaluating it then lets the runaway −g·τ² teleport the LIVE particle
  // far below the floor. Settle instead. (g ≤ EPS is the gravity-free elastic arc
  // that never returns to the plane, so it is exempt from the domain clamp.)
  const withinArc = g <= COLLISION_EPS || tau <= vUp / g;
  if (vUp > COLLISION_EPS && withinArc) {
    world[1] = floor + vUp * tau - g * tau * tau;
    velocity[1] = vUp - 2 * g * tau;
  } else {
    // bounce == 0 (sliding collision, D4), the geometric series has settled onto the
    // plane, or the cap exited past the current arc — pin to the floor.
    world[1] = floor;
    velocity[1] = 0;
  }
  return true;
}

/**
 * Effective (post-displacement) velocity for velocity-ALIGNMENT only (I13-F).
 * Forward finite difference of the fully-displaced position — analytic motion
 * PLUS the positional modules (force → external → noise), COLLISION EXCLUDED —
 * so noise/force/analytic all continuously turn a velocity-aligned sprite.
 * The caller has already computed the displaced position at (ageSeconds,
 * timeSeconds) for rendering; passing it in as `currentDisplacedPosition`
 * (pre-collision — exactly what `applyPositionalMotionModules` produced)
 * means only the t+dt sample is evaluated here: 1× `sampleParticleMotion` +
 * 1× positional modules per call, half the original central-difference cost.
 * The offset advances `timeSeconds` with `ageSeconds` (total time
 * derivative), capturing noise's temporal scroll. Direction-only consumers
 * make the first-order accuracy moot (this was already the behavior for
 * particles younger than dt). Writes and returns `out`. Gate the CALL on
 * `emitter.render.alignAxis === "velocity"`. The collision reflection
 * (I13-H) is composed by the caller, not here.
 */
export function computeEffectiveAlignmentVelocity(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  ageSeconds: number,
  life: number,
  timeSeconds: number,
  seed: number,
  loopAge: number,
  currentEmitterPosition: Vec3 | undefined,
  initialVelocityMultiplier: number,
  currentDisplacedPosition: Vec3,
  out: Vec3,
): Vec3 {
  const dt = EFFECTIVE_VELOCITY_DT_SECONDS;

  evaluateDisplacedPosition(
    emitter,
    state,
    particleIndex,
    ageSeconds + dt,
    life,
    timeSeconds + dt,
    seed,
    loopAge,
    currentEmitterPosition,
    initialVelocityMultiplier,
    effVelMotionPlus,
    effVelSamplePlus,
  );

  const inv = 1 / dt;
  const pPlus = effVelMotionPlus.position;
  out[0] = (pPlus[0] - currentDisplacedPosition[0]) * inv;
  out[1] = (pPlus[1] - currentDisplacedPosition[1]) * inv;
  out[2] = (pPlus[2] - currentDisplacedPosition[2]) * inv;
  return out;
}

function evaluateDisplacedPosition(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  ageSeconds: number,
  life: number,
  timeSeconds: number,
  seed: number,
  loopAge: number,
  currentEmitterPosition: Vec3 | undefined,
  initialVelocityMultiplier: number,
  motionOut: ParticleMotionResult,
  sampleOut: ParticleMotionSample,
): void {
  const clampedAge = Math.max(0, ageSeconds);
  const normalizedAge = Math.min(
    1,
    Math.max(0, clampedAge / Math.max(0.001, life)),
  );
  sampleParticleMotion(
    emitter,
    state,
    particleIndex,
    clampedAge,
    normalizedAge,
    currentEmitterPosition,
    motionOut,
    initialVelocityMultiplier,
  );
  // sampleOut.world / .velocity already alias motionOut.position / .velocity.
  sampleOut.seed = seed;
  sampleOut.normalizedAge = normalizedAge;
  sampleOut.loopAge = loopAge;
  sampleOut.ageSeconds = clampedAge;
  sampleOut.timeSeconds = timeSeconds;
  applyPositionalMotionModules(emitter, sampleOut); // force → external → noise; NO collision
}

export function sampleParticleModuleColor(
  emitter: ParticleEmitterDefinition,
  normalizedAge: number,
  speed: number,
  seed: number,
  baseColor?: Vec4,
  loopAge?: number,
): Vec4 {
  let color: Vec4 = baseColor
    ? [...baseColor]
    : emitter.modules.color
      ? [
          ...sampleParticleGradientColor(emitter.color.gradient, normalizedAge),
          sampleParticleGradientAlpha(emitter.color.gradient, normalizedAge),
        ]
      : [1, 1, 1, 1];

  if (emitter.modules.colorBySpeed) {
    const settings = emitter.advanced.colorBySpeed;
    const speedT = particleSpeedRangeRatio(settings.speedRange, speed);
    const speedColor: Vec4 = [
      ...sampleParticleGradientColor(settings.gradient, speedT),
      sampleParticleGradientAlpha(settings.gradient, speedT),
    ];
    color = mixColor(color, speedColor, settings.blend);
  }

  if (emitter.modules.lights) {
    color = applyLightColorApproximation(
      emitter.advanced.lights,
      normalizedAge,
      speed,
      seed,
      color,
      loopAge,
    );
  }

  return [
    clamp01(color[0]),
    clamp01(color[1]),
    clamp01(color[2]),
    clamp01(color[3]),
  ];
}

export function particleSizeBySpeedMultiplier(
  emitter: ParticleEmitterDefinition,
  speed: number,
  seed: number,
  loopAge?: number,
): number {
  if (!emitter.modules.sizeBySpeed) return 1;
  const settings = emitter.advanced.sizeBySpeed;
  const speedT = particleSpeedRangeRatio(settings.speedRange, speed);
  const multiplier = sampleParticleScalarValue(
    settings.multiplier,
    speedT,
    seed,
    loopAge,
  );
  return 1 + (Math.max(0, multiplier) - 1) * settings.blend;
}

export function particleRotationBySpeedOffset(
  emitter: ParticleEmitterDefinition,
  speed: number,
  ageSeconds: number,
  seed: number,
  loopAge?: number,
): number {
  if (!emitter.modules.rotationBySpeed) return 0;
  const settings = emitter.advanced.rotationBySpeed;
  const speedT = particleSpeedRangeRatio(settings.speedRange, speed);
  return (
    sampleParticleScalarValue(settings.angularVelocity, speedT, seed, loopAge) *
    ageSeconds *
    settings.blend
  );
}

export function particleTrailSample(
  emitter: ParticleEmitterDefinition,
  normalizedAge: number,
  speed: number,
  seed: number,
  loopAge?: number,
): ParticleTrailSample {
  if (!emitter.modules.trails) {
    return { scaleX: 1, scaleY: 1, stretchesAlongMotion: false };
  }
  return sampleTrailStretchApproximation(
    emitter.advanced.trails,
    normalizedAge,
    speed,
    seed,
    loopAge,
  );
}

export function sampleTrailStretchApproximation(
  settings: ParticleTrailSettings,
  normalizedAge: number,
  speed: number,
  seed: number,
  loopAge?: number,
): ParticleTrailSample {
  // Current renderer support is billboard stretching, not full trail geometry.
  const length = Math.max(
    0,
    sampleParticleScalarValue(settings.length, normalizedAge, seed, loopAge),
  );
  const width = Math.max(
    0.01,
    sampleParticleScalarValue(settings.width, normalizedAge, seed, loopAge),
  );
  const stretch = Math.max(1, 1 + length * Math.max(0, speed) * 0.12);
  return {
    scaleX: width,
    scaleY: stretch,
    stretchesAlongMotion: stretch > 1.000001,
  };
}

export function sampleTextureSheetAnimationFrame(
  settings: ParticleTextureSheetAnimationSettings,
  normalizedAge: number,
  seed: number,
  loopAge?: number,
): ParticleTextureSheetFrameSample {
  const tilesX = Math.max(1, Math.round(settings.tiles[0]));
  const tilesY = Math.max(1, Math.round(settings.tiles[1]));
  const totalFrames = Math.max(1, tilesX * tilesY);

  // I13-G: loop within an inclusive [startFrame, endFrame] sub-range instead of
  // wrapping the whole sheet. Re-clamp here so this seam is the single guard —
  // callers, the normalizer, and any legacy in-memory object without endFrame
  // all funnel through it. rangeLen is always >= 1 (rangeEnd >= rangeStart).
  const rangeStart = Math.min(
    Math.max(0, Math.round(settings.startFrame)),
    totalFrames - 1,
  );
  const endFrameValue =
    typeof settings.endFrame === "number" && Number.isFinite(settings.endFrame)
      ? Math.round(settings.endFrame)
      : totalFrames - 1;
  const rangeEnd = Math.min(
    Math.max(rangeStart, endFrameValue),
    totalFrames - 1,
  );
  const rangeLen = rangeEnd - rangeStart + 1;

  // random start is drawn WITHIN the range (was: over the whole sheet)
  const startOffset = settings.randomStartFrame
    ? Math.floor(seeded01(seed, 71) * rangeLen)
    : 0;
  // frameOverTime * cycles stays motion MAGNITUDE (frame units), wrapped inside
  // the range. startFrame is the range floor, NOT part of the modulo operand.
  const offsetWithinRange =
    startOffset +
    sampleParticleScalarValue(
      settings.frameOverTime,
      normalizedAge,
      seed,
      loopAge,
    ) *
      Math.max(0, settings.cycles);
  const frame =
    rangeStart + positiveModulo(Math.floor(offsetWithinRange), rangeLen);
  return {
    frame,
    column: frame % tilesX,
    row: Math.floor(frame / tilesX),
    tilesX,
    tilesY,
    totalFrames,
  };
}

export function applyLightColorApproximation(
  settings: ParticleLightSettings,
  normalizedAge: number,
  speed: number,
  seed: number,
  color: Vec4,
  loopAge?: number,
): Vec4 {
  // This tints sprite color only; it is not a scene-lighting implementation.
  const intensity = sampleParticleScalarValue(
    settings.intensity,
    normalizedAge,
    seed,
    loopAge,
  );
  if (intensity <= 0) return color;

  const radius = Math.max(
    0,
    sampleParticleScalarValue(settings.radius, normalizedAge, seed, loopAge),
  );
  const falloff = radius > 0 ? Math.min(1, radius / (radius + speed)) : 1;
  const amount = intensity * falloff * 0.35;
  if (settings.additive) {
    return [
      color[0] + settings.color[0] * amount,
      color[1] + settings.color[1] * amount,
      color[2] + settings.color[2] * amount,
      color[3],
    ];
  }
  return mixColor(color, [...settings.color, color[3]], amount);
}

export function mixColor(a: Vec4, b: Vec4, t: number): Vec4 {
  return lerpVec4SrgbRgbInLinear(a, b, t);
}

export function seededSigned(seed: number, salt: number): number {
  return seeded01(seed, salt) * 2 - 1;
}

export function seeded01(seed: number, salt: number): number {
  const value = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
