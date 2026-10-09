import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Texture,
} from "three";
import type { Vec3 } from "../../engine/math";
import {
  resolveParticleDepthWrite,
  type ParticleEmitterDefinition,
} from "../../engine/particles";
import { reverseGeometryWinding } from "./geometryWinding";
import {
  ThreeInstancedBillboardView,
  canUseInstancedBillboard,
} from "./instancedBillboard";
import {
  createThreeEmitterMaterial,
  createThreeTrailMaterial,
  emitterProceduralBillboardKey,
  emitterTexturePath,
  isThreeParticleMaterial,
} from "./materialAdapter";
import { createThreeTextureFrameSet } from "./textureFrames";
import type { ThreeVfxEffectInstanceOptions } from "./types";

import type { ThreeEmitterView, ThreeViewBuildContext } from "./rendererState";
const BASE_QUAD_GEOMETRY = new PlaneGeometry(1, 1);
export function createEmitterView(
  emitter: ParticleEmitterDefinition,
  options: ThreeVfxEffectInstanceOptions,
  context: ThreeViewBuildContext,
): ThreeEmitterView {
  const cleanup: Array<() => void> = [];
  try {
    const meshAssetRender =
      emitter.mode === "mesh" && emitter.mesh.renderMode === "meshAsset";
    const meshAsset = meshAssetRender ? emitter.mesh.asset : null;
    // A host-injected render geometry overrides the authored asset — and also
    // works with no authored asset at all (host-only geometry).
    const meshGeometry = meshAssetRender
      ? (context.renderGeometryOverride?.geometry ??
        (meshAsset ? options.meshProvider?.getMeshGeometry(meshAsset) : null))
      : null;
    const geometry = meshGeometry ?? BASE_QUAD_GEOMETRY;
    const ownedGeometry =
      meshAssetRender &&
      (emitter.mesh.flipWinding || emitter.mesh.recomputeNormals)
        ? geometry.clone()
        : null;
    if (ownedGeometry) cleanup.push(() => ownedGeometry.dispose());
    const viewGeometry = ownedGeometry ?? geometry;
    if (ownedGeometry && emitter.mesh.flipWinding) {
      reverseGeometryWinding(ownedGeometry);
    }
    if (ownedGeometry && emitter.mesh.recomputeNormals) {
      ownedGeometry.computeVertexNormals();
    }
    const pivotBoundsSize = geometryBoundsSize(viewGeometry);
    const debugBounds = geometryDebugBounds(viewGeometry);
    // A host material (ThreeVfxMaterialProvider.getParticleMaterial) replaces
    // the whole built-in surface pipeline for this emitter: no texture frames,
    // no material graph, no instanced fast path — the host owns the look.
    const providedMaterial =
      options.materialProvider?.getParticleMaterial?.(
        context.effect,
        emitter.id,
      ) ?? null;
    if (options.renderAdapter && providedMaterial instanceof ShaderMaterial) {
      throw new Error(
        `Emitter "${emitter.id}": host ShaderMaterial uses GLSL. Supply a compatible node material or select legacy WebGL.`,
      );
    }
    const hostMaterial =
      providedMaterial && isThreeParticleMaterial(providedMaterial)
        ? providedMaterial
        : null;
    const material = options.renderAdapter
      ? options.renderAdapter.createMaterial(emitter, options, false)
      : createThreeEmitterMaterial(emitter, options);
    cleanup.push(() => {
      material.material.dispose();
      for (const texture of material.ownedTextures) texture.dispose();
    });
    if (hostMaterial) material.material.dispose();
    const sourceMap = hostMaterial
      ? null
      : material.material instanceof ShaderMaterial
        ? textureUniformValue(material.material, "uTexture")
        : material.material.map;
    const sourceAlphaMap =
      hostMaterial || material.material instanceof ShaderMaterial
        ? null
        : material.material.alphaMap;
    const textureFrames = createThreeTextureFrameSet(
      sourceMap,
      sourceAlphaMap,
      emitter,
      hostMaterial ? null : material.fixed,
    );
    cleanup.push(() => {
      for (const texture of textureFrames.ownedTextures) texture.dispose();
    });
    const instanced =
      options.renderAdapter && !hostMaterial
        ? options.renderAdapter.createInstances(viewGeometry, material, emitter)
        : !hostMaterial && canUseInstancedBillboard(emitter, sourceMap)
          ? new ThreeInstancedBillboardView(
              viewGeometry,
              sourceMap!,
              emitter.maxParticles,
              emitter,
            )
          : null;
    if (instanced) cleanup.push(() => instanced.dispose());
    const trailGeometry = new BufferGeometry();
    cleanup.push(() => trailGeometry.dispose());
    const trailResolution = options.renderAdapter
      ? options.renderAdapter.createMaterial(emitter, options, true)
      : createThreeTrailMaterial(emitter, options);
    if (trailResolution)
      cleanup.push(() => {
        trailResolution.material.dispose();
        for (const texture of trailResolution.ownedTextures) texture.dispose();
      });
    const trailMaterial =
      trailResolution?.material ??
      new MeshBasicMaterial({
        transparent: true,
        vertexColors: true,
        depthTest: emitter.render.depthTest,
        depthWrite: resolveParticleDepthWrite(emitter.render),
        blending:
          emitter.render.blend === "additive"
            ? AdditiveBlending
            : NormalBlending,
        premultipliedAlpha: emitter.render.blend === "premultiplied",
        side: DoubleSide,
      });
    const trailTextureFrames =
      trailResolution && !(trailMaterial instanceof ShaderMaterial)
        ? createThreeTextureFrameSet(
            trailMaterial.map,
            trailMaterial.alphaMap,
            {
              ...emitter,
              modules: { ...emitter.modules, textureSheetAnimation: false },
            },
            trailResolution.fixed,
          )
        : null;
    if (!trailResolution) cleanup.push(() => trailMaterial.dispose());
    if (trailTextureFrames)
      cleanup.push(() => {
        for (const texture of trailTextureFrames.ownedTextures)
          texture.dispose();
      });
    const trailMesh = new Mesh(trailGeometry, trailMaterial);
    trailMesh.frustumCulled = false;
    trailMesh.visible = false;
    return {
      key: emitterViewKey(emitter, hostMaterial ? "host" : material.key),
      staticKey: emitterStaticViewKey(emitter, options, context),
      meshes: [],
      instanced,
      particleOrder: new Uint32Array(Math.max(1, emitter.maxParticles)),
      geometry: viewGeometry,
      ownedGeometry,
      pivotBoundsSize,
      debugBounds,
      trailMesh,
      trailGeometry,
      trailMaterial,
      trailResolution,
      trailTextureFrames,
      trailHistories: new Map(),
      trailEmitterPosition: [0, 0, 0],
      material: hostMaterial ?? material.material,
      ownedTextures: [
        ...material.ownedTextures,
        ...textureFrames.ownedTextures,
        ...(trailResolution?.ownedTextures ?? []),
        ...(trailTextureFrames?.ownedTextures ?? []),
      ],
      textureFrames,
      materialFixed: hostMaterial ? null : material.fixed,
      materialParticleColorUsage: hostMaterial
        ? { rgb: true, alpha: true }
        : material.particleColorUsage,
      materialOpacityIsConstantOne: hostMaterial
        ? false
        : material.opacityIsConstantOne,
      materialBlend: hostMaterial ? null : material.materialBlend,
      missingMaterialRef: hostMaterial ? null : material.missingMaterialRef,
      unsupportedFeatures: [
        ...material.unsupportedFeatures,
        ...(trailResolution?.unsupportedFeatures ?? []),
      ],
      hostMaterial: hostMaterial !== null,
    };
  } catch (error) {
    for (const release of cleanup.reverse()) release();
    throw error;
  }
}

