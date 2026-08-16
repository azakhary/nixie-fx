import {
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  NoBlending,
  NormalBlending,
  Vector2,
  Vector4,
  type Blending,
  type Material,
  type Side,
  type Texture,
} from "three";
import {
  resolveParticleDepthWrite,
  type ParticleEmitterDefinition,
} from "../../engine/particles";
import { createTextureAssetRef } from "../assets/textureRefs";
import { bakeGraphInPlace } from "../materials/bake";
import { compileMaterial } from "../materials/compileMaterial";
import type { MaterialFixedDescriptor } from "../materials/artifact";
import {
  DEFAULT_OPACITY_MASK_CLIP_VALUE,
  SPRITE_MASTER_SHADER_ID,
  materialBlendOverridesEmitter,
  resolveEffectiveMainTexPath,
  resolveEffectiveParticleBlend,
  type EffectiveParticleBlend,
  type MaterialBlend,
  type ShaderGraph,
} from "../schema/materials";
import {
  canRenderTier2ParticleContainerShader,
  createMaterialPreviewFragment,
} from "../materials/materialShaderCompiler";
import { threeAlphaMapFromOpacitySource } from "./alphaTexture";
import {
  getProceduralBillboardTexture,
  proceduralBillboardTextureKey,
} from "./proceduralBillboardTexture";
import type { ThreeVfxEffectInstanceOptions } from "./types";

export interface ThreeEmitterMaterialResolution {
  material: ThreeParticleMaterial;
  ownedTextures: Texture[];
  fixed: MaterialFixedDescriptor | null;
  particleColorUsage: { rgb: boolean; alpha: boolean };
  opacityIsConstantOne: boolean;
  /** The graph's authoritative blend, null for texture-only emitters. */
  materialBlend: MaterialBlend | null;
  missingMaterialRef: string | null;
  unsupportedFeatures: string[];
  key: string;
}

/** The Three blending constant for a resolved effective blend (I12-G). */
export function threeBlendingForEffectiveBlend(
  blend: EffectiveParticleBlend,
): Blending {
  if (blend === "opaque") return NoBlending;
  if (blend === "additive") return AdditiveBlending;
  return NormalBlending;
}

export type ThreeParticleMaterial =
  MeshBasicMaterial | MeshStandardMaterial | ShaderMaterial;

