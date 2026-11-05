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
  readonly computeCapabilities?: import("../../engine/particleSimulation").ParticleComputeCapabilities;
  createGpuEmitter?(
    emitter: ParticleEmitterDefinition,
    options: ThreeVfxEffectInstanceOptions,
  ): ThreeGpuEmitter;
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

export interface ThreeGpuEmitter {
  readonly root: import("three").Object3D;
  readonly capacity: number;
  readonly lightSource?: import("./gpu/lights").ThreeGpuLightSource;
  readonly active: boolean;
  readonly estimatedCount: number;
  reset(seed: number, startedAt?: number): void;
  resumeEmission(): void;
  setRuntimeParameters(
    parameters: import("./types").ThreeVfxEmitterRuntimeParameterPatch,
    emitterScoped?: boolean,
  ): void;
  update(dt: number, time: number, transform: import("three").Matrix4): void;
  allowCompletion(): void;
  dispose(): void;
}
