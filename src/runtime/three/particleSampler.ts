import { Color, SRGBColorSpace, Vector3 } from "three";
import type { Vec3 } from "../../engine/math";
import {
  PARTICLE_INSTANCE_STRIDE,
  PARTICLE_RUNTIME_VECTOR_STRIDE,
  isParticleLocalSpace,
  particleSimulationDirectionToWorld,
  particleSimulationToWorld,
  sampleCompiledParticleScalar,
  sampleInitialParticleColorInto,
  sampleParticleGradientAlpha,
  sampleParticleGradientColor,
  sampleParticleScalarValue,
  sampleParticleSimulationMotion,
  type ParticleColorGradientSettings,
  type ParticleEmitterDefinition,
  type ParticleEmitterRuntimeState,
  type ParticleMotionResult,
} from "../../engine/particles";
import type { MaterialFixedDescriptor } from "../materials/artifact";
import {
  applyCollisionResponse,
  applyPositionalMotionModules,
  computeEffectiveAlignmentVelocity,
  particleRotationBySpeedOffset,
  particleSizeBySpeedMultiplier,
  sampleParticleModuleColor,
  type ParticleMotionSample,
} from "../modules";
import { particleRoll } from "../particleOrientation";
import {
  encodePreviewBloomHdrColor,
  toneMapPreviewHdrColorInto,
} from "./hdrColor";
import { selectThreeTextureFrameIndex } from "./textureFrames";

import type {
  ParticleSample,
  ThreeParticleFrameContext,
} from "./rendererState";
import {
  DEFAULT_NORMAL,
  DEFAULT_UP,
  clamp,
  normalizeOr,
} from "./rendererUtils";
export class ThreeParticleSampler {
  private readonly motionScratch: ParticleMotionResult = {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    scratchA: [0, 0, 0],
    scratchB: [0, 0, 0],
  };
  private readonly motionModuleScratch: ParticleMotionSample = {
    seed: 0,
    normalizedAge: 0,
    loopAge: 0,
    ageSeconds: 0,
    timeSeconds: 0,
    world: this.motionScratch.position,
    velocity: this.motionScratch.velocity,
  };
  private readonly sampleSizeScratch = { x: 1, y: 1, z: 1 };
  private readonly initialColorScratch: [number, number, number, number] = [
    1, 1, 1, 1,
  ];
  private readonly secondaryColorScratch: [number, number, number, number] = [
    1, 1, 1, 1,
  ];
  private readonly moduleColorScratch: [number, number, number, number] = [
    1, 1, 1, 1,
  ];
  private readonly hdrColorScratch: Vec3 = [1, 1, 1];
  private readonly renderColorScratch: Vec3 = [1, 1, 1];
  private readonly analyticVelocityScratch: Vec3 = [0, 0, 0];
  private readonly preCollisionWorldScratch: Vec3 = [0, 0, 0];
  private readonly effectiveAlignmentVelocity: Vec3 = [0, 0, 0];
  private readonly sampleScratch: ParticleSample = {
    visible: true,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    speed: 0,
    normalizedAge: 0,
    loopAge: 0,
    start: 0,
    seed: 0,
    width: 1,
    height: 1,
    depthScale: 1,
    depth: 0,
    rotation: [0, 0, 0],
    color: new Color(),
    shaderColor: [1, 1, 1],
    trailColor: [1, 1, 1, 1],
    alpha: 1,
    alignmentAxis: new Vector3(),
    normal: new Vector3(),
    emissiveStrength: 0,
    textureFrameIndex: 0,
  };

