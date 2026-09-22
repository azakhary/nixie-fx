import { describe, expect, it } from "vitest";
import { ParticleCurveSampler, sampleParticleCurve } from "./ParticleCurve";
import { ParticleScalarValueSampler } from "./ParticleScalarValueSampler";
import {
  createConstantParticleScalar,
  createDefaultParticleEffect,
  normalizeParticleEffect,
  sampleParticleScalarValue,
  type ParticleScalarValue,
} from "./particles";

function collectScalars(value: unknown, out: ParticleScalarValue[]): void {
  if (!value || typeof value !== "object") return;
  if ("curve" in value && "curveB" in value && "mode" in value) {
    out.push(value as ParticleScalarValue);
    return;
  }
  for (const child of Object.values(value)) collectScalars(child, out);
}

const curves = [
  [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  [
    { x: 0, y: 2, slopeOut: -6 },
    { x: 0.35, y: -1 },
    { x: 1, y: 4, weightIn: 0.9 },
  ],
  [
    { x: 0, y: -3, weightOut: 0.12, slopeOut: 9 },
    { x: 0.8, y: 5 },
    { x: 1, y: 5 },
  ],
];

describe("prepared particle scalar sampling", () => {
  it("matches the mutable sampling path exactly across modes, axes and multipliers", () => {
    let compared = 0;
    for (const mode of [
      "constant",
      "random",
      "curve",
      "randomCurve",
    ] as const) {
      for (const xAxis of ["lifetime", "loopAge"] as const) {
        for (const multiplier of [1, -2.3, 0.125]) {
          for (const curve of curves) {
            const scalar = createConstantParticleScalar(0.75, -10, 10);
            scalar.mode = mode;
            scalar.xAxis = xAxis;
            scalar.multiplier = multiplier;
            scalar.min = -2;
            scalar.max = 7;
            scalar.curve = curve;
            scalar.curveB = curves[0]!;
            const sampler = new ParticleScalarValueSampler(scalar);
            for (const t of [-1, 0, 0.071, 0.3571802580156275, 0.63, 1, 2]) {
              for (const seed of [-1, 0, 0.37, 1, 2]) {
                for (const loopAge of [undefined, 0.23, 1.4]) {
                  expect(sampler.sample(t, seed, loopAge)).toBe(
                    sampleParticleScalarValue(scalar, t, seed, loopAge),
                  );
                  compared++;
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it("matches the mutable path for every scalar of a normalized effect", () => {
    const scalars: ParticleScalarValue[] = [];
    collectScalars(
      normalizeParticleEffect(createDefaultParticleEffect()),
      scalars,
    );
    expect(scalars.length).toBeGreaterThan(0);
    for (const scalar of scalars) {
      const sampler = new ParticleScalarValueSampler(scalar);
      for (let i = 0; i <= 32; i++) {
        const t = i / 32;
        expect(sampler.sample(t, 0.37, 0.23)).toBe(
          sampleParticleScalarValue(scalar, t, 0.37, 0.23),
        );
      }
    }
  });

  it("owns a setup-time snapshot and a replacement sampler sees edits", () => {
    const points = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
    ];
    const sampler = new ParticleCurveSampler(points);
    const original = sampler.sample(0.5);
    points[1]!.y = 7;
    expect(sampler.sample(0.5)).toBe(original);
    expect(new ParticleCurveSampler(points).sample(0.5)).toBe(
      sampleParticleCurve(points, 0.5),
    );
    expect(new ParticleCurveSampler(points).sample(0.5)).not.toBe(original);
  });
});
