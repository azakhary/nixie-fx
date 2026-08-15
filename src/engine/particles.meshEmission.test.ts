import { describe, expect, it } from "vitest";
import {
  PARTICLE_INSTANCE_STRIDE,
  ParticleEffectRunner,
  compileParticleEmissionGeometry,
  normalizeParticleEffect,
} from "./particles";

/**
 * Two coplanar right triangles in the XZ plane (y = 0) forming an L, with the
 * second triangle 100x the area of the first. Area weighting must send ~99% of
 * surface samples to the big triangle.
 *   small: (0,0,0) (1,0,0) (0,0,1)        area 0.5
 *   big:   (10,0,0) (20,0,0) (10,0,10)    area 50
 */
const TWO_TRIANGLES = {
  positions: new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 0, 1, 10, 0, 0, 20, 0, 0, 10, 0, 10,
  ]),
  indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
};

function meshEffect(overrides: Record<string, unknown> = {}) {
  return normalizeParticleEffect({
    id: "mesh-emission-test",
    emitters: [
      {
        id: "mesh-emitter",
        maxParticles: 512,
        duration: 1,
        loop: true,
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 400, cycles: 1, interval: 1, probability: 1 },
          ],
          shape: "mesh",
          meshEmitFrom: "surface",
          ...overrides,
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 5 },
          velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
        },
      },
    ],
  });
}

function spawnPositions(
  runner: ParticleEffectRunner,
): [number, number, number][] {
  const state = runner.states[0]!;
  const out: [number, number, number][] = [];
  for (let i = 0; i < state.activeCount; i++) {
    const slot = i * PARTICLE_INSTANCE_STRIDE;
    out.push([
      state.instanceData[slot + 0],
      state.instanceData[slot + 1],
      state.instanceData[slot + 2],
    ]);
  }
  return out;
}

describe("compileParticleEmissionGeometry", () => {
  it("builds an area-weighted CDF and face normals", () => {
    const compiled = compileParticleEmissionGeometry(TWO_TRIANGLES);
    expect(compiled).not.toBeNull();
    expect(compiled!.triangleCount).toBe(2);
    expect(compiled!.vertexCount).toBe(6);
    expect(compiled!.triangleCdf[0]).toBeCloseTo(0.5);
    expect(compiled!.triangleCdf[1]).toBeCloseTo(50.5);
    expect(compiled!.totalArea).toBeCloseTo(50.5);
    // XZ-plane triangles with this winding face -Y or +Y consistently.
    expect(Math.abs(compiled!.faceNormals![1])).toBeCloseTo(1);
  });

  it("treats non-indexed positions as consecutive triangles", () => {
    const compiled = compileParticleEmissionGeometry({
      positions: TWO_TRIANGLES.positions,
    });
    expect(compiled!.triangleCount).toBe(2);
    expect(compiled!.totalArea).toBeCloseTo(50.5);
  });

  it("rejects empty and out-of-range input", () => {
    expect(compileParticleEmissionGeometry({ positions: [] })).toBeNull();
    expect(
      compileParticleEmissionGeometry({
        positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
        indices: [0, 1, 7],
      }),
    ).toBeNull();
  });
});