export function createThreeEmitterMaterial(
  emitter: ParticleEmitterDefinition,
  options: ThreeVfxEffectInstanceOptions,
): ThreeEmitterMaterialResolution {
  const materialInstance = emitter.render.material;
  const materialGraph = materialInstance
    ? options.materialGraphProvider?.(materialInstance.shaderId)
    : undefined;
  const source = resolveEmitterTexture(emitter, options, materialGraph);
  const sourceTexture = source.texture;
  const unsupportedFeatures: string[] = [];
  let missingMaterialRef: string | null = null;
  let fixed: MaterialFixedDescriptor | null = null;
  let particleColorUsage = { rgb: true, alpha: true };
  let opacityIsConstantOne = true;
  let materialBlend: MaterialBlend | null = null;
  let bakedTextureApplied = false;
  let texture = sourceTexture;
  const ownedTextures: Texture[] = [...source.ownedTextures];
  let key = [
    emitterTexturePath(emitter) ?? emitterProceduralBillboardKey(emitter) ?? "",
    emitter.render.opacitySource,
    Number(emitter.render.opacityInvert),
  ].join(":");

  if (materialInstance) {
    key = `${key}:${materialInstance.shaderId}`;
    if (!materialGraph) {
      missingMaterialRef = materialInstance.shaderId;
    } else {
      const artifact = compileMaterial(materialGraph, materialInstance, {
        mainTexUid: sourceTexture ? sourceTexture.id : null,
      });
      opacityIsConstantOne = artifact.opacityIsConstantOne;
      materialBlend = artifact.blend;
      if (materialInstance.shaderId !== SPRITE_MASTER_SHADER_ID) {
        particleColorUsage = {
          rgb: artifact.usesParticleColorRGB,
          alpha: artifact.usesParticleColorAlpha,
        };
      }
      key = `${key}:${materialGraph.side ?? "double"}:${artifact.blend}:${artifact.tier}:${artifact.bakeHash ?? artifact.shaderId}`;
      if (artifact.tier === "tier0-bake" && sourceTexture) {
        const baked = createBakedTexture(
          sourceTexture,
          materialGraph,
          materialInstance,
          options,
        );
        if (baked) {
          texture = baked;
          ownedTextures.push(baked);
          fixed = null;
          bakedTextureApplied = true;
        } else {
          fixed = artifact.fixed ?? null;
          unsupportedFeatures.push(
            `${emitter.id}.render.material: Three could not bake the material texture yet.`,
          );
        }
      } else {
        fixed = artifact.fixed ?? null;
      }
      if (artifact.tier === "tier2-shader") {
        const shaderMaterial = createThreeShaderMaterial(
          emitter,
          sourceTexture,
          materialGraph,
          materialInstance,
          artifact,
          options,
        );
        if (shaderMaterial) {
          texture = null;
          fixed = null;
          ownedTextures.push(...shaderMaterial.ownedTextures);
          return {
            material: shaderMaterial.material,
            ownedTextures,
            fixed,
            particleColorUsage,
            opacityIsConstantOne,
            materialBlend,
            missingMaterialRef,
            unsupportedFeatures,
            key,
          };
        } else {
          unsupportedFeatures.push(
            `${emitter.id}.render.material: Three preview uses fixed-function material fallback for unsupported Tier-2 shader graphs.`,
          );
        }
      }
      if (artifact.tier === "tier3-defer") {
        unsupportedFeatures.push(...artifact.diagnostics);
      }
    }
  }

  const alphaMap =
    materialInstance || !texture
      ? { texture: null, owned: false }
      : threeAlphaMapFromOpacitySource(
          texture,
          emitter.render.opacitySource,
          emitter.render.opacityInvert,
        );
  if (alphaMap.owned && alphaMap.texture) ownedTextures.push(alphaMap.texture);

  const effectiveBlend = resolveEffectiveParticleBlend(
    emitter.render.blend,
    materialBlend,
  );
  const materialOwnsBlend = materialBlendOverridesEmitter(effectiveBlend);
  // Masked cutout on the fixed-function path: a baked texture already carries
  // the binary alpha threshold (any non-zero alpha survives); an un-baked
  // Tier-1 masked material clips against the graph's clip value instead.
  const maskedAlphaTest = bakedTextureApplied
    ? 0.001
    : Math.max(
        0.001,
        materialGraph?.opacityMaskClipValue ?? DEFAULT_OPACITY_MASK_CLIP_VALUE,
      );
  const materialParams = {
    color: 0xffffff,
    map: texture ?? null,
    alphaMap: alphaMap.texture,
    opacity: 1,
    transparent: !materialOwnsBlend,
    alphaTest:
      effectiveBlend === "masked"
        ? maskedAlphaTest
        : alphaMap.texture
          ? 0.001
          : 0,
    depthTest: emitter.render.depthTest,
    depthWrite: materialOwnsBlend
      ? true
      : resolveParticleDepthWrite(emitter.render),
    blending: threeBlendingForEffectiveBlend(effectiveBlend),
    premultipliedAlpha: effectiveBlend === "premultiplied",
    side: threeSideForGraph(materialGraph),
  };
  const material =
    emitter.render.shading === "lit"
      ? new MeshStandardMaterial({
          ...materialParams,
          metalness: 0,
          roughness: 0.62,
        })
      : new MeshBasicMaterial(materialParams);

  return {
    material,
    ownedTextures,
    fixed,
    particleColorUsage,
    opacityIsConstantOne,
    materialBlend,
    missingMaterialRef,
    unsupportedFeatures,
    key,
  };
}

export function isThreeParticleMaterial(
  material: Material,
): material is ThreeParticleMaterial {
  return (
    material instanceof MeshBasicMaterial ||
    material instanceof MeshStandardMaterial ||
    material instanceof ShaderMaterial
  );
}

export function emitterTexturePath(
  emitter: ParticleEmitterDefinition,
  materialGraph?: ShaderGraph,
): string | null {
  const material = emitter.render.material;
  return material
    ? resolveEffectiveMainTexPath(materialGraph, material) ||
        emitter.render.texture
    : emitter.render.texture;
}

/**
 * The procedural-texture cache key for an assetless billboard emitter, or
 * null when the emitter resolves a real texture (or renders via a material).
 * Shared by the material key and the renderer's static view key so a
 * `billboard.shape`/`softness` edit rebuilds the view.
 */
