import { BackSide, DoubleSide, FrontSide, type Texture } from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import * as T from "three/tsl";
import {
  resolveParticleDepthWrite,
  type ParticleEmitterDefinition,
} from "../../../engine/particles";
import { createTextureAssetRef } from "../../assets/textureRefs";
import {
  materialBlendOverridesEmitter,
  resolveEffectiveParticleBlend,
  resolveEffectiveMainTexPath,
  SPRITE_MASTER_SHADER_ID,
} from "../../schema/materials";
import { compileMaterial } from "../../materials/compileMaterial";
import type { ThreeVfxRenderAdapter } from "../renderAdapter";
import type { ThreeVfxEffectInstanceOptions } from "../types";
import {
  threeBlendingForEffectiveBlend,
  type ThreeEmitterMaterialResolution,
} from "../materialAdapter";
import { getProceduralBillboardTexture } from "../proceduralBillboardTexture";
import { rawColorSpaceTextureView } from "../textureViews";
import {
  compileThreeNodeGraph,
  nodeLinearColor,
  ThreeNodeMaterialError,
  type Node4,
} from "./graph";
import { createSceneGraphInputs } from "./sceneInputs";
import { ThreeNodeInstances } from "./instances";

/** Pair with WebGPURenderer (native WebGPU or its WebGL2 fallback), never WebGLRenderer. */
export function createThreeNodeAdapter(): ThreeVfxRenderAdapter {
  return {
    createMaterial: (emitter, options, trail) => {
      try {
        return createNodeMaterial(emitter, options, trail);
      } catch (error) {
        throw new Error(
          `Emitter "${emitter.id}" (${trail ? "trail" : "surface"}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    createInstances: (geometry, resolution, emitter) =>
      new ThreeNodeInstances(geometry, resolution, emitter),
  };
}
function createNodeMaterial(
  original: ParticleEmitterDefinition,
  options: ThreeVfxEffectInstanceOptions,
  trail: boolean,
): ThreeEmitterMaterialResolution {
  const trails = original.advanced.trails;
  const emitter = trail
    ? {
        ...original,
        modules: { ...original.modules, textureSheetAnimation: false },
        render: {
          ...original.render,
          material: trails.material,
          texture: trails.texture,
          shading: "unlit" as const,
          blend: "alpha" as const,
          depthTest: trails.depthTest,
          depthWrite: trails.depthWrite,
          opacitySource: "textureAlpha" as const,
          opacityInvert: false,
        },
      }
    : original;
  const instance = emitter.render.material;
  const graph = instance
    ? options.materialGraphProvider?.(instance.shaderId)
    : undefined;
  if (instance && !graph)
    throw new ThreeNodeMaterialError(
      instance.shaderId,
      `${emitter.id}.${trail ? "advanced.trails" : "render"}.material`,
      "Material graph is unavailable; load its .material file.",
    );
  const artifact = graph && instance ? compileMaterial(graph, instance) : null;
  const materialBlend =
    graph &&
    (instance?.shaderId !== SPRITE_MASTER_SHADER_ID ||
      materialBlendOverridesEmitter(graph.blend))
      ? graph.blend
      : null;
  const blend = resolveEffectiveParticleBlend(
      emitter.render.blend,
      materialBlend,
    ),
    ownsBlend = materialBlendOverridesEmitter(blend);
  const lit =
    graph?.shadingModel === "lit" ||
    (!graph && emitter.render.shading === "lit");
  const material = lit
    ? new MeshStandardNodeMaterial()
    : new MeshBasicNodeMaterial();
  try {
    material.name = `NixieFX ${emitter.id}${trail ? " trail" : ""} node material`;
    material.depthTest = emitter.render.depthTest;
    material.depthWrite =
      ownsBlend ||
      resolveParticleDepthWrite(
        {
          ...emitter.render,
          blend:
            blend === "additive"
              ? "additive"
              : blend === "premultiplied"
                ? "premultiplied"
                : "alpha",
        },
        0,
      );
    material.transparent = !ownsBlend;
    material.blending = threeBlendingForEffectiveBlend(blend);
    material.premultipliedAlpha = blend === "premultiplied";
    material.side =
      graph?.side === "front"
        ? FrontSide
        : graph?.side === "back"
          ? BackSide
          : DoubleSide;
    material.forceSinglePass = !(
      emitter.mode === "mesh" &&
      emitter.mesh.renderMode === "meshAsset" &&
      !ownsBlend &&
      blend !== "additive"
    );
    // Node expressions own color multiplication, including the versioned graph rule.
    material.vertexColors = false;
    if (artifact?.usesSceneLighting) material.lights = true;
    const time = T.uniform(0);
    const particle = T.attribute<"vec4">(trail ? "color" : "nfxColor", "vec4");
    const dynamic = T.attribute<"vec4">(
      trail ? "trailDynamicParams" : "nfxDynamic",
      "vec4",
    );
    const subUv = trail
      ? T.vec4(0, 0, 1, 1)
      : T.attribute<"vec4">("nfxSubUv", "vec4");
    const path = instance
      ? resolveEffectiveMainTexPath(graph, instance) || emitter.render.texture
      : emitter.render.texture;
    const raw = (texture: Texture | null) =>
      texture ? rawColorSpaceTextureView(texture) : null;
    const main = path
      ? (options.textureProvider?.getTexture(createTextureAssetRef(path)) ??
        null)
      : !instance && !trail && emitter.mode === "billboard"
        ? getProceduralBillboardTexture(
            emitter.billboard.shape,
            emitter.billboard.softness,
          )
        : null;
    if (path && !main)
      throw new ThreeNodeMaterialError(
        instance?.shaderId ?? emitter.id,
        "MainTex",
        `Texture "${path}" is unavailable.`,
      );
    const sample = main
      ? T.texture(raw(main)!, subUv.xy.add(T.fract(T.uv()).mul(subUv.zw)))
      : T.vec4(1);
    let base: Node4 = nodeLinearColor(sample).mul(nodeLinearColor(particle));
    let emissive: Node4 = T.vec4(0);
    let opacity = sample.a.mul(particle.a);
    if (graph && instance) {
      const legacyParticle =
        graph.colorVersion === 1
          ? particle
          : T.vec4(particle.rgb.mul(particle.a), particle.a);
      const compiled = compileThreeNodeGraph(graph, instance, {
        time,
        particleColor: legacyParticle,
        dynamic,
        subUv,
        mainTexture: raw(main),
        textureForPath: (path) =>
          raw(
            options.textureProvider?.getTexture(createTextureAssetRef(path)) ??
              null,
          ),
        scene: createSceneGraphInputs(),
        tiles: emitter.modules.textureSheetAnimation
          ? emitter.advanced.textureSheetAnimation.tiles
          : [1, 1],
      });
      const modulation =
        graph.colorVersion === 1
          ? compiled.readsParticleColor
            ? T.vec4(1)
            : nodeLinearColor(particle)
          : legacyParticle;
      base = compiled.base.mul(modulation);
      emissive = compiled.emissive.mul(modulation);
      opacity = compiled.opacity.clamp().mul(modulation.a);
      if (material instanceof MeshStandardNodeMaterial) {
        material.roughnessNode = compiled.roughness?.r.clamp() ?? T.float(0.62);
        material.metalnessNode = compiled.metallic?.r.clamp() ?? T.float(0);
        if (compiled.normal)
          material.normalNode = T.normalMap(
            T.vec3(compiled.normal.xyz).add(1).mul(0.5),
          );
      }
      if (blend !== "opaque" && (blend === "masked" || compiled.mask)) {
        const mask = compiled.mask?.r ?? compiled.opacity;
        const unmasked = base;
        base = T.Fn(() => {
          T.Discard(mask.lessThan(graph.opacityMaskClipValue ?? 0.333));
          return unmasked;
        })();
      }
    } else {
      let alpha =
        emitter.render.opacitySource === "constant" ? T.float(1) : sample.a;
      if (emitter.render.opacitySource === "luminance")
        alpha = sample.rgb.dot(T.vec3(0.2126, 0.7152, 0.0722));
      if (emitter.render.opacitySource === "red") alpha = sample.r;
      if (emitter.render.opacitySource === "green") alpha = sample.g;
      if (emitter.render.opacitySource === "blue") alpha = sample.b;
      if (emitter.render.opacitySource === "inverseLuminance")
        alpha = T.float(1).sub(sample.rgb.dot(T.vec3(0.2126, 0.7152, 0.0722)));
      if (emitter.render.opacityInvert) alpha = T.float(1).sub(alpha);
      opacity = alpha.mul(particle.a);
      if (material instanceof MeshStandardNodeMaterial && !trail) {
        emissive = T.vec4(
          nodeLinearColor(particle).rgb.mul(
            T.attribute<"float">("nfxEmissive", "float").sub(1).max(0),
          ),
          0,
        );
      }
    }
    material.colorNode = T.vec4(
      material instanceof MeshStandardNodeMaterial
        ? base.rgb
        : base.rgb.add(emissive.rgb),
      1,
    );
    material.opacityNode = ownsBlend ? T.float(1) : opacity;
    if (material instanceof MeshStandardNodeMaterial)
      material.emissiveNode = emissive.rgb;
    if (graph && graph.colorVersion !== 1) {
      // Legacy GLSL wrote raw display RGB; cancel the renderer output transfer
      // after lighting, preserving that versioned convention (including HDR).
      material.outputNode = T.vec4(nodeLinearColor(T.output).rgb, T.output.a);
    }
    return {
      material,
      ownedTextures: [],
      fixed: null,
      particleColorUsage:
        graph &&
        graph.colorVersion !== 1 &&
        instance?.shaderId !== SPRITE_MASTER_SHADER_ID &&
        artifact
          ? {
              rgb: artifact.usesParticleColorRGB,
              alpha: artifact.usesParticleColorAlpha,
            }
          : { rgb: true, alpha: true },
      opacityIsConstantOne:
        artifact?.opacityIsConstantOne ??
        (emitter.render.opacitySource === "constant" || !main),
      materialBlend,
      missingMaterialRef: null,
      unsupportedFeatures: [],
      key: `node:${instance?.shaderId ?? emitter.id}:${trail}`,
      updateTime: (value) => {
        time.value = value;
      },
    };
  } catch (error) {
    material.dispose();
    throw error;
  }
}
