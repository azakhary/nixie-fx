import { describe, expect, it } from "vitest";
import {
  prepareParticleCurve,
  sampleParticleCurve,
  samplePreparedParticleCurve,
} from "./ParticleCurve";
import { integrateParticleCurve } from "./ParticleCurveIntegral";
import { integrateParticleScalarValue } from "./ParticleScalarSampling";
import {
  normalizeParticleScalarValue,
  sampleParticleScalarValue,
  type ParticleCurvePoint,
  type ParticleScalarValue,
} from "./particles";

/** The 64-step trapezoid loop the runtime used before the closed-form sum. */
function originalIntegral(
  value: ParticleScalarValue,
  end: number,
  random: number,
): number {
  const steps = Math.max(1, Math.ceil(end * 64));
  let previous = sampleParticleScalarValue(value, 0, random);
  let area = 0;
  for (let i = 1; i <= steps; i++) {
    const next = sampleParticleScalarValue(value, (end * i) / steps, random);
    area += (previous + next) * 0.5 * (end / steps);
    previous = next;
  }
  return area;
}

const cases: ParticleCurvePoint[][] = [
  [
    { x: 0, y: 3 },
    { x: 1, y: -2 },
  ],
  [
    { x: 0, y: 0 },
    { x: 0.3, y: 1 },
    { x: 0.6, y: 1 },
    { x: 1, y: 0 },
  ],
  [
    { x: 0, y: 4, slopeOut: -20 },
    { x: 0.25, y: -2, slopeIn: 8 },
    { x: 1, y: 5 },
  ],
  [
    { x: 0, y: 1, weightOut: 0.1, slopeOut: 5 },
    { x: 0.4, y: 3, weightIn: 0.8 },
    { x: 1, y: -3 },
  ],
  [
    { x: 0, y: 0 },
    { x: 0.5, y: 2 },
    { x: 0.5, y: 4 },
    { x: 1, y: 0 },
  ],
  [
    { x: 0, y: 0 },
    { x: 0.0000001, y: 1 },
    { x: 1, y: 0 },
  ],
];

describe("prepared particle curves", () => {
  it("matches the previous trapezoid calculation across shapes, mixes, multipliers and step boundaries", () => {
    for (const curve of cases) {
      for (const mode of ["curve", "randomCurve"] as const) {
        const value = normalizeParticleScalarValue(
          { mode, curve, curveB: cases[2], multiplier: -2 },
          1,
          -5,
          5,
        );
        for (const point of value.curve) Object.freeze(point);
        for (const point of value.curveB) Object.freeze(point);
        Object.freeze(value.curve);
        Object.freeze(value.curveB);
        for (const end of [
          0,
          0.00001,
          1 / 64 - 1e-10,
          1 / 64,
          1 / 64 + 1e-10,
          0.25,
          0.3,
          0.5001,
          0.999,
          1,
        ]) {
          for (const mix of [0, 0.27, 0.5, 1]) {
            const expected = originalIntegral(value, end, mix);
            expect(
              Math.abs(
                integrateParticleScalarValue(value, end, mix) - expected,
              ),
            ).toBeLessThan(1e-9);
          }
        }
      }
    }
  });

  it("integrates raw curves to the same area as the sampled rule", () => {
    for (const curve of cases) {
      const value = normalizeParticleScalarValue(
        { mode: "curve", curve },
        1,
        -5,
        5,
      );
      for (const end of [0.125, 0.5, 1]) {
        expect(
          Math.abs(
            integrateParticleCurve(value.curve, end) -
              originalIntegral(value, end, 0) / (value.multiplier ?? 1),
          ),
        ).toBeLessThan(1e-9);
      }
    }
  });

  it("samples exactly like the prepared curve it derives", () => {
    for (const curve of cases) {
      const prepared = prepareParticleCurve(curve);
      for (let i = 0; i <= 50; i++) {
        const t = i / 50;
        expect(sampleParticleCurve(curve, t)).toBe(
          samplePreparedParticleCurve(prepared, t),
        );
      }
    }
  });

  it("does not rescan immutable authored points during playback", () => {
    let reads = 0;
    const points = Object.freeze(
      [0, 1].map((x) =>
        Object.freeze({
          get x() {
            reads++;
            return x;
          },
          get y() {
            reads++;
            return 1 - x;
          },
        }),
      ),
    );
    const prepared = prepareParticleCurve(points);
    reads = 0;
    for (let i = 0; i < 1000; i++) sampleParticleCurve(points, i / 1000);
    expect(prepareParticleCurve(points)).toBe(prepared);
    expect(reads).toBe(0);
  });

  it("sees mutable editor edits and replacement arrays immediately", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(sampleParticleCurve(points, 0.5)).toBeCloseTo(0.5);
    points[1]!.y = 3;
    expect(sampleParticleCurve(points, 0.5)).toBeCloseTo(1.5);
    expect(
      sampleParticleCurve(
        [
          { x: 0, y: 2 },
          { x: 1, y: 2 },
        ],
        0.5,
      ),
    ).toBe(2);
  });

  it("does not memoize a frozen array whose points remain editable", () => {
    const points = Object.freeze([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    const prepared = prepareParticleCurve(points);
    expect(prepareParticleCurve(points)).not.toBe(prepared);
    expect(sampleParticleCurve(points, 0.25)).toBeCloseTo(0.25);
    points[0]!.y = 4;
    expect(sampleParticleCurve(points, 0.25)).not.toBeCloseTo(0.25);
  });

  it("preserves constant/random fast paths, clamping and the loop-age axis", () => {
    const value = normalizeParticleScalarValue(
      { mode: "curve", curve: cases[0], xAxis: "loopAge" },
      1,
      -5,
      5,
    );
    expect(integrateParticleScalarValue(value, 0.2, -1, 0.75)).toBeCloseTo(
      originalIntegral(value, 0.75, 0),
      10,
    );
    expect(
      integrateParticleScalarValue(
        { ...value, mode: "constant", value: 3 },
        2,
        0,
      ),
    ).toBe(3);
    expect(
      integrateParticleScalarValue(
        { ...value, mode: "random", min: 2, max: 4 },
        0.5,
        2,
      ),
    ).toBe(2);
    expect(integrateParticleScalarValue(value, -1, 0)).toBe(0);
  });
});