  private readonly scratchColor = new Color();
  private readonly scratchAlignmentAxis = new Vector3();
  constructor(private readonly context: ThreeParticleFrameContext) {}
  sampleParticle(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    particleIndex: number,
    timeSeconds: number,
    materialFixed: MaterialFixedDescriptor | null,
    particleColorUsage: { rgb: boolean; alpha: boolean },
  ): ParticleSample | undefined {
    const data = state.instanceData;
    const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
    const start = data[offset + 3] ?? 0;
    const life = Math.max(0.001, data[offset + 7] ?? 0.001);
    const age = timeSeconds - start;
    const unclampedAge = age / life;
    if (unclampedAge < -0.000001 || unclampedAge > 1.000001) {
      return undefined;
    }
    const normalizedAge = clamp(unclampedAge, 0, 1);
    const ageSeconds = Math.max(0, age);
    const loopAge = clamp(state.age / Math.max(0.001, emitter.duration), 0, 1);
    const seed = data[offset + 8] ?? 0.5;
    const motion = sampleParticleSimulationMotion(
      emitter,
      state,
      particleIndex,
      ageSeconds,
      normalizedAge,
      this.context.position,
      this.motionScratch,
      this.context.runner.effectiveInitialVelocityMultiplier(emitter.id),
    );
    const velocity = motion.velocity;
    const world = motion.position;
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
    const alignToVelocity = emitter.render.alignAxis === "velocity";
    if (alignToVelocity) {
      this.analyticVelocityScratch[0] = velocity[0];
      this.analyticVelocityScratch[1] = velocity[1];
      this.analyticVelocityScratch[2] = velocity[2];
    }
    const motionModuleSample = this.motionModuleScratch;
    motionModuleSample.seed = seed;
    motionModuleSample.normalizedAge = normalizedAge;
    motionModuleSample.loopAge = loopAge;
    motionModuleSample.ageSeconds = ageSeconds;
    motionModuleSample.timeSeconds = timeSeconds;
    motionModuleSample.world = world;
    motionModuleSample.velocity = velocity;
    // Split module pass (was applyParticleMotionModulesToSample): the
    // PRE-collision displaced position feeds the effective-alignment forward
    // difference below, saving its second motion evaluation (I13-F contract:
    // collision excluded).
    applyPositionalMotionModules(emitter, motionModuleSample);
    particleSimulationToWorld(
      emitter,
      state,
      particleIndex,
      world,
      velocity,
      this.context.position,
    );
    if (alignToVelocity) {
      particleSimulationDirectionToWorld(
        emitter,
        state,
        particleIndex,
        this.analyticVelocityScratch,
      );
      this.preCollisionWorldScratch[0] = world[0];
      this.preCollisionWorldScratch[1] = world[1];
      this.preCollisionWorldScratch[2] = world[2];
    }
    if (
      emitter.modules.collision &&
      !applyCollisionResponse(emitter, motionModuleSample)
    ) {
      return undefined;
    }

    const size = sampleParticleSize(
      emitter,
      state,
      particleIndex,
      normalizedAge,
      speed,
      seed,
      loopAge,
      this.sampleSizeScratch,
    );
    const rotationX =
      (data[offset + 13] ?? 0) + ageSeconds * (data[offset + 15] ?? 0);
    const rotationY =
      (data[offset + 14] ?? 0) + ageSeconds * (data[offset + 16] ?? 0);
    const rotationZ = particleRoll(
      data[offset + 9] ?? 0,
      data[offset + 10] ?? 0,
      ageSeconds,
      particleRotationBySpeedOffset(emitter, speed, ageSeconds, seed, loopAge),
    );
    const initColor = sampleInitialParticleColorInto(
      emitter.initializeParticle.color,
      seed,
      normalizedAge,
      loopAge,
      this.initialColorScratch,
      this.secondaryColorScratch,
    );
    const intensity = Math.max(
      0,
      sampleParticleScalarValue(
        emitter.initializeParticle.color.intensity,
        normalizedAge,
        seed,
        loopAge,
      ),
    );
    const drawParameters = this.context.emitterDrawParameters.get(emitter.id);
    const overLife = drawParameters?.colorOverLifetimeGradient
      ? sampleGradientOverrideColor(
          drawParameters.colorOverLifetimeGradient,
          normalizedAge,
          this.moduleColorScratch,
        )
      : !emitter.modules.colorBySpeed && !emitter.modules.lights
        ? sampleSimpleParticleModuleColor(
            emitter,
            normalizedAge,
            this.moduleColorScratch,
          )
        : sampleParticleModuleColor(
            emitter,
            normalizedAge,
            speed,
            seed,
            undefined,
            loopAge,
          );
    const materialTint = materialFixed?.tint ?? [1, 1, 1, 1];
    const materialEmissive = materialFixed
      ? 1 + Math.max(0, materialFixed.emissive)
      : 1;
    const materialOpacity = materialFixed?.opacity ?? 1;
    const emitterR = particleColorUsage.rgb
      ? initColor[0] * intensity * overLife[0]
      : 1;
    const emitterG = particleColorUsage.rgb
      ? initColor[1] * intensity * overLife[1]
      : 1;
    const emitterB = particleColorUsage.rgb
      ? initColor[2] * intensity * overLife[2]
      : 1;
    const emitterA = particleColorUsage.alpha ? initColor[3] * overLife[3] : 1;
    const hdrColor = this.hdrColorScratch;
    hdrColor[0] = Math.max(0, emitterR * materialTint[0] * materialEmissive);
    hdrColor[1] = Math.max(0, emitterG * materialTint[1] * materialEmissive);
    hdrColor[2] = Math.max(0, emitterB * materialTint[2] * materialEmissive);
    const renderColor = this.context.previewBloomEnabled
      ? encodePreviewBloomHdrColor(
          hdrColor,
          this.context.previewBloomThreshold,
          this.context.previewExposureStops,
        )
      : toneMapPreviewHdrColorInto(
          hdrColor,
          this.context.previewExposureStops,
          this.renderColorScratch,
        );
    const color = this.scratchColor.setRGB(
      renderColor[0],
      renderColor[1],
      renderColor[2],
      SRGBColorSpace,
    );
    const alpha = clamp(emitterA * materialTint[3] * materialOpacity, 0, 1);
    let alignmentVelocity: Vec3 = velocity;
    let alignmentSpeed = speed;
    if (alignToVelocity) {
      const eff = computeEffectiveAlignmentVelocity(
        emitter,
        state,
        particleIndex,
        ageSeconds,
        life,
        timeSeconds,
        seed,
        loopAge,
        this.context.position,
        this.context.runner.effectiveInitialVelocityMultiplier(emitter.id),
        this.preCollisionWorldScratch,
        this.effectiveAlignmentVelocity,
      );
      // Compose I13-H's collision reflection (0 when not collided). `velocity` is
      // motion.velocity AFTER the module pass; analyticVelocityScratch is before it.
      eff[0] += velocity[0] - this.analyticVelocityScratch[0];
      eff[1] += velocity[1] - this.analyticVelocityScratch[1];
      eff[2] += velocity[2] - this.analyticVelocityScratch[2];
      alignmentVelocity = eff;
      alignmentSpeed = Math.hypot(eff[0], eff[1], eff[2]);
    }
    const alignmentAxis = this.resolveParticleAlignmentAxis(
      emitter,
      state,
      particleIndex,
      alignmentVelocity,
      alignmentSpeed,
    );

    const sample = this.sampleScratch;
    sample.visible = true;
    sample.position[0] = world[0];
    sample.position[1] = world[1];
    sample.position[2] = world[2];
    sample.velocity[0] = velocity[0];
    sample.velocity[1] = velocity[1];
    sample.velocity[2] = velocity[2];
    sample.speed = speed;
    sample.normalizedAge = normalizedAge;
    sample.loopAge = loopAge;
    sample.start = start;
    sample.seed = seed;
    const localSpace = isParticleLocalSpace(state, particleIndex);
    sample.width = size.x * (localSpace ? emitter.spawn.scale[0] : 1);
    sample.height = size.y * (localSpace ? emitter.spawn.scale[1] : 1);
    sample.depthScale = size.z * (localSpace ? emitter.spawn.scale[2] : 1);
    sample.depth = world[2];
    sample.rotation[0] = rotationX;
    sample.rotation[1] = rotationY;
    sample.rotation[2] =
      rotationZ +
      (localSpace && emitter.render.alignAxis === "screen"
        ? (emitter.spawn.rotation[2] * Math.PI) / 180
        : 0);
    sample.color.copy(color);
    sample.shaderColor[0] = renderColor[0];
    sample.shaderColor[1] = renderColor[1];
    sample.shaderColor[2] = renderColor[2];
    sample.alpha = alpha;
    // Preserve pre-material color for independently shaded trails.
    if (emitter.modules.trails && emitter.advanced.trails.material) {
      sample.trailColor[0] = initColor[0] * intensity * overLife[0];
      sample.trailColor[1] = initColor[1] * intensity * overLife[1];
      sample.trailColor[2] = initColor[2] * intensity * overLife[2];
      sample.trailColor[3] = initColor[3] * overLife[3];
    }
    sample.alignmentAxis.copy(alignmentAxis);
    sample.normal.copy(alignmentAxis);
    sample.emissiveStrength = Math.max(hdrColor[0], hdrColor[1], hdrColor[2]);
    sample.textureFrameIndex = selectThreeTextureFrameIndex(
      emitter,
      normalizedAge,
      seed,
      loopAge,
    );
    if (drawParameters) {
      let sizeScale = drawParameters.sizeMultiplier;
      if (drawParameters.sizeMultiplierValue) {
        sizeScale *= Math.max(
          0,
          sampleCompiledParticleScalar(
            drawParameters.sizeMultiplierValue,
            normalizedAge,
            seed,
          ),
        );
      }
      sample.width *= sizeScale;
      sample.height *= sizeScale;
      sample.depthScale *= sizeScale;
      const tint = drawParameters.colorTint;
      sample.color.r *= tint[0];
      sample.color.g *= tint[1];
      sample.color.b *= tint[2];
      sample.shaderColor[0] *= tint[0];
      sample.shaderColor[1] *= tint[1];
      sample.shaderColor[2] *= tint[2];
      sample.alpha *= tint[3];
      for (let channel = 0; channel < 4; channel++)
        sample.trailColor[channel] *= tint[channel]!;
    }
    return sample;
  }

