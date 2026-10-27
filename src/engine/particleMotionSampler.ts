import type { Vec3 } from "./math";
import type {
  ParticleEmitterDefinition,
  ParticleEmitterRuntimeState,
  ParticleMotionResult,
} from "./particles";

/**
 * State-scoped replacement for analytic particle motion. A host binds one to an
 * emitter state when it owns a stepped integrator (for example a Unity-matched
 * limiter); draws, lights and trails then read the same sampled trajectory.
 * Default behavior is unchanged while no sampler is bound.
 */
export interface ParticleMotionSampler {
  /** Skip the spawn-time Limit Velocity damping; the sampler applies it instead. */
  readonly preserveInitialVelocity?: boolean;
  /** Called when the bound state resets (restart, rewind); clear integration history. */
  reset?(): void;
  /** Called once per runner update after the emitter's particles were advanced. */
  advance?(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    deltaSeconds: number,
    timeSeconds: number,
    initialVelocityMultiplier: number,
  ): void;
  /** Write simulation-space motion into `out` and return true, or false to use analytic motion. */
  sample(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    particleIndex: number,
    ageSeconds: number,
    normalizedAge: number,
    currentEmitterPosition: Vec3 | undefined,
    out: ParticleMotionResult,
    initialVelocityMultiplier: number,
  ): boolean;
}
