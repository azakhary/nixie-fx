import type { BufferGeometry, Color, InstancedMesh, Matrix4 } from "three";
import type { ParticleEmitterDefinition } from "../../engine/particles";
import type { ThreeEmitterMaterialResolution } from "./materialAdapter";
import type { ParticleSample } from "./rendererState";
import type { ThreeVfxEffectInstanceOptions } from "./types";

/** Draw-only extension; simulation, sample preparation and light candidates stay shared. */
export interface ThreeVfxInstancedView {
  readonly mesh: InstancedMesh;
  setRenderState(emitter: ParticleEmitterDefinition): void;
  write(
    index: number,
    matrix: Matrix4,
    color: Color,
    alpha: number,
    cameraDistanceSquared?: number,
    sample?: ParticleSample,
    emitter?: ParticleEmitterDefinition,
  ): void;
  updateTime?(timeSeconds: number): void;
  sortByCameraDistance(count: number, farFirst: boolean): void;
  commit(count: number): void;
  setRenderOrder(order: number): void;
  dispose(): void;
}
export interface ThreeVfxRenderAdapter {
  createMaterial(
    emitter: ParticleEmitterDefinition,
    options: ThreeVfxEffectInstanceOptions,
    trail: boolean,
  ): ThreeEmitterMaterialResolution;
  createInstances(
    geometry: BufferGeometry,
    resolution: ThreeEmitterMaterialResolution,
    emitter: ParticleEmitterDefinition,
  ): ThreeVfxInstancedView;
}