  private resolveParticleAlignmentAxis(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    particleIndex: number,
    velocity: Vec3,
    speed: number,
  ): Vector3 {
    const out = this.scratchAlignmentAxis;
    if (emitter.render.alignAxis === "screen") {
      out.copy(DEFAULT_UP).applyQuaternion(this.context.camera.quaternion);
      return normalizeOr(out, DEFAULT_UP);
    }
    if (emitter.render.alignAxis === "velocity") {
      out.set(velocity[0], velocity[1], velocity[2]);
      if (speed > 0.000001) return normalizeOr(out, DEFAULT_NORMAL);
      const offset = particleIndex * PARTICLE_RUNTIME_VECTOR_STRIDE;
      out.set(
        state.spawnDirectionData[offset + 0] ?? 0,
        state.spawnDirectionData[offset + 1] ?? 1,
        state.spawnDirectionData[offset + 2] ?? 0,
      );
      const direction: Vec3 = [out.x, out.y, out.z];
      particleSimulationDirectionToWorld(
        emitter,
        state,
        particleIndex,
        direction,
      );
      out.set(...direction);
      return normalizeOr(out, DEFAULT_NORMAL);
    }
    if (emitter.render.alignAxis === "spawnDirection") {
      const offset = particleIndex * PARTICLE_RUNTIME_VECTOR_STRIDE;
      out.set(
        state.spawnDirectionData[offset + 0] ?? 0,
        state.spawnDirectionData[offset + 1] ?? 1,
        state.spawnDirectionData[offset + 2] ?? 0,
      );
      const direction: Vec3 = [out.x, out.y, out.z];
      particleSimulationDirectionToWorld(
        emitter,
        state,
        particleIndex,
        direction,
      );
      out.set(...direction);
      return normalizeOr(out, DEFAULT_NORMAL);
    }
    out.set(
      emitter.render.alignmentVector[0],
      emitter.render.alignmentVector[1],
      emitter.render.alignmentVector[2],
    );
    return normalizeOr(out, DEFAULT_UP);
  }
}
function sampleParticleSize(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  normalizedAge: number,
  speed: number,
  seed: number,
  loopAge: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
  const initSizeX = Math.max(0, state.instanceData[offset + 11] ?? 1);
  const initSizeY = Math.max(0, state.instanceData[offset + 12] ?? initSizeX);
  const initSizeZ =
    emitter.mode === "mesh"
      ? Math.max(0, state.instanceData[offset + 17] ?? initSizeX)
      : initSizeX;
  const sizeSettingsX =
    emitter.mode === "billboard"
      ? emitter.billboard.sizeValue
      : emitter.mesh.sizeValue;
  const sizeSettingsY =
    emitter.mode === "billboard"
      ? emitter.billboard.separateAxes
        ? emitter.billboard.sizeValueY
        : sizeSettingsX
      : emitter.mesh.separateAxes
        ? emitter.mesh.sizeValueY
        : sizeSettingsX;
  const sizeSettingsZ =
    emitter.mode === "mesh" && emitter.mesh.separateAxes
      ? emitter.mesh.sizeValueZ
      : sizeSettingsX;
  const overLifeX = emitter.modules.size
    ? Math.max(
        0,
        sampleParticleScalarValue(sizeSettingsX, normalizedAge, seed, loopAge),
      )
    : 1;
  const overLifeY = emitter.modules.size
    ? Math.max(
        0,
        sampleParticleScalarValue(sizeSettingsY, normalizedAge, seed, loopAge),
      )
    : 1;
  const overLifeZ = emitter.modules.size
    ? Math.max(
        0,
        sampleParticleScalarValue(sizeSettingsZ, normalizedAge, seed, loopAge),
      )
    : 1;
  const bySpeed = particleSizeBySpeedMultiplier(emitter, speed, seed, loopAge);
  out.x = Math.max(0.0001, initSizeX * overLifeX * bySpeed);
  out.y = Math.max(0.0001, initSizeY * overLifeY * bySpeed);
  out.z = Math.max(0.0001, initSizeZ * overLifeZ * bySpeed);
  return out;
}

/**
 * Samples a host-injected color-over-lifetime gradient with the exact same
 * samplers as the authored path, so an override equal to the authored
 * gradient renders identically.
 */
function sampleGradientOverrideColor(
  gradient: ParticleColorGradientSettings,
  normalizedAge: number,
  out: [number, number, number, number],
): [number, number, number, number] {
  sampleParticleGradientColor(gradient, normalizedAge, out);
  out[3] = sampleParticleGradientAlpha(gradient, normalizedAge);
  return out;
}

function sampleSimpleParticleModuleColor(
  emitter: ParticleEmitterDefinition,
  normalizedAge: number,
  out: [number, number, number, number],
): [number, number, number, number] {
  if (!emitter.modules.color) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = 1;
    return out;
  }
  sampleParticleGradientColor(emitter.color.gradient, normalizedAge, out);
  out[3] = sampleParticleGradientAlpha(emitter.color.gradient, normalizedAge);
  return out;
}
