import { describe, expect, it } from "vitest";
import {
  normalizeParticleEffect,
  type ParticleEmitterDefinition,
} from "@/engine/particles";
import { gradientNoise3D, sampleCurlNoise3 } from "../materials/noise";
import {
  applyNoiseDisplacement,
  type ParticleMotionSample,
} from "./advancedEvaluators";

function noiseEmitter(mode: "sine" | "curl"): ParticleEmitterDefinition {
  const effect = normalizeParticleEffect({
    id: `curl-noise-test-${mode}`,
    emitters: [
      {
        id: "emitter",
        modules: { noise: true },
        advanced: {
          noise: {
            mode,
            strength: { mode: "constant", value: 1 },
            frequency: 1.5,
            speed: 1,
            scroll: [1, 0, 0],
            octaves: 2,
            damping: 0.5,
          },
        },
      },
    ],
  });
  return effect.emitters[0]!;
}

function makeSample(
  world: [number, number, number],
  seed: number,
  normalizedAge = 0.5,
): ParticleMotionSample {
  return {
    seed,
    normalizedAge,
    loopAge: normalizedAge,
    ageSeconds: normalizedAge,
    timeSeconds: 1.25,
    world,
    velocity: [0, 0, 0],
  };
}

describe("gradientNoise3D", () => {
  it("is deterministic and roughly signed-unit-range", () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 500; i++) {
      const x = Math.sin(i * 12.9898) * 43758.5453;
      const y = Math.sin(i * 78.233) * 12543.21;
      const z = Math.sin(i * 3.7) * 991.7;
      const value = gradientNoise3D(x, y, z, 7);
      expect(value).toBe(gradientNoise3D(x, y, z, 7));
      min = Math.min(min, value);
      max = Math.max(max, value);
      expect(Math.abs(value)).toBeLessThanOrEqual(1.2);
    }
    // The field actually swings both ways.
    expect(min).toBeLessThan(-0.2);
    expect(max).toBeGreaterThan(0.2);
  });

  it("decorrelates by seed", () => {
    expect(gradientNoise3D(0.3, 0.7, 0.9, 1)).not.toBeCloseTo(
      gradientNoise3D(0.3, 0.7, 0.9, 2),
      6,
    );
  });
});

describe("sampleCurlNoise3", () => {
  it("is deterministic for a fixed point and seed", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    sampleCurlNoise3(1.3, -0.4, 2.2, 5, a);
    sampleCurlNoise3(1.3, -0.4, 2.2, 5, b);
    expect(a).toEqual(b);
    expect(Math.hypot(a[0], a[1], a[2])).toBeGreaterThan(0);
  });

  it("is approximately divergence-free (unlike per-axis sine)", () => {
    // Numerical divergence of the curl field via central differences. For a
    // true curl field this vanishes analytically; finite differences leave a
    // small residual, so compare against the field's own magnitude.
    const e = 0.05;
    const out: [number, number, number] = [0, 0, 0];
    const component = (
      x: number,
      y: number,
      z: number,
      axis: 0 | 1 | 2,
    ): number => {
      sampleCurlNoise3(x, y, z, 0, out);
      return out[axis];
    };
    let divergenceSum = 0;
    let magnitudeSum = 0;
    const samples = 60;
    for (let i = 0; i < samples; i++) {
      const x = Math.sin(i * 12.9898) * 4.37;
      const y = Math.sin(i * 78.233) * 3.21;
      const z = Math.sin(i * 3.7) * 5.9;
      const divergence =
        (component(x + e, y, z, 0) - component(x - e, y, z, 0)) / (2 * e) +
        (component(x, y + e, z, 1) - component(x, y - e, z, 1)) / (2 * e) +
        (component(x, y, z + e, 2) - component(x, y, z - e, 2)) / (2 * e);
      sampleCurlNoise3(x, y, z, 0, out);
      divergenceSum += Math.abs(divergence);
      magnitudeSum += Math.hypot(out[0], out[1], out[2]);
    }
    const meanDivergence = divergenceSum / samples;
    const meanMagnitude = magnitudeSum / samples;
    expect(meanMagnitude).toBeGreaterThan(0.01);
    // Mean |div| stays well under the mean field magnitude per unit length.
    expect(meanDivergence).toBeLessThan(meanMagnitude * 0.35);
  });
});

describe("noise module curl mode", () => {
  it("defaults to sine and normalizes curl through effect JSON", () => {
    expect(noiseEmitter("sine").advanced.noise.mode).toBe("sine");
    expect(noiseEmitter("curl").advanced.noise.mode).toBe("curl");
    const fallback = normalizeParticleEffect({
      id: "fallback",
      emitters: [{ id: "e", advanced: { noise: { mode: "whatever" } } }],
    });
    expect(fallback.emitters[0]!.advanced.noise.mode).toBe("sine");
  });

  it("keeps particles unmoved at spawn (iteration-12 ramp preserved)", () => {
    const emitter = noiseEmitter("curl");
    const world: [number, number, number] = [1, 2, 3];
    applyNoiseDisplacement(emitter.advanced.noise, makeSample(world, 0.42, 0));
    expect(world).toEqual([1, 2, 3]);
  });

  it("displaces coherently: same position + different particle seeds agree", () => {
    const emitter = noiseEmitter("curl");
    const a: [number, number, number] = [1, 2, 3];
    const b: [number, number, number] = [1, 2, 3];
    applyNoiseDisplacement(emitter.advanced.noise, makeSample(a, 0.11));
    applyNoiseDisplacement(emitter.advanced.noise, makeSample(b, 0.93));
    expect(a).toEqual(b);
    expect(a).not.toEqual([1, 2, 3]);

    // Sine mode, by contrast, is per-particle jitter: seeds disagree.
    const sine = noiseEmitter("sine");
    const c: [number, number, number] = [1, 2, 3];
    const d: [number, number, number] = [1, 2, 3];
    applyNoiseDisplacement(sine.advanced.noise, makeSample(c, 0.11));
    applyNoiseDisplacement(sine.advanced.noise, makeSample(d, 0.93));
    expect(c).not.toEqual(d);
  });

  it("nearby particles receive nearby curl displacements", () => {
    const emitter = noiseEmitter("curl");
    const a: [number, number, number] = [1, 2, 3];
    const b: [number, number, number] = [1.02, 2.02, 3.02];
    applyNoiseDisplacement(emitter.advanced.noise, makeSample(a, 0.5));
    applyNoiseDisplacement(emitter.advanced.noise, makeSample(b, 0.5));
    const displacementA = [a[0] - 1, a[1] - 2, a[2] - 3];
    const displacementB = [b[0] - 1.02, b[1] - 2.02, b[2] - 3.02];
    const delta = Math.hypot(
      displacementA[0] - displacementB[0],
      displacementA[1] - displacementB[1],
      displacementA[2] - displacementB[2],
    );
    const magnitude = Math.hypot(...displacementA);
    expect(magnitude).toBeGreaterThan(0);
    expect(delta).toBeLessThan(magnitude * 0.5);
  });
});