export function emitterProceduralBillboardKey(
  emitter: ParticleEmitterDefinition,
  materialGraph?: ShaderGraph,
): string | null {
  if (emitter.mode !== "billboard") return null;
  if (emitter.render.material) return null;
  if (emitterTexturePath(emitter, materialGraph)) return null;
  return proceduralBillboardTextureKey(
    emitter.billboard.shape,
    emitter.billboard.softness,
  );
}

function resolveEmitterTexture(
  emitter: ParticleEmitterDefinition,
  options: ThreeVfxEffectInstanceOptions,
  materialGraph?: ShaderGraph,
): { texture: Texture | null; ownedTextures: Texture[] } {
  const path = emitterTexturePath(emitter, materialGraph);
  if (!path) {
    if (emitter.render.material) {
      const fallback = createFallbackMaterialTexture();
      return {
        texture: fallback,
        ownedTextures: fallback ? [fallback] : [],
      };
    }
    if (emitter.mode === "billboard") {
      // Engine contract: a null texture falls back to the procedural
      // billboard shape (see ParticleRenderSettings.texture). The texture is
      // cached/shared — never owned by the resolution.
      return {
        texture: getProceduralBillboardTexture(
          emitter.billboard.shape,
          emitter.billboard.softness,
        ),
        ownedTextures: [],
      };
    }
    return { texture: null, ownedTextures: [] };
  }
  return {
    texture:
      options.textureProvider?.getTexture(createTextureAssetRef(path)) ?? null,
    ownedTextures: [],
  };
}

function createBakedTexture(
  sourceTexture: Texture,
  graph: Parameters<typeof compileMaterial>[0],
  instance: Parameters<typeof compileMaterial>[1],
  options: ThreeVfxEffectInstanceOptions,
): Texture | null {
  const canvas = textureImageToCanvas(sourceTexture);
  if (!canvas) return null;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  bakeGraphInPlace(image.data, canvas.width, canvas.height, graph, instance, {
    samplerForPath: (path, uv) => sampleTexturePath(path, uv, options) ?? null,
  });
  context.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = sourceTexture.colorSpace;
  texture.flipY = sourceTexture.flipY;
  texture.wrapS = sourceTexture.wrapS;
  texture.wrapT = sourceTexture.wrapT;
  texture.minFilter = sourceTexture.minFilter;
  texture.magFilter = sourceTexture.magFilter;
  texture.generateMipmaps = sourceTexture.generateMipmaps;
  texture.needsUpdate = true;
  return texture;
}

function createThreeShaderMaterial(
  emitter: ParticleEmitterDefinition,
  mainTexture: Texture | null,
  graph: Parameters<typeof compileMaterial>[0],
  instance: Parameters<typeof compileMaterial>[1],
  artifact: ReturnType<typeof compileMaterial>,
  options: ThreeVfxEffectInstanceOptions,
): { material: ShaderMaterial; ownedTextures: Texture[] } | null {
  if (!canRenderTier2ParticleContainerShader(artifact)) return null;
  const compiled = createMaterialPreviewFragment({
    artifact,
    graph,
    instance,
  });
  if (!compiled) return null;
  const fixed = artifact.fixed ?? {
    tint: [1, 1, 1, 1] as [number, number, number, number],
    emissive: 0,
    opacity: 1,
    blend: graph.blend,
  };
  const samplerUniforms: Record<string, { value: Texture | null }> = {};
  for (const sampler of compiled.samplers) {
    samplerUniforms[sampler.uniform] = {
      value:
        options.textureProvider?.getTexture(
          createTextureAssetRef(sampler.path),
        ) ?? mainTexture,
    };
  }
  const effectiveBlend = resolveEffectiveParticleBlend(
    emitter.render.blend,
    artifact.blend,
  );
  const materialOwnsBlend = materialBlendOverridesEmitter(effectiveBlend);
  const material = new ShaderMaterial({
    vertexShader: THREE_PARTICLE_MATERIAL_VERTEX_SHADER,
    fragmentShader: compiled.fragment,
    uniforms: {
      uTexture: { value: mainTexture },
      uTime: { value: 0 },
      uFixedTint: { value: new Vector4(...fixed.tint) },
      uFixedEmissive: { value: Math.max(0, fixed.emissive) },
      uFixedOpacity: { value: fixed.opacity },
      uClipValue: { value: graph.opacityMaskClipValue ?? 0.333 },
      uSheetTiles: { value: new Vector2(...textureSheetTiles(emitter)) },
      uSubUv: { value: new Vector4(0, 0, 1, 1) },
      uSubUvFromAttr: { value: 0 },
      uParticleColor: { value: new Vector4(1, 1, 1, 1) },
      uDynamicParams: { value: new Vector4(0, 0, 0, 0) },
      ...samplerUniforms,
    },
    // Masked/opaque are material-authoritative cutout/opaque passes; they
    // legitimately bypass the I12-A opacity-constness gate (an explicit
    // Opaque material ignores alpha by definition, Masked discards instead).
    transparent: !materialOwnsBlend,
    depthTest: emitter.render.depthTest,
    // A live graph-driven opacity means no alpha value can prove the pixel
    // opaque — keep translucent depth semantics (I12-A).
    depthWrite: materialOwnsBlend
      ? true
      : artifact.opacityIsConstantOne
        ? resolveParticleDepthWrite(emitter.render)
        : false,
    blending: threeBlendingForEffectiveBlend(effectiveBlend),
    premultipliedAlpha: effectiveBlend === "premultiplied",
    side: threeSideForGraph(graph),
  });
  return { material, ownedTextures: [] };
}

