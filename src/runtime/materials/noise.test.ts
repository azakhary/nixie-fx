import { describe, expect, it } from "vitest";
import {
  bakeScalarNoise,
  sampleScalarNoise,
  sampleVectorNoise,
  scalarNoiseOptionsFromParams,
  vectorNoiseOptionsFromParams,
} from "./noise";

/**
 * The generated-noise contract (iteration 5b §6): deterministic, seamlessly
 * tiling, byte-stable for a given (params, seed). Shared verbatim by the runtime
 * Tier-0 bake and the editor preview.
 */

describe("scalar noise", () => {
  it("is deterministic for the same params + position", () => {
    const opts = scalarNoiseOptionsFromParams({
      function: "perlinGradient",
      scale: 9,
      seed: 4,
    });
    for (const [u, v] of [
      [0.13, 0.77],
      [0.5, 0.5],
      [0.91, 0.02],
    ] as [number, number][]) {
      expect(sampleScalarNoise(opts, u, v)).toBe(sampleScalarNoise(opts, u, v));
    }
  });

  it("varies across the field (not a constant)", () => {
    const opts = scalarNoiseOptionsFromParams({ scale: 8, seed: 1 });
    const a = sampleScalarNoise(opts, 0.1, 0.1);
    const b = sampleScalarNoise(opts, 0.6, 0.4);
    expect(a).not.toBeCloseTo(b, 3);
  });

  it("defaults to one noise layer unless Levels is explicitly authored", () => {
    expect(scalarNoiseOptionsFromParams({}).levels).toBe(1);
  });

  it("changing the seed changes the field", () => {
    const u = 0.3;
    const v = 0.7;
    const a = sampleScalarNoise(
      scalarNoiseOptionsFromParams({ seed: 1 }),
      u,
      v,
    );
    const b = sampleScalarNoise(
      scalarNoiseOptionsFromParams({ seed: 2 }),
      u,
      v,
    );
    expect(a).not.toBe(b);
  });

  it("remaps into [outputMin, outputMax]", () => {
    const opts = scalarNoiseOptionsFromParams({
      outputMin: 2,
      outputMax: 3,
      scale: 8,
    });
    for (const [u, v] of [
      [0.2, 0.4],
      [0.7, 0.9],
    ] as [number, number][]) {
      const n = sampleScalarNoise(opts, u, v);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  it("tiling wraps seamlessly when scale matches the repeat domain", () => {
    const opts = scalarNoiseOptionsFromParams({
      scale: 8,
      repeatSize: 8,
      tiling: true,
      seed: 5,
    });
    for (const v of [0, 0.25, 0.6, 0.9]) {
      expect(sampleScalarNoise(opts, 0, v)).toBeCloseTo(
        sampleScalarNoise(opts, 1, v),
        6,
      );
      expect(sampleScalarNoise(opts, v, 0)).toBeCloseTo(
        sampleScalarNoise(opts, v, 1),
        6,
      );
    }
  });

  it("samples true float scale instead of blending neighboring integer scales", () => {
    const actualOpts = scalarNoiseOptionsFromParams({
      scale: 4.1,
      tiling: true,
      levels: 1,
      seed: 7,
    });
    const scale4Opts = scalarNoiseOptionsFromParams({
      scale: 4,
      tiling: true,
      levels: 1,
      seed: 7,
    });
    const scale5Opts = scalarNoiseOptionsFromParams({
      scale: 5,
      tiling: true,
      levels: 1,
      seed: 7,
    });
    const maxBlendError = Math.max(
      ...(
        [
          [0.17, 0.29],
          [0.37, 0.61],
          [0.73, 0.41],
        ] as [number, number][]
      ).map(([u, v]) => {
        const actual = sampleScalarNoise(actualOpts, u, v);
        const scale4 = sampleScalarNoise(scale4Opts, u, v);
        const scale5 = sampleScalarNoise(scale5Opts, u, v);
        const integerCrossfade = scale4 + (scale5 - scale4) * 0.1;
        return Math.abs(actual - integerCrossfade);
      }),
    );
    expect(maxBlendError).toBeGreaterThan(0.001);
  });

  it("changes smoothly for sub-integer tiled scale edits", () => {
    const a = bakeScalarNoise(
      scalarNoiseOptionsFromParams({
        function: "perlinGradient",
        scale: 8.1,
        tiling: true,
        levels: 1,
        seed: 5,
      }),
      16,
      16,
    );
    const b = bakeScalarNoise(
      scalarNoiseOptionsFromParams({
        function: "perlinGradient",
        scale: 8.2,
        tiling: true,
        levels: 1,
        seed: 5,
      }),
      16,
      16,
    );
    expect(imagesDiffer(a, b)).toBe(true);
  });

  it("uses Levels for layered scalar noise modes", () => {
    const single = bakeScalarNoise(
      scalarNoiseOptionsFromParams({
        function: "perlinGradient",
        levels: 1,
        scale: 7.3,
        seed: 5,
      }),
      16,
      16,
    );
    const layered = bakeScalarNoise(
      scalarNoiseOptionsFromParams({
        function: "perlinGradient",
        levels: 4,
        scale: 7.3,
        seed: 5,
      }),
      16,
      16,
    );
    expect(imagesDiffer(single, layered)).toBe(true);
  });

  it("uses Repeat Size as the tiled scalar domain", () => {
    const repeat8 = scalarNoiseOptionsFromParams({
      function: "perlinGradient",
      repeatSize: 8,
      scale: 8,
      seed: 5,
    });
    const repeat16 = scalarNoiseOptionsFromParams({
      function: "perlinGradient",
      repeatSize: 16,
      scale: 8,
      seed: 5,
    });
    const v = 0.37;
    expect(sampleScalarNoise(repeat8, 0.1, v)).toBeCloseTo(
      sampleScalarNoise(repeat8, 1.1, v),
      6,
    );
    expect(
      Math.abs(
        sampleScalarNoise(repeat16, 0.1, v) -
          sampleScalarNoise(repeat16, 1.1, v),
      ),
    ).toBeGreaterThan(0.001);
  });

  it("turbulence keeps the output in range", () => {
    const opts = scalarNoiseOptionsFromParams({ turbulence: true, scale: 8 });
    for (const [u, v] of [
      [0.1, 0.2],
      [0.5, 0.9],
    ] as [number, number][]) {
      const n = sampleScalarNoise(opts, u, v);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it("uses Levels for layered scalar Voronoi", () => {
    const single = bakeScalarNoise(
      scalarNoiseOptionsFromParams({
        function: "voronoi",
        levels: 1,
        scale: 8,
        seed: 3,
      }),
      16,
      16,
    );
    const layered = bakeScalarNoise(
      scalarNoiseOptionsFromParams({
        function: "voronoi",
        levels: 4,
        scale: 8,
        seed: 3,
      }),
      16,
      16,
    );
    expect(imagesDiffer(single, layered)).toBe(true);
  });
});

describe("vector noise", () => {
  it("is deterministic and stays in 0..1 when normalized", () => {
    const opts = vectorNoiseOptionsFromParams({
      function: "perlinCurl",
      scale: 6,
      seed: 3,
      normalizeOutput: true,
    });
    const a = sampleVectorNoise(opts, 0.3, 0.6);
    const b = sampleVectorNoise(opts, 0.3, 0.6);
    expect(a).toEqual(b);
    for (let i = 0; i < 3; i++) {
      expect(a[i]).toBeGreaterThanOrEqual(0);
      expect(a[i]).toBeLessThanOrEqual(1);
    }
  });

  it("tiles seamlessly when scale matches Tile Size", () => {
    const opts = vectorNoiseOptionsFromParams({
      function: "perlinGradient",
      scale: 6,
      tileSize: 6,
      tiling: true,
      seed: 2,
    });
    const left = sampleVectorNoise(opts, 0, 0.4);
    const right = sampleVectorNoise(opts, 1, 0.4);
    for (let i = 0; i < 3; i++) expect(left[i]).toBeCloseTo(right[i], 6);
  });

  it("samples vector noise at true float scale", () => {
    const actual = sampleVectorNoise(
      vectorNoiseOptionsFromParams({
        function: "perlinGradient",
        scale: 5.25,
        tiling: true,
        seed: 2,
      }),
      0.37,
      0.61,
    );
    const integer = sampleVectorNoise(
      vectorNoiseOptionsFromParams({
        function: "perlinGradient",
        scale: 5,
        tiling: true,
        seed: 2,
      }),
      0.37,
      0.61,
    );
    expect(actual[0]).not.toBeCloseTo(integer[0], 4);
  });
});

describe("bakeScalarNoise", () => {
  it("produces a grayscale RGBA buffer of the requested size", () => {
    const img = bakeScalarNoise(
      scalarNoiseOptionsFromParams({ scale: 8, seed: 1 }),
      16,
      8,
    );
    expect(img.width).toBe(16);
    expect(img.height).toBe(8);
    expect(img.data.length).toBe(16 * 8 * 4);
    // Grayscale: R == G == B, alpha opaque.
    expect(img.data[0]).toBe(img.data[1]);
    expect(img.data[1]).toBe(img.data[2]);
    expect(img.data[3]).toBe(255);
  });

  it("is byte-identical across bakes (determinism)", () => {
    const opts = scalarNoiseOptionsFromParams({ scale: 12, seed: 9 });
    const a = bakeScalarNoise(opts, 24, 24);
    const b = bakeScalarNoise(opts, 24, 24);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

function imagesDiffer(
  a: { data: Uint8ClampedArray },
  b: { data: Uint8ClampedArray },
): boolean {
  if (a.data.length !== b.data.length) return true;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) return true;
  }
  return false;
}
