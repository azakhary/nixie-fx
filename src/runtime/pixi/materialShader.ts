import { Matrix, Shader, Texture, type Shader as PixiShader } from "pixi.js";
import type { Vec4 } from "../../engine/math";
import type { MaterialArtifact, MaterialFixedDescriptor } from "../materials";
import {
  canRenderTier2ParticleContainerShader,
  createMaterialPreviewFragment,
} from "../materials/materialShaderCompiler";
import type { MaterialInstance, ShaderGraph } from "../schema/materials";

export {
  MATERIAL_MAX_NODE_SAMPLERS,
  canRenderTier2ParticleContainerShader,
  createMaterialNodePreviewFragment,
  createMaterialNodePreviewFragmentSource,
  createMaterialPreviewFragment,
  createMaterialPreviewFragmentSource,
  tier2ParticleSamplerDeferralDiagnostics,
  type CompiledMaterialFragment,
  type MaterialSamplerBinding,
} from "../materials/materialShaderCompiler";

/**
 * Tier-2 material shader for the Pixi ParticleContainer path (techspec §6.1
 * path 2a). This owns the real per-pixel graph execution that runs on particles:
 * it keeps Pixi's particle vertex attributes (`aVertex/aUV/aColor/aPosition/
 * aRotation`) and replaces the fragment stage with the compiled material graph.
 *
 * The path deliberately exposes only the data ParticleContainer really has:
 * `vUV`, premultiplied `vColor`, and material uniforms. Graphs that require a
 * genuine extra per-particle float stream are diagnosed by `compileMaterial`
 * and stay on the future custom-Mesh path instead of silently no-oping here.
 */

export interface Tier2ParticleMaterialShaderOptions {
  graph: ShaderGraph;
  instance: MaterialInstance;
  artifact: MaterialArtifact;
  texture?: Texture;
  textureSheetTiles?: [number, number];
}

/**
 * One per-node texture sampler the compiler emitted. Hosts (preview + runtime)
 * iterate this list to bind a GL texture per `uniform` to the asset at `path`.
 * `nodeId` is the texture-reading node; `path` is the resolved asset path (the
 * node's own `params.tex`, or a wired texture param's value).
 */
const PARTICLE_VERTEX_SHADER = `
attribute vec2 aVertex;
attribute vec2 aUV;
attribute vec4 aColor;
attribute vec2 aPosition;
attribute float aRotation;

uniform mat3 uTranslationMatrix;
uniform float uRound;
uniform vec2 uResolution;
uniform vec4 uColor;

varying vec2 vUV;
varying vec4 vColor;

vec2 materialRoundPixels(vec2 position, vec2 targetSize) {
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

void main(void) {
  float c = cos(aRotation);
  float s = sin(aRotation);
  vec2 local = vec2(
    aVertex.x * c - aVertex.y * s,
    aVertex.x * s + aVertex.y * c
  ) + aPosition;
  gl_Position = vec4((uTranslationMatrix * vec3(local, 1.0)).xy, 0.0, 1.0);
  if (uRound == 1.0) {
    gl_Position.xy = materialRoundPixels(gl_Position.xy, uResolution);
  }
  vUV = aUV;
  vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uColor;
}
`;

export function createTier2ParticleMaterialShader({
  graph,
  instance,
  artifact,
  texture,
  textureSheetTiles,
}: Tier2ParticleMaterialShaderOptions): PixiShader | null {
  if (!canRenderTier2ParticleContainerShader(artifact)) return null;
  const compiled = createMaterialPreviewFragment({ artifact, graph, instance });
  if (!compiled) return null;
  const fragment = compiled.fragment;
  const fixed = artifact.fixed ?? defaultFixed(graph.blend);
  const tiles: [number, number] = [
    Math.max(1, Math.round(textureSheetTiles?.[0] ?? 1)),
    Math.max(1, Math.round(textureSheetTiles?.[1] ?? 1)),
  ];
  // Decision D3 (phase-1, honest): the compiler now emits one `uTexN` sampler
  // per node-picked texture, but the particle renderer has no per-node asset →
  // Texture resolution path yet, so bind each `uTexN` to the emitter MainTex so
  // the shader links instead of failing. Per-node particle textures are deferred
  // (surfaced via `tier2ParticleSamplerDeferralDiagnostics`). A graph with NO
  // per-node textures adds NO extra resources → byte-identical to before.
  const mainSource = (texture ?? Texture.WHITE).source;
  const perNodeSamplers: Record<string, typeof mainSource> = {};
  for (const binding of compiled.samplers) {
    perNodeSamplers[binding.uniform] = mainSource;
  }
  return Shader.from({
    gl: {
      vertex: PARTICLE_VERTEX_SHADER,
      fragment,
      name: `vfx-tier2-${artifact.shaderId}`,
    },
    resources: {
      uTexture: mainSource,
      uSampler: mainSource.style,
      ...perNodeSamplers,
      uniforms: {
        uTranslationMatrix: { value: new Matrix(), type: "mat3x3<f32>" },
        uColor: { value: new Float32Array([1, 1, 1, 1]), type: "vec4<f32>" },
        uRound: { value: 1, type: "f32" },
        uResolution: { value: [0, 0], type: "vec2<f32>" },
      },
      materialUniforms: {
        uTime: { value: 0, type: "f32" },
        uFixedTint: {
          value: new Float32Array(fixed.tint),
          type: "vec4<f32>",
        },
        uFixedEmissive: { value: Math.max(0, fixed.emissive), type: "f32" },
        uFixedOpacity: { value: fixed.opacity, type: "f32" },
        uClipValue: { value: graph.opacityMaskClipValue ?? 0.333, type: "f32" },
        uSheetTiles: {
          value: new Float32Array(tiles),
          type: "vec2<f32>",
        },
        uSubUv: {
          value: new Float32Array([0, 0, 1, 1]),
          type: "vec4<f32>",
        },
        uSubUvFromAttr: { value: 1, type: "f32" },
        uDynamicParams: {
          value: new Float32Array([0, 0, 0, 0]),
          type: "vec4<f32>",
        },
      },
    },
  });
}

export function updateTier2ParticleMaterialShaderTime(
  shader: PixiShader | null | undefined,
  timeSeconds: number,
): void {
  const uniforms = shader?.resources?.materialUniforms?.uniforms as
    { uTime?: number } | undefined;
  if (!uniforms) return;
  uniforms.uTime = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
}

export function updateTier2ParticleMaterialShaderDynamicParams(
  shader: PixiShader | null | undefined,
  params: Vec4,
): void {
  const uniforms = shader?.resources?.materialUniforms?.uniforms as
    { uDynamicParams?: Float32Array | number[] } | undefined;
  const target = uniforms?.uDynamicParams;
  if (!target) return;
  target[0] = params[0];
  target[1] = params[1];
  target[2] = params[2];
  target[3] = params[3];
}

function defaultFixed(
  blend: MaterialFixedDescriptor["blend"],
): MaterialFixedDescriptor {
  return {
    tint: [1, 1, 1, 1],
    emissive: 0,
    opacity: 1,
    blend,
  };
}