export function textureUniformValue(
  material: ShaderMaterial,
  uniformName: string,
): Texture | null {
  const value = material.uniforms[uniformName]?.value;
  return value && value instanceof Texture ? value : null;
}

export function geometryBoundsSize(geometry: BufferGeometry): Vec3 {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return [1, 1, 0];
  return [
    Math.max(0, box.max.x - box.min.x),
    Math.max(0, box.max.y - box.min.y),
    Math.max(0, box.max.z - box.min.z),
  ];
}

export function geometryDebugBounds(geometry: BufferGeometry): {
  min: Vec3;
  max: Vec3;
} {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] };
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

// Definitions and provider graphs are immutable snapshots. Cache their keys so
// ensureViews does not serialize a whole graph in every animation frame.
const materialViewKeys = new WeakMap<object, string>();
export function cachedMaterialKey(value: object | null | undefined): string {
  if (!value) return "";
  let key = materialViewKeys.get(value);
  if (key === undefined) {
    key = JSON.stringify(value);
    materialViewKeys.set(value, key);
  }
  return key;
}

const materialGraphViewIds = new WeakMap<object, number>();
let nextMaterialGraphViewId = 1;
export function materialGraphViewKey(graph: object | undefined): number {
  if (!graph) return 0;
  let id = materialGraphViewIds.get(graph);
  if (id === undefined) {
    id = nextMaterialGraphViewId++;
    materialGraphViewIds.set(graph, id);
  }
  return id;
}

