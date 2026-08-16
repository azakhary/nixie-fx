import { PerspectiveCamera, type DataTexture } from "three";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import {
  createThreeEmitterMaterial,
  emitterProceduralBillboardKey,
} from "./materialAdapter";
import {
  getProceduralBillboardTexture,
  proceduralBillboardTextureKey,
} from "./proceduralBillboardTexture";

function alphaAt(texture: DataTexture, x: number, y: number): number {
  const image = texture.image as { data: Uint8Array; width: number };
  return image.data[(y * image.width + x) * 4 + 3] ?? 0;
}

function textureSize(texture: DataTexture): number {
  return (texture.image as { width: number }).width;
}

function billboardEmitter(overrides: Record<string, unknown> = {}) {
  return normalizeParticleEffect({
    id: "procedural-billboards",
    targetProfile: "three-world-3d",
    emitters: [{ id: "assetless", ...overrides }],
  }).emitters[0]!;
}

describe("Three procedural billboard textures (F12)", () => {
  it("resolves a non-null procedural texture for assetless billboard emitters", () => {
    const emitter = billboardEmitter();
    expect(emitter.render.texture).toBeNull();
    expect(emitter.billboard.shape).toBe("circle");

    const resolution = createThreeEmitterMaterial(emitter, {
      effect: {},
      camera: new PerspectiveCamera(),
    });

    expect("map" in resolution.material && resolution.material.map).toBe(
      getProceduralBillboardTexture(
        emitter.billboard.shape,
        emitter.billboard.softness,
      ),
    );
    // Shared cache texture: the material resolution must never own (and thus
    // never dispose) it.
    expect(resolution.ownedTextures).toEqual([]);
  });

  it("caches by shape and softness", () => {
    const first = getProceduralBillboardTexture("circle", 0.4);
    expect(getProceduralBillboardTexture("circle", 0.4)).toBe(first);
    expect(getProceduralBillboardTexture("circle", 0.8)).not.toBe(first);
    expect(getProceduralBillboardTexture("square", 0.4)).not.toBe(first);
  });

  it("draws an opaque-center, transparent-edge circle", () => {
    const texture = getProceduralBillboardTexture(
      "circle",
      0.4,
    ) as DataTexture;
    const size = textureSize(texture);
    const center = Math.floor(size / 2);

    expect(alphaAt(texture, center, center)).toBeGreaterThanOrEqual(250);
    expect(alphaAt(texture, 0, center)).toBe(0);
    expect(alphaAt(texture, size - 1, center)).toBe(0);
    expect(alphaAt(texture, 0, 0)).toBe(0);

    // Radially non-increasing along the center row.
    for (let x = center; x < size - 1; x++) {
      expect(alphaAt(texture, x + 1, center)).toBeLessThanOrEqual(
        alphaAt(texture, x, center),
      );
    }
  });

  it("softness widens the circle falloff band", () => {
    const hard = getProceduralBillboardTexture("circle", 0.1) as DataTexture;
    const soft = getProceduralBillboardTexture("circle", 0.8) as DataTexture;
    const size = textureSize(hard);
    const center = Math.floor(size / 2);
    // Sample around 70% of the shape radius: inside the hard core at
    // softness 0.1, deep inside the falloff band at softness 0.8.
    const x = center + Math.round(size * 0.44 * 0.7);

    expect(alphaAt(hard, x, center)).toBeGreaterThan(240);
    expect(alphaAt(soft, x, center)).toBeLessThan(140);
    expect(alphaAt(soft, x, center)).toBeGreaterThan(0);
  });

  it("draws a hard-edged square at softness 0 and feathers it with softness", () => {
    const hard = getProceduralBillboardTexture("square", 0) as DataTexture;
    const soft = getProceduralBillboardTexture("square", 0.5) as DataTexture;
    const size = textureSize(hard);
    const center = Math.floor(size / 2);
    const halfExtent = size * 0.42;
    const inside = center + Math.floor(halfExtent) - 3;
    const outside = center + Math.ceil(halfExtent) + 2;

    expect(alphaAt(hard, center, center)).toBe(255);
    expect(alphaAt(hard, inside, center)).toBe(255);
    expect(alphaAt(hard, outside, center)).toBe(0);
    // Square alpha is uniform inside (corners stay filled, unlike the circle).
    expect(alphaAt(hard, inside, inside)).toBe(255);

    expect(alphaAt(soft, center, center)).toBe(255);
    expect(alphaAt(soft, inside, center)).toBeLessThan(255);
    expect(alphaAt(soft, inside, center)).toBeGreaterThan(0);
  });

  it("keys assetless billboards for view rebuilds, and only those", () => {
    const assetless = billboardEmitter();
    expect(emitterProceduralBillboardKey(assetless)).toBe(
      proceduralBillboardTextureKey(
        assetless.billboard.shape,
        assetless.billboard.softness,
      ),
    );
    expect(
      emitterProceduralBillboardKey(
        billboardEmitter({ billboard: { shape: "square", softness: 0.9 } }),
      ),
    ).toBe(proceduralBillboardTextureKey("square", 0.9));

    expect(
      emitterProceduralBillboardKey(
        billboardEmitter({ render: { texture: "fx/spark.png" } }),
      ),
    ).toBeNull();
    expect(
      emitterProceduralBillboardKey(billboardEmitter({ mode: "mesh" })),
    ).toBeNull();
  });
});
