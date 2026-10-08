import { Vector3, type Object3D, type Scene } from "three";
import type { Vec3 } from "../../engine/math";
import type {
  ParticleEmitterDefinition,
  ParticleEmitterRuntimeState,
} from "../../engine/particles";
import {
  createVfxLightInstanceId,
  evaluateVfxLight,
  type VfxLightCandidate,
} from "../lights/candidates";
import type { ParticleSample } from "./rendererState";

/** Collects optional light producers separately from rendering surfaces. */
export class ThreeEffectLightCandidates {
  startedAt = 0;
  private readonly instanceId = createVfxLightInstanceId();
  private readonly candidates: VfxLightCandidate[] = [];
  private readonly worldCandidates: VfxLightCandidate[] = [];
  private readonly scratchWorld = new Vector3();
  private particleCutoff = Infinity;
  constructor(private readonly root: Object3D) {}

  clear(): void {
    this.candidates.length = 0;
  }

  getWorldCandidates(): readonly VfxLightCandidate[] {
    this.worldCandidates.length = 0;
    if (!this.root.parent) return this.worldCandidates;
    let attachedToScene = false;
    for (let node: Object3D | null = this.root; node; node = node.parent) {
      if (!node.visible) return this.worldCandidates;
      if ((node as Scene).isScene) attachedToScene = true;
    }
    if (!attachedToScene) return this.worldCandidates;
    this.root.updateWorldMatrix(true, false);
    for (const candidate of this.candidates) {
      this.scratchWorld
        .fromArray(candidate.position)
        .applyMatrix4(this.root.matrixWorld);
      this.worldCandidates.push({
        ...candidate,
        position: this.scratchWorld.toArray(),
      });
    }
    return this.worldCandidates;
  }

  beginEmitter(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    timeSeconds: number,
    active: boolean,
  ): void {
    const light = emitter.lightEmission;
    this.particleCutoff = Infinity;
    if (
      light?.enabled !== false &&
      light?.mode === "particles" &&
      light.maxLights !== null
    ) {
      const ids = Array.from(
        state.particleIds.subarray(0, state.activeCount),
      ).sort((a, b) => a - b);
      this.particleCutoff =
        light.maxLights > 0 ? (ids[light.maxLights - 1] ?? Infinity) : -1;
    }
    if (
      light?.enabled !== false &&
      light?.mode === "emitter" &&
      timeSeconds - this.startedAt >= emitter.timeline.start &&
      state.age >= 0 &&
      (emitter.loop || state.age <= emitter.duration) &&
      active
    ) {
      const loopAge = Math.min(1, Math.max(0, state.age / emitter.duration));
      const candidate = evaluateVfxLight(
        light,
        `${this.instanceId}/${emitter.id}/origin`,
        emitter.spawn.position,
        loopAge,
        loopAge,
        state.loopRandom,
      );
      if (candidate) this.candidates.push(candidate);
    }
  }

  addParticle(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    particleIndex: number,
    sample: ParticleSample,
    position: Vec3,
  ): void {
    if (
      emitter.lightEmission?.enabled !== false &&
      emitter.lightEmission?.mode === "particles" &&
      state.particleIds[particleIndex]! <= this.particleCutoff
    ) {
      const candidate = evaluateVfxLight(
        emitter.lightEmission,
        `${this.instanceId}/${emitter.id}/${state.particleIds[particleIndex]}`,
        [
          sample.position[0] - position[0],
          sample.position[1] - position[1],
          sample.position[2] - position[2],
        ],
        sample.normalizedAge,
        sample.loopAge,
        sample.seed,
        sample.lightColor,
      );
      if (candidate) this.candidates.push(candidate);
    }
  }
}
