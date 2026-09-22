import { ParticleContainer, Texture, type Particle } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { PixiVfxEffectInstance, PixiVfxRenderer } from "./renderer";
import { createPixiVfx2dProjection } from "./projection";
import { particlePrewarmCapacity } from "./particlePrewarm";
import {
  ParticleEmitterRuntimeState,
  normalizeParticleEffect,
  sampleParticleMotion,
} from "../../engine/particles";
import type { MaterialFixedDescriptor } from "../materials/artifact";
import type { PixiVfxFallbackTextures } from "./types";

/** Headless fallbacks: the procedural textures need a DOM canvas. */
function testFallbackTextures(): PixiVfxFallbackTextures {
  return {
    circle: Texture.WHITE,
    square: Texture.WHITE,
    triangleShard: Texture.WHITE,
    quadShard: Texture.WHITE,
    grassShard: Texture.WHITE,
  };
}

const effect = {
  emitters: [
    {
      id: "bounded",
      maxParticles: 1000,
      duration: 1,
      loop: false,
      render: { texture: "particle.png" },
      spawn: {
        rate: 0,
        rateValue: { mode: "constant", value: 0 },
        bursts: [{ time: 0, count: 4, cycles: 1, interval: 0, probability: 1 }],
      },
    },
  ],
};

function createInstance(
  staticAssets: boolean,
  getTexture = vi.fn(() => Texture.EMPTY),
) {
  return {
    getTexture,
    instance: new PixiVfxEffectInstance({
      effect,
      textureProvider: { staticAssets, getTexture },
      fallbackTextures: testFallbackTextures(),
      autoStart: false,
    }),
  };
}

