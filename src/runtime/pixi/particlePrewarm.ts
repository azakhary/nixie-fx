import type {
  ParticleEmitterDefinition,
  ParticleScalarValue,
} from "../../engine/particles";

/**
 * Steady-state particle count an emitter is authored to keep alive, capped by
 * the simulation limit. Used to pre-allocate the render pool at view-build time
 * so the first seconds of playback do not allocate a `Particle` per frame.
 * Unusual weighted-curve overshoot may still grow the retained pool, up to the
 * same `maxParticles` limit.
 */
export function particlePrewarmCapacity(
  emitter: ParticleEmitterDefinition,
): number {
  if (!emitter.enabled) return 0;
  const lifetime = Math.max(
    0,
    scalarUpperBound(emitter.initializeParticle.lifetime),
  );
  const rateWindow = emitter.loop
    ? lifetime
    : Math.min(lifetime, emitter.duration);
  let bursts = 0;
  for (const burst of emitter.spawn.bursts)
    bursts += burst.count * burst.cycles;
  // A particle may survive across loop boundaries. Account for overlapping cycles.
  if (emitter.loop) {
    bursts *= Math.max(
      1,
      Math.ceil(lifetime / Math.max(0.001, emitter.duration)),
    );
  }
  return Math.min(
    emitter.maxParticles,
    Math.ceil(
      Math.max(0, scalarUpperBound(emitter.spawn.rateValue)) * rateWindow,
    ) + bursts,
  );
}

function scalarUpperBound(value: ParticleScalarValue): number {
  if (value.mode === "constant") return value.value;
  if (value.mode === "random") return Math.max(value.min, value.max);
  let bound = 0;
  for (const point of value.curve) bound = Math.max(bound, point.y);
  if (value.mode === "randomCurve") {
    for (const point of value.curveB) bound = Math.max(bound, point.y);
  }
  return bound * (value.multiplier ?? 1);
}
