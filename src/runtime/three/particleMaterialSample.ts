import {
  MeshBasicMaterial,
  ShaderMaterial,
  type MeshStandardMaterial,
} from "three";
import {
  resolveParticleDepthWrite,
  sampleParticleScalarValue,
  type ParticleEmitterDefinition,
} from "../../engine/particles";
import type { MaterialFixedDescriptor } from "../materials/artifact";
import {
  materialBlendOverridesEmitter,
  resolveEffectiveParticleBlend,
  type MaterialBlend,
} from "../schema/materials";
import { threeBlendingForEffectiveBlend } from "./materialAdapter";
import {
  applyThreeShaderTextureFrame,
  type ThreeTextureFrameSet,
} from "./textureFrames";

import type { ParticleSample } from "./rendererState";
export function materialSamplesTextureAlpha(
  material:
    | MeshBasicMaterial
    | MeshStandardMaterial
    | import("three/webgpu").MeshBasicNodeMaterial
    | import("three/webgpu").MeshStandardNodeMaterial,
  emitter: ParticleEmitterDefinition,
): boolean {
  return (
    material.alphaMap !== null ||
    (material.map !== null && emitter.render.opacitySource === "textureAlpha")
  );
}

export function applyThreeShaderSample(
  material: ShaderMaterial,
  emitter: ParticleEmitterDefinition,
  textureFrames: ThreeTextureFrameSet,
  sample: ParticleSample,
  frameIndex: number,
  materialFixed: MaterialFixedDescriptor | null,
  materialBlend: MaterialBlend | null,
  opacityIsConstantOne: boolean,
  timeSeconds: number,
): void {
  applyThreeShaderTextureFrame(
    material,
    textureFrames,
    frameIndex,
    materialFixed,
    timeSeconds,
  );
  const color = material.uniforms.uParticleColor?.value as
    { set: (x: number, y: number, z: number, w: number) => void } | undefined;
  color?.set(
    sample.shaderColor[0],
    sample.shaderColor[1],
    sample.shaderColor[2],
    sample.alpha,
  );
  const effectiveBlend = resolveEffectiveParticleBlend(
    emitter.render.blend,
    materialBlend,
  );
  material.depthTest = emitter.render.depthTest;
  if (materialBlendOverridesEmitter(effectiveBlend)) {
    // Masked/opaque bypass the I12-A gate: opaque ignores alpha by definition
    // and masked resolves translucency via the fragment discard (I12-G).
    material.transparent = false;
    material.depthWrite = true;
    material.blending = threeBlendingForEffectiveBlend(effectiveBlend);
  } else {
    // I12-A: only a provably constant-1 graph opacity lets sample.alpha decide
    // the opaque pass — a live opacity output owns per-pixel translucency.
    material.transparent =
      !opacityIsConstantOne ||
      sample.alpha < 1 ||
      effectiveBlend === "additive" ||
      effectiveBlend === "premultiplied";
    material.depthWrite = resolveParticleDepthWrite(
      {
        ...emitter.render,
        blend:
          effectiveBlend === "additive"
            ? "additive"
            : effectiveBlend === "premultiplied"
              ? "premultiplied"
              : "alpha",
      },
      opacityIsConstantOne ? sample.alpha : 0,
    );
    material.blending = threeBlendingForEffectiveBlend(effectiveBlend);
    material.premultipliedAlpha = effectiveBlend === "premultiplied";
  }
  material.needsUpdate = true;
  const dynamicParams = material.uniforms.uDynamicParams?.value as
    { set: (x: number, y: number, z: number, w: number) => void } | undefined;
  const dynamicValues = sampleEmitterDynamicParams(emitter, sample);
  dynamicParams?.set(
    dynamicValues[0],
    dynamicValues[1],
    dynamicValues[2],
    dynamicValues[3],
  );
  if (material.uniforms.uTime) {
    material.uniforms.uTime.value = timeSeconds;
  }
  material.uniformsNeedUpdate = true;
}

export function sampleEmitterDynamicParams(
  emitter: ParticleEmitterDefinition,
  sample: ParticleSample,
): [number, number, number, number] {
  if (!emitter.modules.customData) return [0, 0, 0, 0];
  const channels = emitter.advanced.customData.channels;
  return [
    sampleParticleScalarValue(
      channels[0],
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
    sampleParticleScalarValue(
      channels[1],
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
    sampleParticleScalarValue(
      channels[2],
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
    sampleParticleScalarValue(
      channels[3],
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  ];
}
