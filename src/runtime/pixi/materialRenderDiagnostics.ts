import type { ParticleEmitterDefinition } from "../../engine/particles";
import type { MaterialArtifact } from "../materials";
import type { PixiVfxUnsupportedFeature } from "./types";

export type PixiVfxMaterialRenderBlock =
  | {
      kind: "missing-material-graph";
      shaderId: string;
      reason: string;
    }
  | {
      kind: "unsupported-tier2-particle-shader";
      shaderId: string;
      artifactShaderId: string;
      diagnostics: string[];
      reason: string;
    };

export function createMissingMaterialGraphBlock(
  shaderId: string,
): PixiVfxMaterialRenderBlock {
  return {
    kind: "missing-material-graph",
    shaderId,
    reason: `Material shader "${shaderId}" could not be resolved to a ShaderGraph.`,
  };
}

export function createUnsupportedTier2MaterialBlock(
  shaderId: string,
  artifact: MaterialArtifact,
): PixiVfxMaterialRenderBlock {
  const diagnostics = artifact.diagnostics.filter(Boolean);
  return {
    kind: "unsupported-tier2-particle-shader",
    shaderId,
    artifactShaderId: artifact.shaderId,
    diagnostics,
    reason:
      diagnostics[0] ??
      `Material shader "${shaderId}" compiled to a Tier-2 variant the Pixi ParticleContainer runtime cannot render.`,
  };
}

export function materialRenderBlockKey(
  block: PixiVfxMaterialRenderBlock | null | undefined,
): string {
  if (!block) return "";
  if (block.kind === "missing-material-graph") {
    return `materialBlocked:missing:${block.shaderId}`;
  }
  return `materialBlocked:unsupported-tier2:${block.shaderId}:${block.artifactShaderId}:${block.diagnostics.join(";")}`;
}

export function materialRenderBlockMissingRef(
  block: PixiVfxMaterialRenderBlock | null | undefined,
): string | undefined {
  return block?.kind === "missing-material-graph" ? block.shaderId : undefined;
}

export function materialRenderBlockUnsupportedFeature(
  block: PixiVfxMaterialRenderBlock | null | undefined,
  emitter: ParticleEmitterDefinition,
  emitterIndex: number,
): PixiVfxUnsupportedFeature | undefined {
  if (!block || block.kind === "missing-material-graph") return undefined;
  return {
    emitterId: emitter.id,
    emitterIndex,
    featureKey: "render.material.tier2ParticleShader",
    path: `emitters.${emitterIndex}.render.material`,
    reason: block.reason,
  };
}
