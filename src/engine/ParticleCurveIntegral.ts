import {
  prepareParticleCurve,
  samplePreparedParticleCurve,
  samplePreparedParticleCurveSegment,
  type PreparedParticleCurveSegment,
} from "./ParticleCurve";
import type { ParticleCurvePoint } from "./particles";

/** Trapezoid steps per unit of curve x. Unchanged from the sampled integral. */
export const PARTICLE_SCALAR_INTEGRAL_STEPS = 64;

/**
 * Area under a curve on [0, end].
 *
 * This is the same 64-step trapezoid rule the runtime has always used, not a
 * LUT and not a different integration rule: each segment's sample sequence is
 * summed algebraically from the segment's cubic coefficients, so no per-step
 * Bezier evaluation is needed. Segments with weighted x handles do not have a
 * linear x-parameterization, so those keep the original per-sample solve.
 */
export function integrateParticleCurve(
  points: readonly ParticleCurvePoint[],
  end: number,
): number {
  const curve = prepareParticleCurve(points);
  const steps = Math.max(1, Math.ceil(end * PARTICLE_SCALAR_INTEGRAL_STEPS));
  const step = end / steps;
  // Trapezoid rule: the endpoints count half, the interior samples once.
  let sum = (curve.firstY + samplePreparedParticleCurve(curve, end)) * 0.5;
  let first = 1;
  for (const segment of curve.segments) {
    if (first >= steps) break;
    let last = Math.min(steps - 1, Math.floor(segment.end / step));
    // Match the old boundary comparison despite division roundoff.
    if (last >= first && (end * last) / steps > segment.end) last--;
    if (last + 1 < steps && (end * (last + 1)) / steps <= segment.end) last++;
    if (last < first) continue;
    if (segment.linearX && segment.end - segment.start >= 0.000001) {
      sum += sumCubicSamples(
        segment,
        (end * first) / steps,
        step,
        last - first + 1,
      );
    } else {
      for (let i = first; i <= last; i++) {
        sum += samplePreparedParticleCurveSegment(segment, (end * i) / steps);
      }
    }
    first = last + 1;
  }
  return sum * step;
}

/**
 * Sum of `count` evenly spaced samples of one segment's cubic, starting at
 * curve x `start` with spacing `step`.
 */
function sumCubicSamples(
  segment: PreparedParticleCurveSegment,
  start: number,
  step: number,
  count: number,
): number {
  const u = (start - segment.start) / segment.dx;
  const d = step / segment.dx;
  // Shift the polynomial to the first sample to avoid subtracting large sums
  // across narrow segments. Sum j, j^2 and j^3 for j = 0..count-1.
  const c0 = segment.y0 + u * (segment.c1 + u * (segment.c2 + u * segment.c3));
  const c1 = d * (segment.c1 + u * (2 * segment.c2 + 3 * u * segment.c3));
  const c2 = d * d * (segment.c2 + 3 * u * segment.c3);
  const c3 = d * d * d * segment.c3;
  const j = count - 1;
  const sum1 = (j * count) / 2;
  const sum2 = (j * count * (2 * j + 1)) / 6;
  return count * c0 + c1 * sum1 + c2 * sum2 + c3 * sum1 * sum1;
}