describe("retained imported VFX work", () => {
  it("refreshes the cached Tier-1 fold when a definition change keeps the render key", () => {
    // The Tier-1 render key is "materialShaderId:sprite-master": changing the
    // instance params changes the fold WITHOUT rebuilding the view, so the
    // cached fold has to be refreshed in place.
    const materialEffect = (tint: [number, number, number, number]) => ({
      emitters: [
        {
          ...effect.emitters[0],
          modules: { color: false },
          render: {
            texture: "particle.png",
            depthInk: false,
            material: {
              id: "mi-tint",
              shaderId: "sprite-master",
              paramOverrides: { Tint: tint },
            },
          },
        },
      ],
    });
    const instance = new PixiVfxEffectInstance({
      effect: materialEffect([1, 0, 0, 1]),
      textureProvider: { staticAssets: true, getTexture: () => Texture.EMPTY },
      fallbackTextures: testFallbackTextures(),
      autoStart: false,
    });
    try {
      instance.spawn({ seed: 1 });
      instance.update(0.01);
      const views = (
        instance as unknown as {
          emitterViews: {
            key: string;
            container: ParticleContainer<Particle>;
            materialFixed: MaterialFixedDescriptor;
          }[];
        }
      ).emitterViews;
      const view = views[0]!;
      const key = view.key;
      const particle = view.container.particleChildren[0]!;
      expect(particle).toBeDefined();
      expect(view.materialFixed).toMatchObject({ tint: [1, 0, 0, 1] });
      expect((particle.tint as number) >> 16).toBeGreaterThan(200);
      expect((particle.tint as number) & 0xffff).toBe(0);

      instance.updateDefinition(materialEffect([0, 1, 0, 1]));
      instance.spawn({ seed: 1 });
      instance.update(0.01);

      expect(views[0]).toBe(view);
      expect(view.key).toBe(key);
      expect(view.materialFixed).toMatchObject({ tint: [0, 1, 0, 1] });
      const next = view.container.particleChildren[0]!;
      expect((next.tint as number) & 0xff0000).toBe(0);
      expect((next.tint as number) & 0x00ff00).toBeGreaterThan(0);
    } finally {
      instance.destroy();
    }
  });

  it("prewarms the authored burst rather than all 1000 simulation slots", () => {
    const emitter = normalizeParticleEffect(effect).emitters[0]!;
    expect(particlePrewarmCapacity(emitter)).toBe(4);
    const { instance } = createInstance(true);
    const views = (
      instance as unknown as { emitterViews: { pool: unknown[] }[] }
    ).emitterViews;
    expect(views[0]!.pool).toHaveLength(4);
    instance.destroy();
  });

  it("reuses imported render bindings and diagnostic arrays, while explicit providers refresh", () => {
    const { instance, getTexture } = createInstance(true);
    instance.spawn({ seed: 1 });
    const textureReads = getTexture.mock.calls.length;
    const missing = instance.stats.missingTextureRefs;
    for (let i = 1; i < 30; i++) instance.update(1 / 60);
    expect(getTexture).toHaveBeenCalledTimes(textureReads);
    expect(instance.stats.missingTextureRefs).toBe(missing);
    const replacement = vi.fn(() => Texture.WHITE);
    instance.setTextureProvider({
      staticAssets: true,
      getTexture: replacement,
    });
    expect(replacement).toHaveBeenCalled();
    instance.destroy();
  });

  it("keeps culled particles in the pool instead of allocating a new one each frame", () => {
    // A projection that culls everything: the pool must still retain its slot.
    const culled = new PixiVfxEffectInstance({
      effect,
      textureProvider: { staticAssets: false, getTexture: () => Texture.EMPTY },
      fallbackTextures: testFallbackTextures(),
      projection: {
        project: (_world, out) => {
          const point = out ?? { x: 0, y: 0, visible: false };
          point.x = 0;
          point.y = 0;
          point.visible = false;
          return point;
        },
        pixelsPerWorldUnit: () => 1,
      },
      autoStart: false,
    });
    culled.spawn({ seed: 1 });
    culled.update(0.01);
    const views = (
      culled as unknown as { emitterViews: { pool: Particle[] }[] }
    ).emitterViews;
    const pool = views[0]!.pool;
    const retained = [...pool];
    expect(retained.length).toBeGreaterThan(0);
    culled.update(1 / 60);
    expect(views[0]!.pool.slice(0, retained.length)).toEqual(retained);
    culled.destroy();
  });

  it("continues resolving mutable editor assets each draw", () => {
    const { instance, getTexture } = createInstance(false);
    instance.spawn({ seed: 1 });
    const reads = getTexture.mock.calls.length;
    instance.update(1 / 60);
    expect(getTexture.mock.calls.length).toBeGreaterThan(reads);
    expect(
      instance.root.children.some(
        (child) => child instanceof ParticleContainer,
      ),
    ).toBe(true);
    instance.destroy();
  });

  it("uses the provider's baked alpha variant when it offers one", () => {
    const baked = new Texture();
    const getAlphaTexture = vi.fn(() => baked);
    const instance = new PixiVfxEffectInstance({
      effect: {
        emitters: [
          {
            ...effect.emitters[0],
            render: { texture: "particle.png", opacitySource: "luminance" },
          },
        ],
      },
      textureProvider: {
        staticAssets: true,
        getTexture: () => Texture.WHITE,
        getAlphaTexture,
      },
      fallbackTextures: testFallbackTextures(),
      autoStart: false,
    });
    expect(getAlphaTexture).toHaveBeenCalledWith(
      expect.objectContaining({ path: "particle.png" }),
      "luminance",
      false,
    );
    const views = (
      instance as unknown as { emitterViews: { texture: Texture }[] }
    ).emitterViews;
    expect(views[0]!.texture).toBe(baked);
    instance.destroy();
  });

  it("falls back to runtime derivation when the provider has no baked variant", () => {
    const getAlphaTexture = vi.fn(() => undefined);
    const instance = new PixiVfxEffectInstance({
      effect: {
        emitters: [
          {
            ...effect.emitters[0],
            render: { texture: "particle.png", opacitySource: "luminance" },
          },
        ],
      },
      textureProvider: {
        staticAssets: true,
        getTexture: () => Texture.WHITE,
        getAlphaTexture,
      },
      fallbackTextures: testFallbackTextures(),
      autoStart: false,
    });
    expect(getAlphaTexture).toHaveBeenCalled();
    const views = (
      instance as unknown as { emitterViews: { texture: Texture }[] }
    ).emitterViews;
    // Headless: derivation is unavailable, so the source texture is kept.
    expect(views[0]!.texture).toBe(Texture.WHITE);
    instance.destroy();
  });

  it("adopts an externally created instance through addEffect", () => {
    const renderer = new PixiVfxRenderer({
      textureProvider: { staticAssets: true, getTexture: () => Texture.EMPTY },
      fallbackTextures: testFallbackTextures(),
    });
    const { instance } = createInstance(true);
    renderer.addEffect(instance);
    expect(renderer.root.children).toContain(instance.root);
    expect(renderer.bloomSourceRoot.children).toContain(instance.bloomRoot);
    expect(renderer.stats.effectCount).toBe(1);
    // Idempotent.
    renderer.addEffect(instance);
    expect(renderer.stats.effectCount).toBe(1);

    const detached = createInstance(true).instance;
    renderer.addEffect(detached, false);
    expect(renderer.root.children).not.toContain(detached.root);
    expect(renderer.stats.effectCount).toBe(2);
    renderer.destroy();
  });

  it("writes motion and projection outputs without replacing caller buffers", () => {
    const emitter = normalizeParticleEffect(effect).emitters[0]!;
    const state = new ParticleEmitterRuntimeState(1);
    const expected = sampleParticleMotion(emitter, state, 0, 0.1, 0.1);
    const out = {
      position: [999, 999, 999] as [number, number, number],
      velocity: [999, 999, 999] as [number, number, number],
    };
    const position = out.position;
    expect(
      sampleParticleMotion(emitter, state, 0, 0.1, 0.1, undefined, out),
    ).toBe(out);
    expect(out.position).toBe(position);
    expect(out).toEqual(expected);
    const projection = createPixiVfx2dProjection({
      pixelsPerUnit: 2,
      originX: 3,
    });
    const point = { x: 999, y: 999, visible: false };
    expect(projection.project([1, 2, 0], point)).toBe(point);
    expect(point).toEqual(projection.project([1, 2, 0]));
  });
});