describe("mesh spawn shape", () => {
  it("spawns on the mesh surface with area weighting", () => {
    const effect = meshEffect();
    const runner = new ParticleEffectRunner(effect);
    runner.setEmissionGeometry("mesh-emitter", TWO_TRIANGLES);
    runner.reset(effect, [0, 0, 0], 0, 42);
    runner.update(0.05, 0.05);

    const positions = spawnPositions(runner);
    expect(positions.length).toBe(400);
    let onBigTriangle = 0;
    for (const [x, y, z] of positions) {
      expect(y).toBeCloseTo(0, 5);
      // Inside the union of the two triangles: x/z bounds sanity.
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(20);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(10);
      if (x >= 10 - 1e-5) onBigTriangle++;
      else expect(x + z).toBeLessThanOrEqual(1 + 1e-5);
    }
    // Big triangle holds 100/101 of the area; allow generous slack.
    expect(onBigTriangle / positions.length).toBeGreaterThan(0.93);
  });

  it("is deterministic for a fixed seed and geometry", () => {
    const effect = meshEffect();
    const first = new ParticleEffectRunner(effect);
    first.setEmissionGeometry("mesh-emitter", TWO_TRIANGLES);
    first.reset(effect, [0, 0, 0], 0, 7);
    first.update(0.05, 0.05);
    const second = new ParticleEffectRunner(effect);
    second.setEmissionGeometry("mesh-emitter", TWO_TRIANGLES);
    second.reset(effect, [0, 0, 0], 0, 7);
    second.update(0.05, 0.05);
    expect(spawnPositions(first)).toEqual(spawnPositions(second));
  });

  it("spawns exactly on vertices in vertices mode", () => {
    const effect = meshEffect({ meshEmitFrom: "vertices" });
    const runner = new ParticleEffectRunner(effect);
    runner.setEmissionGeometry("mesh-emitter", TWO_TRIANGLES);
    runner.reset(effect, [0, 0, 0], 0, 42);
    runner.update(0.05, 0.05);

    const vertices = new Set<string>();
    for (let i = 0; i < TWO_TRIANGLES.positions.length; i += 3) {
      vertices.add(
        `${TWO_TRIANGLES.positions[i]},${TWO_TRIANGLES.positions[i + 1]},${TWO_TRIANGLES.positions[i + 2]}`,
      );
    }
    const positions = spawnPositions(runner);
    expect(positions.length).toBe(400);
    const seen = new Set<string>();
    for (const [x, y, z] of positions) {
      const key = `${x},${y},${z}`;
      expect(vertices.has(key)).toBe(true);
      seen.add(key);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("degrades to point emission when no geometry is bound", () => {
    const effect = meshEffect();
    const runner = new ParticleEffectRunner(effect);
    runner.reset(effect, [3, 4, 5], 0, 42);
    runner.update(0.05, 0.05);
    const positions = spawnPositions(runner);
    expect(positions.length).toBe(400);
    for (const [x, y, z] of positions) {
      expect(x).toBeCloseTo(3);
      expect(y).toBeCloseTo(4);
      expect(z).toBeCloseTo(5);
    }
  });

  it("applies the shape transform (position/rotation/scale) to mesh samples", () => {
    // 90° around Z maps local +X to +Y; scale doubles; then offset.
    const effect = meshEffect({
      position: [100, 0, 0],
      rotation: [0, 0, 90],
      scale: [2, 2, 2],
    });
    const runner = new ParticleEffectRunner(effect);
    runner.setEmissionGeometry("mesh-emitter", {
      positions: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
    });
    runner.reset(effect, [0, 0, 0], 0, 42);
    runner.update(0.05, 0.05);
    for (const [x, y, z] of spawnPositions(runner)) {
      expect(x).toBeCloseTo(100, 4);
      expect(y).toBeCloseTo(2, 4);
      expect(z).toBeCloseTo(0, 4);
    }
  });

  it("survives reset and updateDefinition (host binding is sticky)", () => {
    const effect = meshEffect();
    const runner = new ParticleEffectRunner(effect);
    runner.setEmissionGeometry("mesh-emitter", TWO_TRIANGLES);
    runner.reset(effect, [0, 0, 0], 0, 1);
    runner.update(0.05, 0.05);
    runner.updateDefinition(effect);
    runner.reset(effect, [0, 0, 0], 10, 2);
    runner.update(0.05, 10.05);
    const positions = spawnPositions(runner);
    expect(positions.length).toBe(400);
    // Still on the mesh, not collapsed to the origin point.
    const distinct = new Set(positions.map(([x]) => Math.round(x * 1000)));
    expect(distinct.size).toBeGreaterThan(10);
  });

  it("clears the binding when passed null or invalid geometry", () => {
    const effect = meshEffect();
    const runner = new ParticleEffectRunner(effect);
    expect(runner.setEmissionGeometry("mesh-emitter", TWO_TRIANGLES)).toBe(
      true,
    );
    expect(runner.getEmissionGeometry("mesh-emitter")).not.toBeNull();
    expect(runner.setEmissionGeometry("mesh-emitter", null)).toBe(false);
    expect(runner.getEmissionGeometry("mesh-emitter")).toBeNull();
    expect(runner.setEmissionGeometry("mesh-emitter", { positions: [] })).toBe(
      false,
    );
  });

  it("normalizes the mesh spawn fields through effect JSON", () => {
    const effect = normalizeParticleEffect({
      id: "normalize-mesh",
      emitters: [
        {
          id: "e",
          spawn: {
            shape: "mesh",
            meshEmitFrom: "vertices",
            meshAsset: { path: "meshes/digit.gltf", id: "digit" },
          },
        },
      ],
    });
    const spawn = effect.emitters[0]!.spawn;
    expect(spawn.shape).toBe("mesh");
    expect(spawn.meshEmitFrom).toBe("vertices");
    expect(spawn.meshAsset).toMatchObject({
      type: "mesh",
      path: "meshes/digit.gltf",
      id: "digit",
    });
    // Unknown values fall back safely.
    const fallback = normalizeParticleEffect({
      id: "normalize-mesh-fallback",
      emitters: [
        { id: "e", spawn: { shape: "mesh", meshEmitFrom: "nonsense" } },
      ],
    });
    expect(fallback.emitters[0]!.spawn.meshEmitFrom).toBe("surface");
    expect(fallback.emitters[0]!.spawn.meshAsset).toBeNull();
  });
});
