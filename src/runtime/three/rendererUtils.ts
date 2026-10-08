import { Vector3 } from "three";
import type { Vec3 } from "../../engine/math";
import {
  PARTICLE_INSTANCE_STRIDE,
  type ParticleEmitterDefinition,
  type ParticleEmitterRuntimeState,
} from "../../engine/particles";
import {
  PARTICLE_ALIGNMENT_AXIS,
  PARTICLE_FRONT_AXIS,
} from "../particleOrientation";
import type { ThreeVfxEffectStats } from "./types";

import type { ThreeEmitterDrawResult } from "./rendererState";
const DEFAULT_SEED = 0x7f4a7c15;
export const DEFAULT_NORMAL = new Vector3(...PARTICLE_FRONT_AXIS);
export const DEFAULT_UP = new Vector3(...PARTICLE_ALIGNMENT_AXIS);
export function createEmptyEffectStats(): ThreeVfxEffectStats {
  return {
    activeParticles: 0,
    visibleParticles: 0,
    capacity: 0,
    emittedLastFrame: 0,
    bloomSourceParticles: 0,
    drawCalls: 0,
    instancedDrawCalls: 0,
    legacyParticleDrawCalls: 0,
    missingMeshRefs: [],
    missingMaterialRefs: [],
    unsupportedFeatures: [],
  };
}

export function emptyEmitterDrawResult(): ThreeEmitterDrawResult {
  return {
    visibleParticles: 0,
    bloomSourceParticles: 0,
    drawCalls: 0,
    instancedDrawCalls: 0,
    legacyParticleDrawCalls: 0,
  };
}

export function normalizeOr(value: Vector3, fallback: Vector3): Vector3 {
  return value.lengthSq() > 0.000001 ? value.normalize() : value.copy(fallback);
}

export function perpendicularUnitVector(value: Vector3, out: Vector3): Vector3 {
  if (Math.abs(value.y) < 0.9) {
    out.set(0, 1, 0);
  } else {
    out.set(1, 0, 0);
  }
  return out.cross(value).normalize();
}

export function copyVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

export function clampTintChannel(value: number): number {
  // Allow >1 for HDR-ish boosts, but keep it sane and non-negative.
  return Number.isFinite(value) ? Math.min(8, Math.max(0, value)) : 1;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeSeed(value: number | undefined): number {
  return Number.isFinite(value) ? Math.floor(value as number) : DEFAULT_SEED;
}

export function updateEmitterLayerRanks(
  emitters: readonly ParticleEmitterDefinition[],
  out: number[],
): void {
  out.length = emitters.length;
  const ranked = emitters.map((emitter, index) => ({
    index,
    orderInLayer: emitter.render.orderInLayer,
  }));
  ranked.sort((a, b) => a.orderInLayer - b.orderInLayer || a.index - b.index);
  let layerRank = -1;
  let previousOrder: number | null = null;
  for (const item of ranked) {
    if (previousOrder === null || item.orderInLayer !== previousOrder) {
      layerRank += 1;
      previousOrder = item.orderInLayer;
    }
    out[item.index] = layerRank;
  }
}

export function renderOrderForParticleSortMode(
  emitterRank: number,
  sortMode: ParticleEmitterDefinition["render"]["sortMode"],
  distanceSquared: number,
  start: number,
): number {
  const base = emitterRank;
  switch (sortMode) {
    case "distanceNearFirst":
      return (
        base +
        Math.min(
          0.999999,
          Math.max(0, distanceSquared) / (1 + Math.max(0, distanceSquared)),
        )
      );
    case "oldestFirst":
      return base + 0.5 - 0.499999 * Math.tanh(start);
    case "youngestFirst":
      return base + 0.5 + 0.499999 * Math.tanh(start);
    case "none":
    case "distanceFarFirst":
    default:
      return base;
  }
}

export function updateInstancedParticleOrder(
  state: Pick<ParticleEmitterRuntimeState, "activeCount" | "instanceData">,
  sortMode: ParticleEmitterDefinition["render"]["sortMode"],
  out: Uint32Array,
): void {
  const count = Math.min(state.activeCount, out.length);
  for (let i = 0; i < count; i++) out[i] = i;
  if (sortMode !== "oldestFirst" && sortMode !== "youngestFirst") return;
  // Age sorts pre-order the write order by spawn time; distance sorts are
  // handled after sampling (ThreeInstancedBillboardView.sortByCameraDistance)
  // because particle positions are only known once each sample is evaluated.
  const drawLaterThan =
    sortMode === "oldestFirst"
      ? (previousStart: number, start: number) => previousStart > start
      : (previousStart: number, start: number) => previousStart < start;
  const data = state.instanceData;
  for (let i = 1; i < count; i++) {
    const index = out[i] ?? i;
    const start = data[index * PARTICLE_INSTANCE_STRIDE + 3] ?? 0;
    let insertAt = i;
    while (insertAt > 0) {
      const previousIndex = out[insertAt - 1] ?? insertAt - 1;
      const previousStart =
        data[previousIndex * PARTICLE_INSTANCE_STRIDE + 3] ?? 0;
      if (!drawLaterThan(previousStart, start)) break;
      out[insertAt] = previousIndex;
      insertAt -= 1;
    }
    out[insertAt] = index;
  }
}
