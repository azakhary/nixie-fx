import type { ParticleEffectDefinition } from "../../engine/particles";
import type { VfxMeshAssetRef } from "./types";

export function collectParticleMeshRefs(
  effect: ParticleEffectDefinition,
): VfxMeshAssetRef[] {
  const refsByPath = new Map<string, VfxMeshAssetRef>();
  const usedIds = new Set<string>();

  for (const emitter of effect.emitters) {
    const renderRef =
      emitter.mesh.renderMode === "meshAsset" ? emitter.mesh.asset : null;
    const emissionRef =
      emitter.spawn.shape === "mesh" ? emitter.spawn.meshAsset : null;
    for (const ref of [renderRef, emissionRef]) {
      if (!ref || refsByPath.has(ref.path)) continue;
      refsByPath.set(ref.path, {
        ...ref,
        id: createUniqueMeshAssetId(ref.id || ref.path, usedIds),
      });
    }
  }

  return [...refsByPath.values()];
}

function createUniqueMeshAssetId(
  baseValue: string,
  usedIds: Set<string>,
): string {
  const base = meshAssetIdFromPath(baseValue);
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix++;
  }
  usedIds.add(id);
  return id;
}

export function meshAssetIdFromPath(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mesh";
}
