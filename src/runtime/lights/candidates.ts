import type { Vec3 } from "../../engine/math";
import {
  sampleParticleGradientColor,
  sampleParticleGradientAlpha,
  sampleParticleScalarValue,
  type ParticleLightEmissionSettings,
} from "../../engine/particles";

export interface VfxLightCandidate {
  /** Producer-instance prefix + emitter id + persistent particle id (or origin). */
  id: string;
  position: Vec3;
  color: Vec3;
  intensity: number;
  radius: number;
}
/** Narrow synchronous snapshot contract. Future GPU producers may publish completed readbacks here. */
export interface VfxLightProducer {
  readonly lightRevision: number;
  readonly lightsPaused: boolean;
  getLightCandidates(): readonly VfxLightCandidate[];
}
let nextInstance = 0;
export function createVfxLightInstanceId(): string {
  return `vfx-${++nextInstance}`;
}

/** Reuses the normal curve axes: lifetime = particle age, or loop age for emitter mode. */
export function evaluateVfxLight(
  settings: ParticleLightEmissionSettings,
  id: string,
  position: Vec3,
  age: number,
  loopAge: number,
  seed: number,
): VfxLightCandidate | null {
  if (
    settings.version !== 1 ||
    settings.mode === "disabled" ||
    settings.maxLights === 0
  )
    return null;
  const color = sampleParticleGradientColor(settings.color, age);
  const intensity =
    sampleParticleScalarValue(settings.intensity, age, seed, loopAge) *
    sampleParticleGradientAlpha(settings.color, age);
  const radius = sampleParticleScalarValue(settings.radius, age, seed, loopAge);
  if (
    !Number.isFinite(intensity) ||
    intensity <= 0 ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    !position.every(Number.isFinite) ||
    !color.every(Number.isFinite)
  )
    return null;
  return { id, position: [...position], color: [...color], intensity, radius };
}
