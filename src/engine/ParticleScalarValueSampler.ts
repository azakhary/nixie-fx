import { ParticleCurveSampler } from "./ParticleCurve";
import type { ParticleScalarValue } from "./particles";

/**
 * Setup-time snapshot of a scalar value, for hosts that sample the same value
 * for many particles every frame. Resolving the mode, the multiplier, the
 * x-axis and the curve control points happens once here instead of on every
 * sample; results are identical to `sampleParticleScalarValue`.
 *
 * The snapshot does not observe later edits to the source value: build a new
 * sampler when the definition changes.
 */
export class ParticleScalarValueSampler {
  private readonly mode: ParticleScalarValue["mode"];
  private readonly value: number;
  private readonly min: number;
  private readonly max: number;
  private readonly multiplier: number;
  private readonly loopAge: boolean;
  private readonly curve: ParticleCurveSampler | null;
  private readonly curveB: ParticleCurveSampler | null;

  constructor(value: ParticleScalarValue) {
    this.mode = value.mode;
    this.value = value.value;
    this.min = value.min;
    this.max = value.max;
    this.multiplier = value.multiplier ?? 1;
    this.loopAge = value.xAxis === "loopAge";
    this.curve =
      value.mode === "curve" || value.mode === "randomCurve"
        ? new ParticleCurveSampler(value.curve)
        : null;
    this.curveB =
      value.mode === "randomCurve"
        ? new ParticleCurveSampler(value.curveB)
        : null;
  }

  sample(t: number, random: number, loopAge?: number): number {
    if (this.mode === "constant") return this.value;
    const mix = Math.min(1, Math.max(0, random));
    if (this.mode === "random") return this.min + (this.max - this.min) * mix;
    const time = this.loopAge && loopAge !== undefined ? loopAge : t;
    const a = this.curve!.sample(time);
    if (this.mode === "curve") return a * this.multiplier;
    const b = this.curveB!.sample(time);
    return (a + (b - a) * mix) * this.multiplier;
  }
}