function threeSideForGraph(graph: ShaderGraph | undefined): Side {
  if (graph?.side === "front") return FrontSide;
  if (graph?.side === "back") return BackSide;
  return DoubleSide;
}

const THREE_PARTICLE_MATERIAL_VERTEX_SHADER = `
varying vec2 vUV;
varying vec4 vColor;
uniform vec4 uParticleColor;
uniform vec4 uDynamicParams;

void main() {
  vUV = uv;
  vColor = vec4(uParticleColor.rgb * uParticleColor.a, uParticleColor.a);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function textureSheetTiles(
  emitter: ParticleEmitterDefinition,
): [number, number] {
  if (!emitter.modules.textureSheetAnimation) return [1, 1];
  const settings = emitter.advanced.textureSheetAnimation;
  return [
    Math.max(1, Math.round(settings.tiles[0])),
    Math.max(1, Math.round(settings.tiles[1])),
  ];
}

function createFallbackMaterialTexture(): Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1, 1);
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function sampleTexturePath(
  path: string,
  uv: [number, number],
  options: ThreeVfxEffectInstanceOptions,
) {
  const texture = options.textureProvider?.getTexture(
    createTextureAssetRef(path),
  );
  const canvas = texture ? textureImageToCanvas(texture) : null;
  if (!canvas) return null;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const x = Math.min(
    canvas.width - 1,
    Math.max(0, Math.round(uv[0] * (canvas.width - 1))),
  );
  const y = Math.min(
    canvas.height - 1,
    Math.max(0, Math.round(uv[1] * (canvas.height - 1))),
  );
  const data = context.getImageData(x, y, 1, 1).data;
  return [
    (data[0] ?? 0) / 255,
    (data[1] ?? 0) / 255,
    (data[2] ?? 0) / 255,
    (data[3] ?? 0) / 255,
  ] as [number, number, number, number];
}

function textureImageToCanvas(texture: Texture): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const image = texture.image as CanvasImageSource | undefined;
  const width = textureImageWidth(image);
  const height = textureImageHeight(image);
  if (!image || width <= 0 || height <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

function textureImageWidth(image: CanvasImageSource | undefined): number {
  if (!image) return 0;
  if ("naturalWidth" in image) return image.naturalWidth;
  if ("videoWidth" in image) return image.videoWidth;
  if ("displayWidth" in image) return image.displayWidth;
  return "width" in image ? numericImageDimension(image.width) : 0;
}

function textureImageHeight(image: CanvasImageSource | undefined): number {
  if (!image) return 0;
  if ("naturalHeight" in image) return image.naturalHeight;
  if ("videoHeight" in image) return image.videoHeight;
  if ("displayHeight" in image) return image.displayHeight;
  return "height" in image ? numericImageDimension(image.height) : 0;
}

function numericImageDimension(value: unknown): number {
  if (typeof value === "number") return value;
  if (
    value &&
    typeof value === "object" &&
    "baseVal" in value &&
    typeof (value as { baseVal?: { value?: unknown } }).baseVal?.value ===
      "number"
  ) {
    return (value as { baseVal: { value: number } }).baseVal.value;
  }
  return 0;
}
