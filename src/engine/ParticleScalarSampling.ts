import { sampleParticleCurve } from "./ParticleCurve";
import { integrateParticleCurve } from "./ParticleCurveIntegral";
import type { ParticleScalarValue } from "./particles";

function sampleParticleScalarValueAtTime(
  value: ParticleScalarValue,
  time: number,
  mix: number,
): number {
  if (value.mode === "random") {
    return value.min + (value.max - value.min) * mix;
  }
  const multiplier = value.multiplier ?? 1;
  if (value.mode === "curve") {
    return sampleParticleCurve(value.curve, time) * multiplier;
  }
  if (value.mode === "randomCurve") {
    const a = sampleParticleCurve(value.curve, time);
    const b = sampleParticleCurve(value.curveB, time);
    return (a + (b - a) * mix) * multiplier;
  }
  return value.value;
}

export function sampleParticleScalarValue(
  value: ParticleScalarValue,
  t: number,
  random: number,
  loopAgeT?: number,
): number {
  // `t` is the default (normalized lifetime) axis. When the curve opts into the
  // loop-age axis and the caller supplied it, sample against that instead.
  const axisT =
    value.xAxis === "loopAge" && loopAgeT !== undefined ? loopAgeT : t;
  const time = clampNumber(axisT, 0, 1);
  const mix = clampNumber(random, 0, 1);
  return sampleParticleScalarValueAtTime(value, time, mix);
}

export function integrateParticleScalarValue(
  value: ParticleScalarValue,
  t: number,
  random: number,
  loopAgeT?: number,
): number {
  const axisT =
    value.xAxis === "loopAge" && loopAgeT !== undefined ? loopAgeT : t;
  const end = clampNumber(axisT, 0, 1);
  const mix = clampNumber(random, 0, 1);
  if (end <= 0) return 0;
  if (value.mode === "random") {
    return (value.min + (value.max - value.min) * mix) * end;
  }
  if (value.mode === "constant") {
    return value.value * end;
  }
  // The curve integrals are evaluated in closed form per segment and then
  // mixed, which is exact for the same trapezoid rule the per-sample loop ran:
  // the rule is linear in the sampled values, so mixing and the multiplier can
  // be hoisted out of the sum.
  const a = integrateParticleCurve(value.curve, end);
  const b =
    value.mode === "randomCurve"
      ? integrateParticleCurve(value.curveB, end)
      : a;
  return (a + (b - a) * mix) * (value.multiplier ?? 1);
}

export function sampleParticleScalarValueIntegralAverage(
  value: ParticleScalarValue,
  t: number,
  random: number,
  loopAgeT?: number,
): number {
  const axisT =
    value.xAxis === "loopAge" && loopAgeT !== undefined ? loopAgeT : t;
  const end = clampNumber(axisT, 0, 1);
  if (end <= 0) return sampleParticleScalarValue(value, t, random, loopAgeT);
  return integrateParticleScalarValue(value, t, random, loopAgeT) / end;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
