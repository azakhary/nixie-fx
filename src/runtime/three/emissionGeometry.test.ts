import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from "three";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import type { ParticleMeshAssetRef } from "../../engine/particles";
import { threeGeometryToEmissionInput } from "./emissionGeometry";
import { ThreeVfxRenderer } from "./renderer";

function createCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  return camera;
}

function meshSpawnEffect(meshAsset: ParticleMeshAssetRef | null = null) {
  return normalizeParticleEffect({
    id: "emission-geometry-test",
    targetProfile: "three-world-3d",
    emitters: [
      {
        id: "embers",
        maxParticles: 64,
        duration: 1,
        loop: false,
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 32, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "mesh",
          meshEmitFrom: "surface",
          ...(meshAsset ? { meshAsset } : {}),
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 5 },
          velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
        },
      },
    ],
  });
}

/** A single triangle far from the origin so point-fallback is detectable. */
function farTriangle(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([50, 0, 0, 51, 0, 0, 50, 1, 0]), 3),
  );
  return geometry;
}

describe("threeGeometryToEmissionInput", () => {
  it("extracts positions, indices and normals from an indexed geometry", () => {
    const plane = new PlaneGeometry(2, 2, 1, 1);
    const input = threeGeometryToEmissionInput(plane);
    expect(input).not.toBeNull();
    expect(input!.positions.length).toBe(
      plane.getAttribute("position").count * 3,
    );
    expect(input!.indices?.length).toBe(plane.getIndex()!.count);
    expect(input!.normals?.length).toBe(input!.positions.length);
  });

  it("reads interleaved position attributes through accessors", () => {
    // xyz + uv interleaved in one buffer (stride 5).
    const interleaved = new InterleavedBuffer(
      new Float32Array([1, 2, 3, 0, 0, 4, 5, 6, 0, 0, 7, 8, 9, 0, 0]),
      5,
    );
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new InterleavedBufferAttribute(interleaved, 3, 0),
    );
    const input = threeGeometryToEmissionInput(geometry);
    expect(Array.from(input!.positions)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("returns null for geometry without positions", () => {
    expect(threeGeometryToEmissionInput(new BufferGeometry())).toBeNull();
  });
});

describe("ThreeVfxEffectInstance emission geometry", () => {
  it("spawns particles on host-injected geometry", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(meshSpawnEffect());
    instance.setEmissionGeometry("embers", farTriangle());
    renderer.update(1 / 60);

    const transforms = instance.getParticleDebugTransforms();
    expect(transforms.length).toBe(32);
    for (const transform of transforms) {
      expect(transform.position[0]).toBeGreaterThanOrEqual(50);
      expect(transform.position[0]).toBeLessThanOrEqual(51);
      expect(transform.position[1]).toBeGreaterThanOrEqual(0);
      expect(transform.position[1]).toBeLessThanOrEqual(1);
      expect(transform.position[2]).toBeCloseTo(0, 5);
    }
  });

  it("falls back to point emission with no source, then rebinding null clears an override", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(meshSpawnEffect());
    renderer.update(1 / 60);
    for (const transform of instance.getParticleDebugTransforms()) {
      expect(transform.position[0]).toBeCloseTo(0, 5);
      expect(transform.position[1]).toBeCloseTo(0, 5);
    }

    instance.setEmissionGeometry("embers", farTriangle());
    instance.seek(0);
    renderer.update(1 / 60);
    expect(
      instance
        .getParticleDebugTransforms()
        .every((transform) => transform.position[0] >= 50),
    ).toBe(true);

    instance.setEmissionGeometry("embers", null);
    instance.seek(0);
    renderer.update(1 / 60);
    expect(
      instance
        .getParticleDebugTransforms()
        .every((transform) => Math.abs(transform.position[0]) < 1e-4),
    ).toBe(true);
  });

  it("resolves the authored meshAsset through the mesh provider", () => {
    const ref: ParticleMeshAssetRef = {
      type: "mesh",
      id: "tri",
      path: "meshes/tri.gltf",
    };
    const triangle = farTriangle();
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      meshProvider: {
        getMeshGeometry: (requested) =>
          requested.path === ref.path ? triangle : null,
      },
    });
    const instance = renderer.createEffect(meshSpawnEffect(ref));
    renderer.update(1 / 60);
    const transforms = instance.getParticleDebugTransforms();
    expect(transforms.length).toBe(32);
    expect(transforms.every((t) => t.position[0] >= 50)).toBe(true);
  });

  it("prefers a host override over the provider and picks up provider swaps", () => {
    const ref: ParticleMeshAssetRef = {
      type: "mesh",
      id: "tri",
      path: "meshes/tri.gltf",
    };
    let provided: BufferGeometry | null = null;
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      meshProvider: { getMeshGeometry: () => provided },
    });
    const instance = renderer.createEffect(meshSpawnEffect(ref));

    // Provider has nothing yet: point fallback.
    renderer.update(1 / 60);
    expect(
      instance
        .getParticleDebugTransforms()
        .every((t) => Math.abs(t.position[0]) < 1e-4),
    ).toBe(true);

    // Async "load" completes: next update rebinds by identity change.
    provided = farTriangle();
    instance.seek(0);
    renderer.update(1 / 60);
    expect(
      instance.getParticleDebugTransforms().every((t) => t.position[0] >= 50),
    ).toBe(true);

    // Host override wins over the provider.
    const override = new BufferGeometry();
    override.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-9, 0, 0, -8, 0, 0, -9, 1, 0]), 3),
    );
    instance.setEmissionGeometry("embers", override);
    instance.seek(0);
    renderer.update(1 / 60);
    expect(
      instance.getParticleDebugTransforms().every((t) => t.position[0] <= -8),
    ).toBe(true);
  });
});