export function emitterStaticViewKey(
  emitter: ParticleEmitterDefinition,
  options: ThreeVfxEffectInstanceOptions,
  context: ThreeViewBuildContext,
): string {
  const materialGraph = emitter.render.material
    ? options.materialGraphProvider?.(emitter.render.material.shaderId)
    : undefined;
  const hostMaterial = options.materialProvider?.getParticleMaterial?.(
    context.effect,
    emitter.id,
  );
  return [
    emitter.mode,
    emitter.maxParticles,
    emitter.mesh.renderMode,
    emitter.mesh.asset?.path ?? "",
    // Host injections are part of the view identity: a swapped render
    // geometry bumps its generation, and a (re)provided host material keys by
    // uuid, so stale views can never survive an injection change.
    context.renderGeometryOverride
      ? `hostgeo:${context.renderGeometryOverride.generation}`
      : "",
    hostMaterial ? `hostmat:${hostMaterial.uuid}` : "",
    Number(emitter.mesh.flipWinding),
    Number(emitter.mesh.recomputeNormals),
    emitterTexturePath(emitter) ?? emitterProceduralBillboardKey(emitter) ?? "",
    emitter.render.material?.shaderId ?? "",
    cachedMaterialKey(emitter.advanced.trails.material),
    emitter.advanced.trails.material
      ? JSON.stringify([
          emitter.advanced.trails.texture,
          emitter.advanced.trails.textureMode,
          emitter.advanced.trails.depthTest,
          emitter.advanced.trails.depthWrite,
          materialGraphViewKey(
            options.materialGraphProvider?.(
              emitter.advanced.trails.material.shaderId,
            ),
          ),
        ])
      : "",
    materialGraph?.side ?? "double",
    materialGraph?.blend ?? "normal",
    emitter.render.shading,
    emitter.render.blend,
    Number(emitter.render.depthTest),
    Number(resolveParticleDepthWrite(emitter.render)),
  ].join("|");
}

export function emitterViewKey(
  emitter: ParticleEmitterDefinition,
  materialKey: string,
): string {
  return [
    emitter.mode,
    emitter.maxParticles,
    emitter.mesh.renderMode,
    emitter.mesh.asset?.path ?? "",
    Number(emitter.mesh.flipWinding),
    Number(emitter.mesh.recomputeNormals),
    materialKey,
    emitter.render.shading,
    emitter.render.blend,
    Number(emitter.render.depthTest),
    Number(resolveParticleDepthWrite(emitter.render)),
  ].join("|");
}

export function hideViewMeshes(
  view: ThreeEmitterView,
  visibleCount: number,
): void {
  for (let i = visibleCount; i < view.meshes.length; i++) {
    const mesh = view.meshes[i];
    if (mesh) mesh.visible = false;
  }
}

export function destroyEmitterView(view: ThreeEmitterView): void {
  for (const mesh of view.meshes) {
    mesh.removeFromParent();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) material.dispose();
    } else {
      mesh.material.dispose();
    }
  }
  view.meshes.length = 0;
  view.instanced?.dispose();
  view.trailMesh.removeFromParent();
  view.trailGeometry.dispose();
  view.trailMaterial.dispose();
  view.trailHistories.clear();
  if (!view.hostMaterial) view.material.dispose();
  view.ownedGeometry?.dispose();
  for (const texture of view.ownedTextures) texture.dispose();
  view.ownedTextures.length = 0;
}
