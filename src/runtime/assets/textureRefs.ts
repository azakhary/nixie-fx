import type { ParticleEffectDefinition } from "../../engine/particles";
import {
  resolveEffectiveMainTexPath,
  resolveMaterialTextureNodeBinding,
  type ShaderGraph,
} from "../schema/materials";
import type { VfxTextureAssetRef } from "./types";

export interface CollectParticleTextureRefsOptions {
  materialGraphProvider?: (shaderId: string) => ShaderGraph | undefined;
}

export function collectParticleTextureRefs(
  effect: ParticleEffectDefinition,
  options: CollectParticleTextureRefsOptions = {},
): VfxTextureAssetRef[] {
  const refsByPath = new Map<string, VfxTextureAssetRef>();
  const usedIds = new Set<string>();

  const addPath = (path: string | null): void => {
    if (!path || refsByPath.has(path)) return;
    refsByPath.set(path, createUniqueTextureAssetRef(path, usedIds));
  };

  for (const emitter of effect.emitters) {
    addPath(emitter.render.texture);
    // A material's MainTex feeds the shared container texture (techspec §8), so
    // it must be collected for export exactly like `render.texture`.
    const material = emitter.render.material;
    const graph = material
      ? options.materialGraphProvider?.(material.shaderId)
      : undefined;
    addPath(
      material ? resolveEffectiveMainTexPath(graph, material) || null : null,
    );
    if (material && graph) {
      for (const path of collectMaterialTextureNodePaths(graph, material)) {
        addPath(path);
      }
    }
    if (emitter.modules.trails) addPath(emitter.advanced.trails.texture);
  }

  return [...refsByPath.values()];
}

export function collectMaterialTextureNodePaths(
  graph: ShaderGraph,
  instance: NonNullable<
    ParticleEffectDefinition["emitters"][number]["render"]["material"]
  >,
): string[] {
  const paths = new Set<string>();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  for (const node of graph.nodes) {
    if (
      node.type !== "textureSample" &&
      node.type !== "particleSubUV" &&
      node.type !== "antialiasedTextureMask"
    ) {
      continue;
    }
    const binding = resolveMaterialTextureNodeBinding(
      graph,
      instance,
      node,
      nodeById,
      edgeById,
    );
    if (binding.path && !binding.isMainTex) paths.add(binding.path);
  }
  return [...paths];
}

export function createTextureAssetRef(path: string): VfxTextureAssetRef {
  return { type: "texture", id: textureAssetIdFromPath(path), path };
}

function createUniqueTextureAssetRef(
  path: string,
  usedIds: Set<string>,
): VfxTextureAssetRef {
  const base = textureAssetIdFromPath(path);
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix++;
  }
  usedIds.add(id);
  return { type: "texture", id, path };
}

function textureAssetIdFromPath(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "texture";
}
