import {
  CanvasSource,
  Container,
  DOMAdapter,
  Particle,
  ParticleContainer,
  Rectangle,
  Texture,
} from "pixi.js";
import { describe, expect, it } from "vitest";
import { createPixiVfx2dProjection } from "./projection";
import {
  PixiVfxEffectInstance,
  PixiVfxRenderer,
  collectPixiVfxEffectTextureRefs,
  normalizePixiVfxEffect,
} from "./renderer";
import {
  collectPixiVfxUnsupportedFeatures,
  collectPixiVfxUnsupportedModules,
} from "./support";
import {
  createMaterialInstance,
  normalizeShaderGraph,
  type ShaderGraph,
} from "../schema/materials";
import { compileMaterial } from "../materials/compileMaterial";
import type { PixiVfxFallbackTextures, PixiVfxTextureProvider } from "./types";
import type { PixiVfxRenderTargetRenderer } from "./types";

describe("Pixi VFX runtime renderer", () => {
  it("normalizes exported effect-shaped data without editor fields", () => {
    const effect = normalizePixiVfxEffect({
      kind: "vfx-effect",
      version: 1,
      id: "exported-spark",
      name: "Exported Spark",
      emitters: [{ id: "spark-emitter", render: { texture: "fx/spark.png" } }],
    });

    expect(effect).toMatchObject({
      app: "vfx-editor",
      kind: "particle-effect",
      id: "exported-spark",
      name: "Exported Spark",
    });
    expect(effect.emitters[0]?.render.texture).toBe("fx/spark.png");
  });

  it("uses the texture provider and updates lifecycle stats", () => {
    const refs: string[] = [];
    const provider: PixiVfxTextureProvider = {
      getTexture(ref) {
        refs.push(ref.path);
        return Texture.EMPTY;
      },
    };
    const renderer = new PixiVfxRenderer({
      textureProvider: provider,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
    });

    const instance = renderer.createEffect(testEffect(), {
      seed: 123,
      timeSeconds: 0,
    });
    const alive = instance.update(1 / 60, 1 / 60);
    renderer.update(0, 1 / 60);

    expect(alive).toBe(true);
    expect(refs).toContain("fx/spark.png");
    expect(instance.stats.missingTextureRefs).toEqual([]);
    expect(instance.stats.emittedLastFrame).toBeGreaterThan(0);
    expect(instance.stats.activeParticles).toBeGreaterThan(0);
    expect(instance.stats.visibleParticles).toBeGreaterThan(0);
    expect(instance.stats.uploadBytesLastFrame).toBeGreaterThan(0);
    expect(instance.stats.renderGroupsLastFrame).toBeGreaterThan(0);
    expect(instance.stats.capacity).toBe(8);
    expect(renderer.stats.effectCount).toBe(1);
    expect(renderer.stats.activeParticles).toBe(instance.stats.activeParticles);

    renderer.destroy();
  });

  it("maps a premultiplied emitter to a normal container blend and forks the render key (I13-A)", () => {
    const provider: PixiVfxTextureProvider = {
      getTexture: () => Texture.EMPTY,
    };
    const viewForBlend = (blend: "alpha" | "premultiplied") => {
      const renderer = new PixiVfxRenderer({
        textureProvider: provider,
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      });
      const instance = renderer.createEffect(
        normalizePixiVfxEffect({
          id: `pixi-blend-${blend}`,
          emitters: [
            {
              id: `pixi-blend-${blend}-emitter`,
              maxParticles: 4,
              duration: 1,
              loop: false,
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
              },
              initializeParticle: { lifetime: { mode: "constant", value: 1 } },
              render: { texture: "fx/spark.png", blend },
            },
          ],
        }),
        { seed: 1, timeSeconds: 0 },
      );
      instance.update(1 / 60, 1 / 60);
      renderer.update(0, 1 / 60);
      const view = firstEmitterView(instance);
      const result = {
        blendMode: view.container.blendMode,
        effectiveBlend: view.effectiveBlend,
        key: view.key,
      };
      renderer.destroy();
      return result;
    };

    const alpha = viewForBlend("alpha");
    const premultiplied = viewForBlend("premultiplied");

    // Premultiplied composites through the same "normal" container blend as
    // alpha (= [ONE, 1-SA]); the premultiplied-tagged source is what keeps it
    // glow-capable.
    expect(alpha.blendMode).toBe("normal");
    expect(premultiplied.blendMode).toBe("normal");
    expect(premultiplied.effectiveBlend).toBe("premultiplied");

    // The render key forks on the blend, so any blend change rebuilds the view;
    // alpha's key stays free of the premultiplied marker (regression pin).
    expect(premultiplied.key).toContain("blend:premultiplied");
    expect(alpha.key).toContain("blend:alpha");
    expect(alpha.key).not.toContain("premultiplied");
  });

  it("tags the premultiplied emitter's bound source alphaMode via the derived-texture wiring (I13-A)", () => {
    // Headless has no DOM canvas globals, so the earlier premultiplied test uses
    // Texture.EMPTY (resource undefined) and the source-tagging branch is a
    // no-op there — deleting it would leave that test green. This test drives the
    // branch end to end: stub OffscreenCanvas and hand the provider a real
    // canvas-backed Texture, so resolvePremultipliedTexture ->
    // createPremultipliedSourceTexture actually retags the source. The
    // premultiplied source must carry alphaMode "premultiplied-alpha" while the
    // alpha emitter keeps the canvas source's default upload alphaMode.
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width = 8, height = 8) {
        this.width = width;
        this.height = height;
      }
      getContext(): unknown {
        return {};
      }
    }
    const globalWithCanvas = globalThis as { OffscreenCanvas?: unknown };
    const previousOffscreen = globalWithCanvas.OffscreenCanvas;
    globalWithCanvas.OffscreenCanvas = FakeOffscreenCanvas;
    try {
      const alphaModeForBlend = (blend: "alpha" | "premultiplied"): unknown => {
        const canvasTexture = new Texture({
          source: new CanvasSource({
            resource: new FakeOffscreenCanvas(8, 8) as never,
          }),
        });
        const provider: PixiVfxTextureProvider = {
          getTexture: () => canvasTexture,
        };
        const renderer = new PixiVfxRenderer({
          textureProvider: provider,
          fallbackTextures: testFallbackTextures(),
          projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        });
        const instance = renderer.createEffect(
          normalizePixiVfxEffect({
            id: `pixi-premult-source-${blend}`,
            emitters: [
              {
                id: `pixi-premult-source-${blend}-emitter`,
                maxParticles: 4,
                duration: 1,
                loop: false,
                spawn: {
                  rate: 0,
                  rateValue: { mode: "constant", value: 0 },
                  bursts: [
                    {
                      time: 0,
                      count: 1,
                      cycles: 1,
                      interval: 0,
                      probability: 1,
                    },
                  ],
                },
                initializeParticle: {
                  lifetime: { mode: "constant", value: 1 },
                },
                render: { texture: "fx/spark.png", blend },
              },
            ],
          }),
          { seed: 1, timeSeconds: 0 },
        );
        instance.update(1 / 60, 1 / 60);
        renderer.update(0, 1 / 60);
        const alphaMode = (
          firstEmitterView(instance).texture.source as { alphaMode: unknown }
        ).alphaMode;
        renderer.destroy();
        return alphaMode;
      };

      // Premultiplied retags the bound source; alpha leaves the canvas source's
      // default upload alphaMode intact (they MUST differ, or the wiring is dead).
      expect(alphaModeForBlend("premultiplied")).toBe("premultiplied-alpha");
      expect(alphaModeForBlend("alpha")).not.toBe("premultiplied-alpha");
    } finally {
      if (previousOffscreen === undefined) {
        delete globalWithCanvas.OffscreenCanvas;
      } else {
        globalWithCanvas.OffscreenCanvas = previousOffscreen;
      }
    }
  });

  it("keeps missing provider textures explicit while drawing fallbacks", () => {
    const provider: PixiVfxTextureProvider = {
      getTexture() {
        return undefined;
      },
    };
    const instance = new PixiVfxEffectInstance({
      effect: testEffect(),
      textureProvider: provider,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(1 / 60, 1 / 60);

    expect(instance.stats.missingTextureRefs).toEqual([
      { type: "texture", id: "spark", path: "fx/spark.png" },
    ]);
    expect(instance.stats.visibleParticles).toBeGreaterThan(0);

    instance.destroy();
  });

  it("does not report implemented Pixi runtime modules as unsupported", () => {
    const effect = normalizePixiVfxEffect({
      id: "supported",
      emitters: [
        {
          id: "supported-emitter",
          modules: {
            forceOverLifetime: true,
            externalForces: true,
            noise: true,
            lights: true,
            trails: true,
            customData: true,
            textureSheetAnimation: true,
          },
        },
      ],
    });

    expect(collectPixiVfxUnsupportedModules(effect)).toEqual([]);
    expect(collectPixiVfxUnsupportedFeatures(effect)).toEqual([]);
  });

  it("reports approximate render features (mesh mode, depth write)", () => {
    const effect = normalizePixiVfxEffect({
      id: "approximate-features",
      emitters: [
        {
          id: "approximate-emitter",
          mode: "mesh",
          render: { depthWrite: true },
        },
      ],
    });

    expect(collectPixiVfxUnsupportedModules(effect)).toEqual([]);
    expect(collectPixiVfxUnsupportedFeatures(effect)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureKey: "mode.mesh",
          path: "emitters.0.mode",
        }),
        expect.objectContaining({
          featureKey: "render.depthWrite",
          path: "emitters.0.render.depthWrite",
        }),
      ]),
    );
    expect(collectPixiVfxUnsupportedFeatures(effect)).toHaveLength(2);
  });

  it("collects texture refs without importing the export compiler", () => {
    expect(collectPixiVfxEffectTextureRefs(testEffect())).toEqual([
      { type: "texture", id: "spark", path: "fx/spark.png" },
    ]);
  });

  it("preserves HDR emissive intensity without reporting it unsupported", () => {
    const hdr = normalizePixiVfxEffect({
      id: "hdr-effect",
      emitters: [
        {
          id: "hdr",
          initializeParticle: {
            color: { intensity: { mode: "constant", value: 4 } },
          },
        },
      ],
    });
    // HDR intensity survives normalization (preserved for export).
    expect(hdr.emitters[0]?.initializeParticle.color.intensity.value).toBe(4);
    expect(
      collectPixiVfxUnsupportedFeatures(hdr).some(
        (feature) =>
          feature.featureKey === "initializeParticle.color.intensity",
      ),
    ).toBe(false);
  });

  it("renders with a non-textureAlpha opacity source, falling back when pixels are unavailable", () => {
    const provider: PixiVfxTextureProvider = {
      getTexture() {
        return Texture.WHITE;
      },
    };
    const renderer = new PixiVfxRenderer({
      textureProvider: provider,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
    });
    const effect = {
      id: "opacity-effect",
      emitters: [
        {
          id: "opacity-emitter",
          maxParticles: 4,
          duration: 1,
          loop: false,
          modules: { color: false, rotation: false },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 1 },
            velocity: {
              mode: "shapeDirection",
              speed: { mode: "constant", value: 0 },
            },
          },
          billboard: { sizeValue: { mode: "constant", value: 0.5 } },
          render: { texture: "fx/mask.png", opacitySource: "luminance" },
        },
      ],
    };
    const instance = renderer.createEffect(effect, { seed: 1, timeSeconds: 0 });
    instance.update(1 / 60, 1 / 60);

    // Headless: no canvas/pixels to derive from, so the renderer falls back to
    // the source texture without crashing and still draws the particle.
    expect(firstParticle(instance).texture).toBe(Texture.WHITE);
    expect(instance.stats.activeParticles).toBeGreaterThan(0);

    renderer.destroy();
  });

  it("orders emitter render views by render.orderInLayer", () => {
    // Distinct textures let us identify which emitter each container belongs to.
    const provider: PixiVfxTextureProvider = {
      getTexture(ref) {
        return ref.path === "fx/high.png" ? Texture.WHITE : Texture.EMPTY;
      },
    };
    const renderer = new PixiVfxRenderer({
      textureProvider: provider,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
    });
    const instance = renderer.createEffect(orderInLayerEffect(), {
      seed: 1,
      timeSeconds: 0,
    });
    instance.update(1 / 60, 1 / 60);

    const containers = particleContainers(instance);
    // Two emitters -> four containers ([trail, main] each).
    expect(containers).toHaveLength(4);
    // Emitter "low" authored first (index 0) has orderInLayer 5; "high" (index
    // 1) has orderInLayer 9, so "low" draws behind and "high" draws on top.
    expect(containers[0]?.texture).toBe(Texture.EMPTY);
    expect(containers[1]?.texture).toBe(Texture.EMPTY);
    expect(containers[2]?.texture).toBe(Texture.WHITE);
    expect(containers[3]?.texture).toBe(Texture.WHITE);

    renderer.destroy();
  });

  it("keeps authored emitter order when order in layer ties", () => {
    const provider: PixiVfxTextureProvider = {
      getTexture(ref) {
        return ref.path === "fx/high.png" ? Texture.WHITE : Texture.EMPTY;
      },
    };
    const renderer = new PixiVfxRenderer({
      textureProvider: provider,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
    });
    const instance = renderer.createEffect(orderInLayerEffect(0, 0), {
      seed: 1,
      timeSeconds: 0,
    });
    instance.update(1 / 60, 1 / 60);

    const containers = particleContainers(instance);
    expect(containers).toHaveLength(4);
    // Equal order -> authored array order: "low" (index 0) first, "high" second.
    expect(containers[0]?.texture).toBe(Texture.EMPTY);
    expect(containers[2]?.texture).toBe(Texture.WHITE);

    renderer.destroy();
  });

  it("can attach instances to an existing Pixi container", () => {
    const parent = new Container();
    const renderer = new PixiVfxRenderer({
      parent,
      fallbackTextures: testFallbackTextures(),
    });

    expect(parent.children).toContain(renderer.root);

    renderer.destroy();
  });

  it("can split simulation from ParticleContainer buffer updates", () => {
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
    });

    renderer.createEffect(testEffect(), {
      seed: 123,
      timeSeconds: 0,
    });
    const simulated = renderer.update(1 / 60, {
      timeSeconds: 1 / 60,
      draw: false,
    });
    const drawn = renderer.draw(1 / 60);

    expect(simulated.activeParticles).toBeGreaterThan(0);
    expect(drawn.visibleParticles).toBeGreaterThan(0);
    expect(drawn.activeParticles).toBe(simulated.activeParticles);

    renderer.destroy();
  });

  it("rotates particles from align-to-direction sidecar data", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "align-effect",
        emitters: [
          {
            id: "align-emitter",
            maxParticles: 1,
            modules: { velocity: true, rotation: false, color: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
              alignToDirection: true,
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              // Pin start rotation to 0 so this test isolates the align angle
              // (B4: start rotation now applies even with the module off).
              rotation: { mode: "constant", value: 0 },
              velocity: {
                mode: "vector",
                min: [1, 0, 0],
                max: [1, 0, 0],
                speed: { mode: "constant", value: 0 },
              },
            },
            billboard: {
              sizeValue: { mode: "constant", value: 0.5 },
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    expect(firstParticle(instance).rotation).toBeCloseTo(0);

    instance.destroy();
  });

  it("adds start rotation on top of align-to-direction (B4/F10)", () => {
    const makeAligned = (startRotation: number) =>
      new PixiVfxEffectInstance({
        effect: {
          id: "align-start-rotation",
          emitters: [
            {
              id: "align-start-rotation-emitter",
              maxParticles: 1,
              modules: { velocity: true, rotation: false, color: false },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
                shape: "point",
                alignToDirection: true,
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                rotation: { mode: "constant", value: startRotation },
                angularVelocity: { mode: "constant", value: 0 },
                velocity: {
                  mode: "vector",
                  min: [1, 1, 0],
                  max: [1, 1, 0],
                  speed: { mode: "constant", value: 0 },
                },
              },
              billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            },
          ],
        },
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

    // The diff isolates the start-rotation term from whatever align angle the
    // direction projects to, proving start rotation is an additive offset.
    const baseline = makeAligned(0);
    baseline.update(0.01, 0.01);
    const baseRotation = firstParticle(baseline).rotation;
    baseline.destroy();

    const offset = 0.6;
    const withStart = makeAligned(offset);
    withStart.update(0.01, 0.01);
    expect(firstParticle(withStart).rotation).toBeCloseTo(
      baseRotation + offset,
      4,
    );
    withStart.destroy();
  });

  it("aligns particles to current velocity through renderer alignment", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "velocity-align-effect",
        emitters: [
          {
            id: "velocity-align-emitter",
            maxParticles: 1,
            modules: { velocity: true, rotation: false, color: false },
            render: { alignment: "velocity" },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              rotation: { mode: "constant", value: 0 },
              angularVelocity: { mode: "constant", value: 0 },
              velocity: {
                mode: "vector",
                min: [0, 1, 0],
                max: [0, 1, 0],
                speed: { mode: "constant", value: 0 },
              },
            },
            billboard: { sizeValue: { mode: "constant", value: 0.5 } },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    expect(firstParticle(instance).rotation).toBeCloseTo(-Math.PI * 0.5, 4);

    instance.destroy();
  });

  it("re-points a velocity-aligned particle as noise turns its path (I13-F)", () => {
    const makeInstance = (noise: boolean) =>
      new PixiVfxEffectInstance({
        effect: {
          id: `velocity-noise-${noise}`,
          emitters: [
            {
              id: "velocity-noise-emitter",
              maxParticles: 1,
              duration: 1,
              loop: false,
              modules: { velocity: true, rotation: false, color: false, noise },
              render: { alignAxis: "velocity" },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
                shape: "point",
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                rotation: { mode: "constant", value: 0 },
                angularVelocity: { mode: "constant", value: 0 },
                velocity: {
                  mode: "vector",
                  min: [2, 0, 0],
                  max: [2, 0, 0],
                  speed: { mode: "constant", value: 0 },
                },
              },
              advanced: {
                noise: {
                  strength: { mode: "constant", value: 5 },
                  frequency: 1,
                  speed: 0.5,
                  scroll: [1, 1, 1],
                  octaves: 3,
                  damping: 0.5,
                },
              },
              billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            },
          ],
        },
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

    const withNoise = makeInstance(true);
    const withoutNoise = makeInstance(false);
    // Advance past the noise spawn ramp (normalizedAge > 0.1, life 1s).
    for (let i = 0; i < 12; i++) {
      withNoise.update(1 / 60, (i + 1) / 60);
      withoutNoise.update(1 / 60, (i + 1) / 60);
    }

    const noiseRotation = firstParticle(withNoise).rotation;
    const plainRotation = firstParticle(withoutNoise).rotation;
    expect(Number.isFinite(noiseRotation)).toBe(true);
    // Noise now steers the alignment; the noise-free rotation is unchanged.
    expect(Math.abs(noiseRotation - plainRotation)).toBeGreaterThan(0.01);

    withNoise.destroy();
    withoutNoise.destroy();
  });

  it("trail-stretch rotation ignores the effective velocity (I13-F Non-Goal)", () => {
    const makeInstance = (noise: boolean) =>
      new PixiVfxEffectInstance({
        effect: {
          id: `trail-noise-${noise}`,
          emitters: [
            {
              id: "trail-noise-emitter",
              maxParticles: 1,
              duration: 1,
              loop: false,
              modules: {
                velocity: true,
                rotation: false,
                color: false,
                trails: true,
                noise,
              },
              render: { alignAxis: "velocity" },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
                shape: "point",
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                rotation: { mode: "constant", value: 0 },
                angularVelocity: { mode: "constant", value: 0 },
                velocity: {
                  mode: "vector",
                  min: [2, 0, 0],
                  max: [2, 0, 0],
                  speed: { mode: "constant", value: 0 },
                },
              },
              advanced: {
                // length > 0 with speed > 0 makes stretchesAlongMotion true.
                trails: {
                  length: { mode: "constant", value: 2 },
                  width: { mode: "constant", value: 0.15 },
                  lifetime: { mode: "constant", value: 0.5 },
                  ratio: 1,
                  inheritColor: true,
                  textureMode: "stretch",
                  minVertexDistance: 0.001,
                  worldSpace: true,
                },
                noise: {
                  strength: { mode: "constant", value: 5 },
                  frequency: 1,
                  speed: 0.5,
                  scroll: [1, 1, 1],
                  octaves: 3,
                  damping: 0.5,
                },
              },
              billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            },
          ],
        },
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

    const withNoise = makeInstance(true);
    const withoutNoise = makeInstance(false);
    for (let i = 0; i < 12; i++) {
      withNoise.update(1 / 60, (i + 1) / 60);
      withoutNoise.update(1 / 60, (i + 1) / 60);
    }

    // Trail stretch keeps analytic velocity, which noise never touches. The only
    // residual is sub-1e-9 float rounding in the linear projection (noise shifts
    // `world`, re-rounding `world*ppu`); the >0.01 rad steering noise puts on the
    // NON-trail path (previous test) must not leak here.
    expect(
      Math.abs(
        firstParticle(withNoise).rotation -
          firstParticle(withoutNoise).rotation,
      ),
    ).toBeLessThan(1e-6);

    withNoise.destroy();
    withoutNoise.destroy();
  });

  it("uses explicit alignAxis for projected particle orientation", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "velocity-axis-effect",
        emitters: [
          {
            id: "velocity-axis-emitter",
            maxParticles: 1,
            modules: { velocity: true, rotation: false, color: false },
            render: { alignAxis: "velocity", facing: "cameraPlane" },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              rotation: { mode: "constant", value: 0 },
              angularVelocity: { mode: "constant", value: 0 },
              velocity: {
                mode: "vector",
                min: [0, 1, 0],
                max: [0, 1, 0],
                speed: { mode: "constant", value: 0 },
              },
            },
            billboard: { sizeValue: { mode: "constant", value: 0.5 } },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    expect(firstParticle(instance).rotation).toBeCloseTo(-Math.PI * 0.5, 4);

    instance.destroy();
  });

  it("foreshortens projected Pixi alignment only when facing is enabled", () => {
    const makeInstance = (facing: "cameraPlane" | "off") =>
      new PixiVfxEffectInstance({
        effect: {
          id: `pixi-foreshorten-${facing}`,
          emitters: [
            {
              id: `pixi-foreshorten-${facing}-emitter`,
              maxParticles: 1,
              modules: { velocity: true, rotation: false, color: false },
              render: { alignAxis: "velocity", facing },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  {
                    time: 0,
                    count: 1,
                    cycles: 1,
                    interval: 0,
                    probability: 1,
                  },
                ],
                shape: "point",
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                rotation: { mode: "constant", value: 0 },
                angularVelocity: { mode: "constant", value: 0 },
                velocity: {
                  mode: "vector",
                  min: [0, 0, 1],
                  max: [0, 0, 1],
                  speed: { mode: "constant", value: 0 },
                },
              },
              billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            },
          ],
        },
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

    const off = makeInstance("off");
    off.update(0.01, 0.01);
    const offScaleY = firstParticle(off).scaleY;

    const cameraFacing = makeInstance("cameraPlane");
    cameraFacing.update(0.01, 0.01);
    const facingScaleY = firstParticle(cameraFacing).scaleY;

    expect(facingScaleY).toBeLessThan(offScaleY * 0.05);

    off.destroy();
    cameraFacing.destroy();
  });

  it("keeps current-velocity orientation when the projected direction endpoint is offscreen", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "velocity-align-offscreen-endpoint-effect",
        emitters: [
          {
            id: "velocity-align-offscreen-endpoint-emitter",
            maxParticles: 1,
            modules: { velocity: true, rotation: false, color: false },
            render: { alignment: "velocity" },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              rotation: { mode: "constant", value: 0 },
              angularVelocity: { mode: "constant", value: 0 },
              velocity: {
                mode: "vector",
                min: [0, 1, 0],
                max: [0, 1, 0],
                speed: { mode: "constant", value: 0 },
              },
            },
            billboard: { sizeValue: { mode: "constant", value: 0.5 } },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: {
        project(world) {
          return {
            x: world[0] * 100,
            y: world[1] * 100,
            visible: world[1] < 0.5,
          };
        },
        pixelsPerWorldUnit() {
          return 100;
        },
      },
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    expect(firstParticle(instance).rotation).toBeCloseTo(Math.PI * 0.5, 4);

    instance.destroy();
  });

  it("selects texture sheet grid frames as particle textures", () => {
    const baseTexture = new Texture({
      source: Texture.WHITE.source,
      frame: new Rectangle(0, 0, 16, 16),
      orig: new Rectangle(0, 0, 16, 16),
    });
    const provider: PixiVfxTextureProvider = {
      getTexture() {
        return baseTexture;
      },
    };
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "sheet-effect",
        emitters: [
          {
            id: "sheet-emitter",
            maxParticles: 1,
            modules: {
              color: false,
              rotation: false,
              textureSheetAnimation: true,
            },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
            },
            render: { texture: "fx/sheet.png" },
            billboard: {
              sizeValue: { mode: "constant", value: 1 },
            },
            advanced: {
              textureSheetAnimation: {
                tiles: [2, 2],
                startFrame: 0,
                frameOverTime: { mode: "constant", value: 3 },
                cycles: 1,
                randomStartFrame: false,
              },
            },
          },
        ],
      },
      textureProvider: provider,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.5, 0.5);

    const frame = firstParticle(instance).texture.frame;
    expect(frame.x).toBeCloseTo(8);
    expect(frame.y).toBeCloseTo(8);
    expect(frame.width).toBeCloseTo(8);
    expect(frame.height).toBeCloseTo(8);

    instance.destroy();
    baseTexture.destroy(false);
  });

  it("selects texture sheet frames for Pixi Tier-2 material MainTex emitters", () => {
    withFakePixiDomAdapter(() => {
      const baseTexture = new Texture({
        source: Texture.WHITE.source,
        frame: new Rectangle(0, 0, 16, 16),
        orig: new Rectangle(0, 0, 16, 16),
      });
      const graph = textureDynamicParameterGraph();
      const material = createMaterialInstance(graph, "mi-sheet-tier2");
      material.mainTex = {
        type: "texture",
        id: "sheet",
        path: "fx/sheet.png",
      };
      const instance = new PixiVfxEffectInstance({
        effect: {
          id: "material-sheet-effect",
          emitters: [
            {
              id: "material-sheet-emitter",
              maxParticles: 1,
              modules: {
                color: false,
                rotation: false,
                textureSheetAnimation: true,
                customData: true,
              },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  {
                    time: 0,
                    count: 1,
                    cycles: 1,
                    interval: 0,
                    probability: 1,
                  },
                ],
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
              },
              render: { material },
              billboard: {
                sizeValue: { mode: "constant", value: 1 },
              },
              advanced: {
                textureSheetAnimation: {
                  tiles: [2, 2],
                  startFrame: 0,
                  frameOverTime: { mode: "constant", value: 3 },
                  cycles: 1,
                  randomStartFrame: false,
                },
                customData: {
                  channels: [
                    { mode: "constant", value: 1 },
                    { mode: "constant", value: 0 },
                    { mode: "constant", value: 0 },
                    { mode: "constant", value: 0 },
                  ],
                },
              },
            },
          ],
        },
        textureProvider: {
          getTexture(ref) {
            return ref.path === "fx/sheet.png" ? baseTexture : undefined;
          },
        },
        materialGraphProvider: (shaderId) =>
          shaderId === graph.id ? graph : undefined,
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

      instance.update(0.5, 0.5);

      const frame = firstParticle(instance).texture.frame;
      const mainContainer = particleContainers(instance)[1]!;
      const fragment = particleShaderFragment(mainContainer);
      expect(fragment).toContain("uTexture");
      expect(fragment).toContain("uniform vec4 uSubUv;");
      expect(particleContainerDynamicUvs(mainContainer)).toBe(true);
      expect(frame.x).toBeCloseTo(8);
      expect(frame.y).toBeCloseTo(8);
      expect(frame.width).toBeCloseTo(8);
      expect(frame.height).toBeCloseTo(8);

      instance.destroy();
      baseTexture.destroy(false);
    });
  });

  it("consumes sub-emitter requests through an injected effect provider", () => {
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      effectProvider: {
        getEffect(effectFile) {
          return effectFile === "child.json" ? childSubEffect() : undefined;
        },
      },
    });

    const instance = renderer.createEffect(parentSubEffect(), {
      seed: 5,
      timeSeconds: 0,
    });
    renderer.update(1 / 60, 1 / 60);

    expect(instance.stats.spawnedSubEmittersLastFrame).toBe(1);
    expect(instance.stats.missingSubEmitterRefs).toEqual([]);
    expect(instance.getRuntimeEvents().subEmitterRequests).toHaveLength(1);

    renderer.update(1 / 60, 2 / 60);

    expect(instance.stats.activeParticles).toBeGreaterThan(1);
    expect(instance.stats.visibleParticles).toBeGreaterThan(1);

    renderer.destroy();
  });

  it("keeps missing sub-emitter references explicit", () => {
    const instance = new PixiVfxEffectInstance({
      effect: parentSubEffect("missing.json"),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      effectProvider: {
        getEffect() {
          return undefined;
        },
      },
      seed: 5,
      timeSeconds: 0,
    });

    instance.update(1 / 60, 1 / 60);

    expect(instance.stats.spawnedSubEmittersLastFrame).toBe(0);
    expect(instance.stats.missingSubEmitterRefs).toEqual(["missing.json"]);

    instance.destroy();
  });

  it("renders persistent trail particles from particle history", () => {
    const instance = new PixiVfxEffectInstance({
      effect: trailEffect(),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 7,
      timeSeconds: 0,
    });

    instance.update(1 / 60, 1 / 60);
    instance.update(1 / 60, 2 / 60);
    instance.update(1 / 60, 3 / 60);

    expect(firstParticle(instance).x).toBeGreaterThan(0);
    expect(firstTrailParticle(instance).alpha).toBeGreaterThan(0);
    expect(instance.stats.visibleParticles).toBeGreaterThan(
      instance.stats.activeParticles,
    );

    instance.destroy();
  });

  it("treats trail length 0 as lifetime-limited instead of disabled", () => {
    const instance = new PixiVfxEffectInstance({
      effect: trailEffect({ length: { mode: "constant", value: 0 } }),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 7,
      timeSeconds: 0,
    });

    instance.update(1 / 60, 1 / 60);
    instance.update(1 / 60, 2 / 60);
    instance.update(1 / 60, 3 / 60);

    expect(firstTrailParticle(instance).alpha).toBeGreaterThan(0);

    instance.destroy();
  });

  it("respects trail ratio: 0 emits no trail points, 1 emits trails", () => {
    const makeInstance = (ratio: number) =>
      new PixiVfxEffectInstance({
        effect: trailEffect({ ratio }),
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 7,
        timeSeconds: 0,
      });

    const none = makeInstance(0);
    none.update(1 / 60, 1 / 60);
    none.update(1 / 60, 2 / 60);
    none.update(1 / 60, 3 / 60);
    expect(trailParticleCount(none)).toBe(0);
    none.destroy();

    const all = makeInstance(1);
    all.update(1 / 60, 1 / 60);
    all.update(1 / 60, 2 / 60);
    all.update(1 / 60, 3 / 60);
    expect(trailParticleCount(all)).toBeGreaterThan(0);
    all.destroy();
  });

  it("samples trail width over normalized trail position", () => {
    const makeInstance = (trailOverrides: Record<string, unknown>) =>
      new PixiVfxEffectInstance({
        effect: trailEffect(trailOverrides),
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 7,
        timeSeconds: 0,
      });

    const straight = makeInstance({
      widthOverTrail: { mode: "constant", value: 1 },
    });
    const tapered = makeInstance({
      widthOverTrail: {
        mode: "curve",
        value: 1,
        min: 0,
        max: 1,
        curve: [
          { x: 0, y: 1 },
          { x: 1, y: 0 },
        ],
      },
    });

    for (let i = 1; i <= 35; i++) {
      straight.update(1 / 60, i / 60);
      tapered.update(1 / 60, i / 60);
    }

    expect(trailParticleCount(tapered)).toBeGreaterThan(1);
    expect(firstTrailParticle(tapered).scaleX).toBeLessThan(
      firstTrailParticle(straight).scaleX,
    );
    expect(lastTrailParticle(tapered).scaleX).toBeGreaterThan(
      firstTrailParticle(tapered).scaleX,
    );

    straight.destroy();
    tapered.destroy();
  });

  it("collects a trail texture through the texture-ref collector", () => {
    const refs = collectPixiVfxEffectTextureRefs(
      trailEffect({ texture: "fx/trail.png" }),
    );
    expect(refs.map((ref) => ref.path)).toContain("fx/trail.png");
  });

  it("reports a missing trail texture through missing-texture stats", () => {
    const provider: PixiVfxTextureProvider = {
      getTexture() {
        return undefined;
      },
    };
    const instance = new PixiVfxEffectInstance({
      effect: trailEffect({ texture: "fx/trail.png" }),
      textureProvider: provider,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 7,
      timeSeconds: 0,
    });

    instance.update(1 / 60, 1 / 60);

    expect(instance.stats.missingTextureRefs.map((ref) => ref.path)).toContain(
      "fx/trail.png",
    );

    instance.destroy();
  });

  it("prunes older trail points sooner with a shorter authored lifetime", () => {
    // Keep the particle alive for the whole test (long particle lifetime) and a
    // long trail length so length pruning never kicks in — the only difference
    // between the two effects is the authored trail-point lifetime. A shorter
    // lifetime must retain fewer trail points after the same elapsed time.
    const makeInstance = (lifetime: number) => {
      const instance = new PixiVfxEffectInstance({
        effect: trailMotionEffect(lifetime),
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 7,
        timeSeconds: 0,
      });
      for (let frame = 1; frame <= 60; frame++) {
        instance.update(1 / 60, frame / 60);
      }
      return instance;
    };

    const shortLived = makeInstance(0.1);
    const longLived = makeInstance(1.0);

    expect(trailParticleCount(shortLived)).toBeGreaterThan(0);
    expect(trailParticleCount(longLived)).toBeGreaterThan(
      trailParticleCount(shortLived),
    );

    shortLived.destroy();
    longLived.destroy();
  });

  it("composes initialize color * intensity over the color-over-life gradient", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "init-color-effect",
        emitters: [
          {
            id: "init-color-emitter",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: { color: true, rotation: false, velocity: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              // Initial color red, half intensity (0.5 RGB multiplier).
              color: {
                mode: "constant",
                color: [1, 0, 0, 1],
                intensity: { mode: "constant", value: 0.5 },
              },
            },
            billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            render: { depthInk: false },
            // Color over Lifetime is a flat 0.5 grey multiplier, alpha 0.5.
            color: {
              gradient: {
                mode: "blend",
                colorStops: [
                  { position: 0, color: [0.5, 0.5, 0.5] },
                  { position: 1, color: [0.5, 0.5, 0.5] },
                ],
                alphaStops: [
                  { position: 0, alpha: 0.5 },
                  { position: 1, alpha: 0.5 },
                ],
              },
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    const particle = firstParticle(instance);
    // Final R = init(1) * intensity(0.5) * overLife(0.5) = 0.25 -> ~64/255.
    // (A small per-particle grain ~0.94..1.06 is applied to RGB.)
    const r = (particle.tint as number) >> 16;
    expect(r).toBeGreaterThan(55);
    expect(r).toBeLessThan(75);
    // Green/blue stay 0 because init color is pure red.
    expect((particle.tint as number) & 0xffff).toBe(0);
    // Final alpha = init alpha(1) * overLife alpha(0.5) = 0.5.
    expect(particle.alpha).toBeCloseTo(0.5, 2);

    instance.destroy();
  });

  function materialEmitterEffect(
    material: unknown,
    alpha = 1,
    color: [number, number, number, number] = [1, 1, 1, alpha],
    customDataChannels?: unknown[],
  ): unknown {
    return {
      id: "material-effect",
      emitters: [
        {
          id: "mat-emitter",
          maxParticles: 1,
          duration: 1,
          loop: false,
          modules: {
            color: false,
            rotation: false,
            velocity: false,
            customData: !!customDataChannels,
          },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 1 },
            color: {
              mode: "constant",
              color,
              intensity: { mode: "constant", value: 1 },
            },
          },
          advanced: customDataChannels
            ? { customData: { channels: customDataChannels } }
            : undefined,
          billboard: { sizeValue: { mode: "constant", value: 0.5 } },
          render: { depthInk: false, material },
        },
      ],
    };
  }

  it("folds a Tier-1 material Tint into the per-particle color (SE2)", () => {
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-red",
        shaderId: "sprite-master",
        paramOverrides: { Tint: [1, 0, 0, 1] },
      }),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });
    instance.update(0.01, 0.01);
    const tint = firstParticle(instance).tint as number;
    // White init * red Tint -> red tint, green/blue zeroed.
    expect(tint >> 16).toBeGreaterThan(200);
    expect(tint & 0xffff).toBe(0);
    instance.destroy();
  });

  it("folds a Tier-1 material Opacity into the particle alpha (SE2)", () => {
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-fade",
        shaderId: "sprite-master",
        paramOverrides: { Opacity: 0.5 },
      }),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });
    instance.update(0.01, 0.01);
    // baseAlpha = init(1) * overLife(1) * tintA(1) * Opacity(0.5) = 0.5.
    expect(firstParticle(instance).alpha).toBeCloseTo(0.5, 2);
    instance.destroy();
  });

  it("renders byte-identically with a default Sprite Master material vs none", () => {
    const make = (material: unknown) => {
      const instance = new PixiVfxEffectInstance({
        effect: materialEmitterEffect(material),
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });
      instance.update(0.01, 0.01);
      const p = firstParticle(instance);
      const sample = { tint: p.tint as number, alpha: p.alpha };
      instance.destroy();
      return sample;
    };
    // A Sprite Master instance with no overrides must be identity vs no material.
    const none = make(null);
    const defaulted = make({ id: "mi", shaderId: "sprite-master" });
    expect(defaulted).toEqual(none);
  });

  // M6-E: prove materials now affect the particle via the RENDERER's
  // per-particle fold (resolveEmitterMaterialFixed → updateParticle), not the
  // editor preview evaluator.
  it("M6-E: a faithful non-white Tint graph tints the particle (differs from the texture-only baseline)", () => {
    const graph = tintParamGraph([1, 0, 0, 1]);
    const sampleWith = (material: unknown) => {
      const instance = new PixiVfxEffectInstance({
        effect: materialEmitterEffect(material),
        materialGraphProvider: (shaderId) =>
          shaderId === graph.id ? graph : undefined,
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });
      instance.update(0.01, 0.01);
      const tint = firstParticle(instance).tint as number;
      instance.destroy();
      return tint;
    };
    // texture-only baseline = NO material (identity per-particle tint).
    const baseline = sampleWith(null);
    const tinted = sampleWith({ id: "mi-tint", shaderId: graph.id });
    // The red Tint folds into the per-particle tint, so it must DIFFER from the
    // untinted baseline (white init × red Tint → green/blue zeroed).
    expect(tinted).not.toBe(baseline);
    expect((tinted as number) & 0xffff).toBe(0); // green+blue zeroed by red Tint
  });

  it("M6-E: a particleColor→baseColor graph escalates to a Tier-2 shader (no longer a silent Tier-1 no-op)", () => {
    const graph = particleColorBaseColorGraph();
    // The renderer resolves this graph's artifact via the same compileMaterial
    // path; pre-M6-A it was tier1-fixed{tint:[1,1,1,1]} (identity), so its
    // resolveEmitterMaterialFixed would have produced a no-op tint. Now it is a
    // genuine Tier-2 program (distinct shaderId, not the shared sprite-master).
    const art = compileMaterial(graph, createMaterialInstance(graph, "mi"));
    expect(art.tier).toBe("tier2-shader");
    expect(art.shaderId).not.toBe("sprite-master");
    // And it is NOT folded as a Tier-1 fixed tint (which would be the bug).
    expect(art.tier).not.toBe("tier1-fixed");
  });

  it("I10-H: gates emitter color and alpha for custom materials without Particle Color", () => {
    const graph = tintParamGraph([0.5, 0.5, 0.5, 1]);
    const sample = (color: [number, number, number, number]) => {
      const instance = new PixiVfxEffectInstance({
        effect: materialEmitterEffect(
          { id: "mi-tint-gated", shaderId: graph.id },
          1,
          color,
        ),
        materialGraphProvider: (shaderId) =>
          shaderId === graph.id ? graph : undefined,
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });
      instance.update(0.01, 0.01);
      const particle = firstParticle(instance);
      const result = { tint: particle.tint as number, alpha: particle.alpha };
      instance.destroy();
      return result;
    };

    expect(sample([1, 0, 0, 0.2])).toEqual(sample([0, 0, 1, 0.8]));
  });

  it("reports missing material graphs instead of hiding them behind Sprite Master", () => {
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-ghost",
        shaderId: "M_Ghost",
      }),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    expect(instance.stats.missingMaterialRefs).toEqual(["M_Ghost"]);
    expect(instance.stats.activeParticles).toBe(1);
    expect(instance.stats.visibleParticles).toBe(0);
    expect(particleContainers(instance)[1]?.particleChildren).toHaveLength(0);

    instance.destroy();
  });

  it("feeds the material MainTex into the shared container texture (SE2)", () => {
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-tex",
        shaderId: "sprite-master",
        mainTex: { type: "texture", id: "diffuse", path: "mat/diffuse.png" },
      }),
      textureProvider: {
        getTexture(ref) {
          return ref.path === "mat/diffuse.png" ? Texture.WHITE : undefined;
        },
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });
    instance.update(0.01, 0.01);
    const mainContainer = particleContainers(instance)[1];
    expect(mainContainer?.texture).toBe(Texture.WHITE);
    instance.destroy();
  });

  it("applies Tier-1 material Panner as animated particle UVs", () => {
    const baseTexture = unitTexture();
    const graph = scrollingTextureGraph([0.25, -0.125]);
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-pan",
        shaderId: graph.id,
        mainTex: { type: "texture", id: "noise", path: "mat/noise.png" },
      }),
      textureProvider: {
        getTexture(ref) {
          return ref.path === "mat/noise.png" ? baseTexture : undefined;
        },
      },
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.5, 0.5);

    const particle = firstParticle(instance);
    expect(particle.texture).not.toBe(baseTexture);
    expect(particle.texture.source.addressMode).toBe("repeat");
    expect(particle.texture.uvs.x0).toBeCloseTo(0.125, 5);
    expect(particle.texture.uvs.y0).toBeCloseTo(-0.0625, 5);
    expect(particle.texture.uvs.x1).toBeCloseTo(1.125, 5);
    expect(particle.texture.uvs.y2).toBeCloseTo(0.9375, 5);

    const mainContainer = particleContainers(instance)[1]!;
    expect(particleContainerDynamicUvs(mainContainer)).toBe(true);

    instance.destroy();
    baseTexture.destroy(false);
  });

  it("applies Tier-1 material Rotator as animated particle UVs", () => {
    const baseTexture = unitTexture();
    const graph = rotatingTextureGraph(0.25);
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-rotate",
        shaderId: graph.id,
        mainTex: { type: "texture", id: "swirl", path: "mat/swirl.png" },
      }),
      textureProvider: {
        getTexture(ref) {
          return ref.path === "mat/swirl.png" ? baseTexture : undefined;
        },
      },
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(1, 1);

    const uvs = firstParticle(instance).texture.uvs;
    expect(uvs.x0).toBeCloseTo(1, 5);
    expect(uvs.y0).toBeCloseTo(0, 5);
    expect(uvs.x1).toBeCloseTo(1, 5);
    expect(uvs.y1).toBeCloseTo(1, 5);
    expect(uvs.x2).toBeCloseTo(0, 5);
    expect(uvs.y2).toBeCloseTo(1, 5);
    expect(uvs.x3).toBeCloseTo(0, 5);
    expect(uvs.y3).toBeCloseTo(0, 5);

    instance.destroy();
    baseTexture.destroy(false);
  });

  it("rebuilds emitter views when animated UV material parameters change", () => {
    const baseTexture = unitTexture();
    let graph = scrollingTextureGraph([0.1, 0]);
    const provider = (shaderId: string) =>
      shaderId === graph.id ? graph : undefined;
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-pan-key",
        shaderId: graph.id,
        mainTex: { type: "texture", id: "noise", path: "mat/noise.png" },
      }),
      textureProvider: {
        getTexture(ref) {
          return ref.path === "mat/noise.png" ? baseTexture : undefined;
        },
      },
      materialGraphProvider: provider,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    const before = particleContainers(instance)[1];
    graph = scrollingTextureGraph([0.2, 0], graph.id);
    instance.setMaterialGraphProvider(provider);
    const after = particleContainers(instance)[1];

    expect(after).not.toBe(before);

    instance.destroy();
    baseTexture.destroy(false);
  });

  it("keeps static material texture UVs non-dynamic", () => {
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-static",
        shaderId: "sprite-master",
      }),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    const mainContainer = particleContainers(instance)[1]!;
    expect(particleContainerDynamicUvs(mainContainer)).toBe(false);

    instance.destroy();
  });

  it("binds Tier-2 material shader to particle batches and drives pixel discard from particle data", () => {
    withFakePixiDomAdapter(() => {
      const baseTexture = unitTexture();
      const graph = tier2DissolveGraph(0.6);
      const instance = new PixiVfxEffectInstance({
        effect: materialEmitterEffect(
          {
            id: "mi-dissolve",
            shaderId: graph.id,
            mainTex: {
              type: "texture",
              id: "dissolve",
              path: "mat/dissolve.png",
            },
          },
          1,
          [1, 1, 1, 1],
          [
            { mode: "constant", value: 0.25 },
            { mode: "constant", value: 0 },
            { mode: "constant", value: 0 },
            { mode: "constant", value: 0 },
          ],
        ),
        textureProvider: {
          getTexture(ref) {
            return ref.path === "mat/dissolve.png" ? baseTexture : undefined;
          },
        },
        materialGraphProvider: (shaderId) =>
          shaderId === graph.id ? graph : undefined,
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

      instance.update(0.01, 0.01);

      const containers = particleContainers(instance);
      const trailContainer = containers[0]!;
      const mainContainer = containers[1]!;
      const bloomContainer = instance.bloomRoot.children.find(
        (child): child is ParticleContainer =>
          child instanceof ParticleContainer,
      )!;
      expect(particleShaderFragment(mainContainer)).toContain(
        "if (maskValue < uClipValue) discard;",
      );
      expect(particleShaderFragment(mainContainer)).toContain("uDynamicParams");
      expect(particleShaderFragment(mainContainer)).toContain(
        "step(vec4(0.60000000)",
      );
      expect(particleShaderFragment(trailContainer)).toContain(
        "uDynamicParams",
      );
      expect(particleShaderFragment(bloomContainer)).toContain(
        "uDynamicParams",
      );
      // CPU-side particle alpha remains neutral; DynamicParameter now reads
      // Shader Custom Data's dedicated uDynamicParams uniform instead.
      expect(firstParticle(instance).alpha).toBeCloseTo(1, 2);

      instance.destroy();
      baseTexture.destroy(false);
    });
  });

  it("binds animated material opacity output into Tier-2 particle shaders", () => {
    withFakePixiDomAdapter(() => {
      const graph = animatedOpacityGraph();
      const instance = new PixiVfxEffectInstance({
        effect: materialEmitterEffect({
          id: "mi-animated-opacity",
          shaderId: graph.id,
        }),
        materialGraphProvider: (shaderId) =>
          shaderId === graph.id ? graph : undefined,
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

      instance.update(0.25, 0.25);

      const fragment = particleShaderFragment(particleContainers(instance)[1]!);
      expect(fragment).toContain("float opacityValue");
      expect(fragment).toContain("materialScalarNoise");
      expect(fragment).toContain("uTime");
      expect(fragment).toContain("1.0 - length((vUV");
      expect(instance.stats.missingMaterialRefs).toEqual([]);
      expect(
        instance.stats.unsupportedFeatures.some(
          (feature) =>
            feature.featureKey === "render.material.tier2ParticleShader",
        ),
      ).toBe(false);
      expect(instance.stats.visibleParticles).toBe(1);

      instance.destroy();
    });
  });

  it("blocks unsupported Tier-2 material variants instead of drawing default particles", () => {
    const graph = tier2DissolveGraph(0.6, 4);
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-wide-dissolve",
        shaderId: graph.id,
      }),
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    expect(instance.stats.missingMaterialRefs).toEqual([]);
    expect(instance.stats.unsupportedFeatures).toEqual([
      expect.objectContaining({
        emitterId: "mat-emitter",
        emitterIndex: 0,
        featureKey: "render.material.tier2ParticleShader",
        path: "emitters.0.render.material",
      }),
    ]);
    expect(instance.stats.unsupportedFeatures[0]?.reason).toContain(
      "custom Mesh path required",
    );
    expect(instance.stats.activeParticles).toBe(1);
    expect(instance.stats.visibleParticles).toBe(0);
    expect(particleContainers(instance)[1]?.particleChildren).toHaveLength(0);

    instance.destroy();
  });

  it("renders Tier-2 material graph output into particle pixels", async () => {
    const { chromium } = await import("playwright");
    const { createServer } = await import("vite");
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      resolve: {
        alias: {
          "@": `${process.cwd()}/src`,
        },
      },
      plugins: [
        {
          name: "tier2-pixel-test-page",
          configureServer(viteServer) {
            viteServer.middlewares.use(
              "/__tier2-pixel.html",
              (_request, response) => {
                response.setHeader("Content-Type", "text/html");
                response.end('<!doctype html><meta charset="utf-8">');
              },
            );
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) {
      await server.close();
      throw new Error("Expected Vite dev server URL");
    }
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 64, height: 64 },
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(new URL("/__tier2-pixel.html", url).toString());
      await page.setContent(
        '<!doctype html><meta charset="utf-8"><body><script type="module" src="/tests/pixi/tier2PixelSmoke.test-support.ts"></script></body>',
      );
      const result = await page
        .waitForFunction(
          () =>
            (
              window as unknown as {
                __tier2PixelResult?: unknown;
              }
            ).__tier2PixelResult,
          undefined,
          { timeout: 15_000 },
        )
        .catch((error: unknown) => {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${pageErrors.join("\n")}`,
          );
        });
      const pixels = (await result.jsonValue()) as {
        plainColorSum: number;
        plainAlphaSum: number;
        plainVisibleParticles: number;
        tier2ColorSum: number;
        tier2AlphaSum: number;
        tier2VisibleParticles: number;
        differs: boolean;
        error?: string;
      };
      expect(pixels.plainVisibleParticles).toBeGreaterThan(0);
      expect(pixels.tier2VisibleParticles).toBeGreaterThan(0);
      expect(pixels.plainAlphaSum).toBeGreaterThan(0);
      expect(pixels.tier2AlphaSum).toBeGreaterThan(0);
      expect(pixels.error).toBeUndefined();
      expect(pixels.tier2ColorSum).toBeGreaterThan(0);
      expect(pixels.differs).toBe(true);
      expect(pixels.tier2ColorSum).not.toBe(pixels.plainColorSum);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 30_000);

  it("applies a non-default initial alpha to the rendered particle (F1)", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "init-alpha-effect",
        emitters: [
          {
            id: "init-alpha-emitter",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: { color: true, rotation: false, velocity: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              // Initial alpha 0.4 authored via color[3] (F1).
              color: {
                mode: "constant",
                color: [1, 1, 1, 0.4],
                intensity: { mode: "constant", value: 1 },
              },
            },
            billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            color: {
              gradient: {
                mode: "blend",
                colorStops: [
                  { position: 0, color: [1, 1, 1] },
                  { position: 1, color: [1, 1, 1] },
                ],
                alphaStops: [
                  { position: 0, alpha: 0.5 },
                  { position: 1, alpha: 0.5 },
                ],
              },
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);
    // Final alpha = init alpha(0.4) * overLife alpha(0.5) = 0.2.
    expect(firstParticle(instance).alpha).toBeCloseTo(0.2, 2);

    instance.destroy();
  });

  it("keeps per-particle grain frame-stable for a flat colour (B5)", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "grain-stable",
        emitters: [
          {
            id: "grain-emitter",
            maxParticles: 1,
            duration: 10,
            loop: false,
            modules: { color: true, rotation: false, velocity: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 10 },
              color: {
                mode: "constant",
                color: [1, 1, 1, 1],
                intensity: { mode: "constant", value: 1 },
              },
            },
            billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            color: {
              gradient: {
                mode: "blend",
                colorStops: [
                  { position: 0, color: [0.6, 0.6, 0.6] },
                  { position: 1, color: [0.6, 0.6, 0.6] },
                ],
                alphaStops: [
                  { position: 0, alpha: 1 },
                  { position: 1, alpha: 1 },
                ],
              },
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.1, 0.1);
    const tintEarly = firstParticle(instance).tint as number;
    instance.update(2, 2.1);
    const tintLater = firstParticle(instance).tint as number;
    // Flat colour + grain keyed on the per-particle seed => identical every
    // frame. Previously grain keyed on normalizedAge produced a per-frame
    // brightness sparkle even though the authored colour never changed.
    expect(tintLater).toBe(tintEarly);

    instance.destroy();
  });

  it("keeps draw order stable when an earlier particle dies (B5)", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "draw-order",
        emitters: [
          {
            id: "draw-order-emitter",
            maxParticles: 16,
            duration: 5,
            loop: false,
            modules: { color: true, rotation: false, velocity: false },
            render: { blend: "normal", depthTest: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              // One burst: all particles share a spawn time, so draw order is
              // decided purely by the stable per-particle seed tiebreaker.
              bursts: [
                { time: 0, count: 6, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              // Random lifetimes => particles die at different times, so a single
              // advance kills SOME of them (partial death + swap-remove).
              lifetime: { mode: "random", min: 0.15, max: 0.6 },
              // Gradient-by-seed gives each particle a distinct, age-independent
              // grey, so draw order is identifiable by tint across frames.
              color: {
                mode: "gradient",
                intensity: { mode: "constant", value: 1 },
                gradient: {
                  mode: "blend",
                  colorStops: [
                    { position: 0, color: [0.1, 0.1, 0.1] },
                    { position: 1, color: [0.95, 0.95, 0.95] },
                  ],
                  alphaStops: [
                    { position: 0, alpha: 1 },
                    { position: 1, alpha: 1 },
                  ],
                },
              },
            },
            billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            // Flat over-life colour so the per-particle gradient-by-seed tint is
            // the only thing distinguishing/identifying particles across frames.
            color: {
              gradient: {
                mode: "blend",
                colorStops: [
                  { position: 0, color: [1, 1, 1] },
                  { position: 1, color: [1, 1, 1] },
                ],
                alphaStops: [
                  { position: 0, alpha: 1 },
                  { position: 1, alpha: 1 },
                ],
              },
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 12,
      timeSeconds: 0,
    });

    const order = (): number[] => {
      const containers = particleContainers(instance);
      const live = containers[containers.length - 1]!;
      return Array.from(
        { length: live.particleChildren.length },
        (_, i) => (live.particleChildren[i] as Particle).tint as number,
      );
    };

    // Spawn the burst and let them all settle (all alive at 0.1).
    instance.update(0.1, 0.1);
    const before = order();
    expect(before.length).toBe(6);
    // Each particle has a distinct tint (gradient-by-seed) so identity is sound.
    expect(new Set(before).size).toBe(before.length);

    // Advance so the shorter-lived particles die; no further bursts are scheduled.
    instance.update(0.35, 0.45);
    const after = order();
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before.length);

    // Every survivor kept its colour (stable identity through compaction) AND its
    // relative draw order — no swap-remove reshuffle.
    const survivorsInOldOrder = before.filter((tint) => after.includes(tint));
    expect(survivorsInOldOrder).toEqual(after);

    instance.destroy();
  });

  it("emissive intensity preserves hue and glows additively instead of whitening (B7)", () => {
    const makeOrange = (intensity: number) =>
      new PixiVfxEffectInstance({
        effect: {
          id: `emissive-${intensity}`,
          emitters: [
            {
              id: "emissive-emitter",
              maxParticles: 1,
              modules: { color: true, rotation: false, velocity: false },
              render: { blend: "additive" },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
                shape: "point",
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                color: {
                  mode: "constant",
                  color: [1, 0.5, 0, 1], // orange
                  intensity: { mode: "constant", value: intensity },
                },
              },
              billboard: { sizeValue: { mode: "constant", value: 0.5 } },
              color: {
                gradient: {
                  mode: "blend",
                  colorStops: [
                    { position: 0, color: [1, 1, 1] },
                    { position: 1, color: [1, 1, 1] },
                  ],
                  alphaStops: [
                    { position: 0, alpha: 0.25 },
                    { position: 1, alpha: 0.25 },
                  ],
                },
              },
            },
          ],
        },
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

    const low = makeOrange(1);
    low.update(0.01, 0.01);
    const lowParticle = firstParticle(low);
    const lowTint = lowParticle.tint as number;
    const lowR = lowTint >> 16;
    const lowG = (lowTint >> 8) & 0xff;
    const lowAlpha = lowParticle.alpha;
    low.destroy();

    const high = makeOrange(4);
    high.update(0.01, 0.01);
    const highParticle = firstParticle(high);
    const highTint = highParticle.tint as number;
    const highR = highTint >> 16;
    const highG = (highTint >> 8) & 0xff;
    const highB = highTint & 0xff;
    const highAlpha = highParticle.alpha;
    high.destroy();

    // Hue preserved at high intensity: green stays ~half of red (orange), NOT
    // pushed up to green==red (yellow/white), which the old per-channel clamp did.
    expect(highG).toBeLessThan(highR * 0.75);
    expect(highB).toBe(0);
    // Channel ratio is the same at low and high intensity (no hue shift).
    expect(highG / highR).toBeCloseTo(lowG / lowR, 1);
    // Additive overbright: intensity 4 reads brighter via a higher alpha.
    expect(highAlpha).toBeGreaterThan(lowAlpha);
  });

  it("I12-G: a masked/opaque material suppresses the additive overbright alpha boost", () => {
    // Tier-1 params-only graph: Emissive 4 folds a 5x overbright peak into the
    // per-particle color and Opacity 0.5 leaves headroom to observe the boost.
    const emissiveGraph = (
      blend: "normal" | "masked" | "opaque",
    ): ShaderGraph =>
      normalizeShaderGraph({
        id: `emissive-${blend}-material`,
        name: `Emissive ${blend} Material`,
        blend,
        params: [
          {
            name: "Emissive",
            type: "float",
            group: "Color",
            default: 4,
            scope: "per-material",
          },
          {
            name: "Opacity",
            type: "float",
            group: "Color",
            default: 0.5,
            scope: "per-material",
          },
        ],
        nodes: [],
        edges: [],
        outputs: {},
      });
    const sampleAlpha = (graph: ShaderGraph | null): number => {
      const instance = new PixiVfxEffectInstance({
        effect: {
          id: `additive-boost-${graph ? graph.blend : "none"}`,
          emitters: [
            {
              id: "boost-emitter",
              maxParticles: 1,
              modules: { color: false, rotation: false, velocity: false },
              render: {
                blend: "additive",
                depthInk: false,
                material: graph ? { id: "mi-boost", shaderId: graph.id } : null,
              },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
                shape: "point",
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                color: {
                  mode: "constant",
                  // The no-material control derives its 4x overbright peak and
                  // 0.5-alpha headroom from the emitter color instead of the
                  // material params (custom graphs gate emitter color, I10-H).
                  color: [1, 1, 1, graph ? 1 : 0.5],
                  intensity: { mode: "constant", value: graph ? 1 : 4 },
                },
              },
              billboard: { sizeValue: { mode: "constant", value: 0.5 } },
            },
          ],
        },
        materialGraphProvider: graph
          ? (shaderId) => (shaderId === graph.id ? graph : undefined)
          : undefined,
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });
      instance.update(0.01, 0.01);
      const alpha = firstParticle(instance).alpha;
      instance.destroy();
      return alpha;
    };

    // Legacy pin: a plain additive emitter keeps the overbright alpha boost.
    expect(sampleAlpha(null)).toBeGreaterThan(0.6);
    // A normal-blend material keeps the emitter's additive blend authoritative
    // (effective blend stays additive), so the boost still applies.
    expect(sampleAlpha(emissiveGraph("normal"))).toBeGreaterThan(0.6);
    // Masked/opaque materials override the emitter blend (I12-G): the additive
    // boost must NOT apply even though render.blend is "additive".
    expect(sampleAlpha(emissiveGraph("masked"))).toBeCloseTo(0.5, 5);
    expect(sampleAlpha(emissiveGraph("opaque"))).toBeCloseTo(0.5, 5);
  });

  it("keeps emissive overbright available for bloom after tint normalization", () => {
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      bloom: { enabled: true, quality: "low" },
    });

    const low = renderer.createEffect(emissiveBloomEffect({ intensity: 1 }), {
      seed: 1,
      timeSeconds: 0,
    });
    renderer.update(0.01, 0.01);
    const lowParticle = firstParticle(low);
    expect(low.stats.bloomSourceParticles).toBe(0);
    expect(renderer.stats.bloomSourceParticles).toBe(0);

    const lowTint = lowParticle.tint as number;
    const lowRatio = ((lowTint >> 8) & 0xff) / (lowTint >> 16);
    renderer.removeEffect(low);

    const high = renderer.createEffect(emissiveBloomEffect({ intensity: 4 }), {
      seed: 1,
      timeSeconds: 0,
    });
    renderer.update(0.01, 0.01);
    const highTint = firstParticle(high).tint as number;
    const highRatio = ((highTint >> 8) & 0xff) / (highTint >> 16);

    expect(high.stats.bloomSourceParticles).toBe(1);
    expect(renderer.stats.bloomSourceParticles).toBe(1);
    expect(renderer.stats.bloomActive).toBe(false);
    expect(renderer.stats.bloomPasses).toBe(0);
    // With preview bloom enabled BF8 lets the visible core roll toward white
    // instead of preserving hue forever; the unclamped HDR color still feeds
    // the bloom bright-pass separately.
    expect(highRatio).toBeGreaterThan(lowRatio);
    expect(highRatio).toBeLessThan(1);

    renderer.destroy();
  });

  it("keeps the HDR bloom source shape stable while encoding bright-pass color", () => {
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      bloom: { enabled: true, quality: "low" },
    });

    const plus3 = renderer.createEffect(emissiveBloomEffect({ intensity: 8 }), {
      seed: 1,
      timeSeconds: 0,
    });
    renderer.update(0.01, 0.01);
    const plus3Bloom = firstBloomParticle(plus3);
    const plus3Alpha = plus3Bloom.alpha;
    const plus3Scale = plus3Bloom.scaleX;
    renderer.removeEffect(plus3);

    const plus4 = renderer.createEffect(
      emissiveBloomEffect({ intensity: 16 }),
      {
        seed: 1,
        timeSeconds: 0,
      },
    );
    renderer.update(0.01, 0.01);
    const plus4Bloom = firstBloomParticle(plus4);
    const plus4Alpha = plus4Bloom.alpha;
    const plus4Scale = plus4Bloom.scaleX;
    renderer.removeEffect(plus4);

    const plus10 = renderer.createEffect(
      emissiveBloomEffect({ intensity: 1024 }),
      { seed: 1, timeSeconds: 0 },
    );
    renderer.update(0.01, 0.01);
    const plus10Bloom = firstBloomParticle(plus10);
    const plus10Alpha = plus10Bloom.alpha;
    renderer.removeEffect(plus10);

    const plus50 = renderer.createEffect(
      emissiveBloomEffect({ intensity: 2 ** 50 }),
      { seed: 1, timeSeconds: 0 },
    );
    renderer.update(0.01, 0.01);
    const plus50Bloom = firstBloomParticle(plus50);

    expect(plus3Alpha).toBeGreaterThan(0);
    expect(plus3Alpha).toBeLessThanOrEqual(1);
    expect(plus4Alpha).toBeGreaterThanOrEqual(plus3Alpha);
    expect(plus4Alpha).toBeLessThanOrEqual(1);
    expect(plus10Alpha).toBeGreaterThanOrEqual(plus4Alpha);
    expect(plus10Alpha).toBeLessThanOrEqual(1);
    // The HDR picker accepts +50 stops. The preview runs on 8-bit targets,
    // so it encodes bloom energy logarithmically instead of saturating by +10.
    expect(plus50Bloom.alpha).toBeGreaterThan(plus10Alpha);
    expect(plus50Bloom.alpha).toBeLessThanOrEqual(1);
    expect(plus4Scale).toBeCloseTo(plus3Scale, 5);
    expect(plus10Bloom.scaleX).toBeCloseTo(plus4Scale, 5);
    expect(plus50Bloom.scaleX).toBeCloseTo(plus4Scale, 5);

    const plus10Tint = plus10Bloom.tint as number;
    const plus10R = plus10Tint >> 16;
    const plus10G = (plus10Tint >> 8) & 0xff;
    expect(plus10G / plus10R).toBeCloseTo(0.5, 1);

    renderer.destroy();
  });

  it("does not renormalize an LDR bloom source to white when threshold is lowered below its peak", () => {
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      bloom: { enabled: true, quality: "low", threshold: 0.2 },
    });

    // Peak 0.6 is genuinely LDR (peak <= 1) but crosses the lowered 0.2
    // threshold, so copyBloomParticle runs. The pre-fix unconditional
    // tintScale = 1/brightPeak renormalized this straight to white.
    const instance = renderer.createEffect(
      emissiveBloomEffect({ color: [0.6, 0.6, 0.6, 1], intensity: 1 }),
      { seed: 1, timeSeconds: 0 },
    );
    renderer.update(0.01, 0.01);

    expect(instance.stats.bloomSourceParticles).toBe(1);
    const bloomTint = firstBloomParticle(instance).tint as number;
    const r = bloomTint >> 16;
    const g = (bloomTint >> 8) & 0xff;
    const b = bloomTint & 0xff;

    expect(r).toBeLessThan(250);
    expect(r).toBeCloseTo(102, 0);
    expect(g).toBeCloseTo(r, 0);
    expect(b).toBeCloseTo(r, 0);

    renderer.destroy();
  });

  it("tonemaps high HDR red toward yellow-white when preview bloom is enabled", () => {
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      bloom: { enabled: true, quality: "low" },
    });

    const instance = renderer.createEffect(
      emissiveBloomEffect({
        color: [1, 0, 0, 1],
        intensity: 2 ** 30,
        alpha: 1,
      }),
      { seed: 1, timeSeconds: 0 },
    );
    renderer.update(0.01, 0.01);

    const particleTint = firstParticle(instance).tint as number;
    const particleR = particleTint >> 16;
    const particleG = (particleTint >> 8) & 0xff;
    const particleB = particleTint & 0xff;
    expect(particleR).toBeGreaterThan(240);
    expect(particleG).toBeGreaterThan(200);
    expect(particleB).toBeGreaterThan(100);
    expect(particleB).toBeLessThan(180);

    const bloomTint = firstBloomParticle(instance).tint as number;
    expect(bloomTint >> 16).toBeGreaterThan(240);
    expect((bloomTint >> 8) & 0xff).toBeLessThan(8);
    expect(bloomTint & 0xff).toBeLessThan(8);

    renderer.destroy();
  });

  it("renders negative emissive stops as dark but nonzero before the quantization floor", () => {
    const instance = new PixiVfxEffectInstance({
      effect: emissiveBloomEffect({ intensity: 1 / 32 }),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    const tint = firstParticle(instance).tint as number;
    const red = tint >> 16;
    expect(red).toBeGreaterThan(0);
    expect(red).toBeLessThan(16);
    expect(instance.stats.bloomSourceParticles).toBe(0);

    instance.destroy();
  });

  it("gates bloom work when disabled or when no visible particle is over threshold", () => {
    const cases = [
      emissiveBloomEffect({ intensity: 1 }),
      emissiveBloomEffect({ intensity: 4, emitterEnabled: false }),
      emissiveBloomEffect({ intensity: 4, alpha: 0 }),
    ];
    for (const effect of cases) {
      const target = createFakeRenderTargetRenderer();
      const renderer = new PixiVfxRenderer({
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        pixiRenderer: target.renderer,
        bloom: { enabled: true, quality: "low" },
      });
      renderer.createEffect(effect, { seed: 1, timeSeconds: 0 });
      renderer.update(0.01, 0.01);

      expect(renderer.stats.bloomActive).toBe(false);
      expect(renderer.stats.bloomSourceParticles).toBe(0);
      expect(renderer.stats.bloomPasses).toBe(0);
      expect(target.calls).toHaveLength(0);

      renderer.destroy();
    }

    const culled = createFakeRenderTargetRenderer();
    const culledRenderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: {
        project: () => ({ x: 0, y: 0, visible: false }),
        pixelsPerWorldUnit: () => 100,
      },
      pixiRenderer: culled.renderer,
      bloom: { enabled: true, quality: "low" },
    });
    culledRenderer.createEffect(emissiveBloomEffect({ intensity: 4 }), {
      seed: 1,
      timeSeconds: 0,
    });
    culledRenderer.update(0.01, 0.01);
    expect(culledRenderer.stats.bloomSourceParticles).toBe(0);
    expect(culled.calls).toHaveLength(0);
    culledRenderer.destroy();

    const disabled = createFakeRenderTargetRenderer();
    const disabledRenderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      pixiRenderer: disabled.renderer,
      bloom: { enabled: false, quality: "off" },
    });
    disabledRenderer.createEffect(emissiveBloomEffect({ intensity: 4 }), {
      seed: 1,
      timeSeconds: 0,
    });
    disabledRenderer.update(0.01, 0.01);
    expect(disabledRenderer.stats.bloomSourceParticles).toBe(0);
    expect(disabled.calls).toHaveLength(0);
    disabledRenderer.destroy();
  });

  it("runs bloom as one post-process pass chain while reusing render targets", () => {
    const target = createFakeRenderTargetRenderer(640, 360);
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      pixiRenderer: target.renderer,
      bloom: { enabled: true, quality: "low" },
    });
    renderer.createEffect(
      emissiveBloomEffect({ intensity: 4, blend: "normal" }),
      {
        seed: 1,
        timeSeconds: 0,
      },
    );
    renderer.createEffect(
      emissiveBloomEffect({ intensity: 4, blend: "additive" }),
      {
        seed: 2,
        timeSeconds: 0,
      },
    );

    renderer.update(0.01, 0.01);
    expect(renderer.stats.bloomActive).toBe(true);
    expect(renderer.stats.bloomSourceParticles).toBe(2);
    expect(renderer.stats.bloomPasses).toBeGreaterThan(2);
    expect(renderer.stats.bloomRenderScale).toBe(0.25);
    expect(renderer.stats.renderGroupsLastFrame).toBe(4);
    expect(target.calls).toHaveLength(6);
    const firstSource = target.calls[0]?.target;
    const firstPyramidLevel = target.calls[1]?.target;
    const firstOutput = target.calls[target.calls.length - 1]?.target;
    expect(firstSource).toBeDefined();
    expect(firstPyramidLevel).toBeDefined();
    expect(firstOutput).toBeDefined();

    target.calls.length = 0;
    renderer.draw(0.02);
    expect(renderer.stats.bloomPasses).toBeGreaterThan(2);
    expect(target.calls).toHaveLength(6);
    expect(target.calls[0]?.target).toBe(firstSource);
    expect(target.calls[1]?.target).toBe(firstPyramidLevel);
    expect(target.calls[target.calls.length - 1]?.target).toBe(firstOutput);

    target.calls.length = 0;
    target.renderer.screen.width = 800;
    renderer.draw(0.03);
    expect(renderer.stats.bloomPasses).toBeGreaterThan(2);
    expect(target.calls).toHaveLength(6);
    expect(target.calls[0]?.target).not.toBe(firstSource);
    expect(target.calls[1]?.target).not.toBe(firstPyramidLevel);
    expect(target.calls[target.calls.length - 1]?.target).not.toBe(firstOutput);

    renderer.destroy();
  });

  it("aligns full-screen bloom output when the renderer root is nested", () => {
    const target = createFakeRenderTargetRenderer(640, 360);
    const parent = new Container();
    parent.position.set(120, 80);
    const renderer = new PixiVfxRenderer({
      parent,
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      pixiRenderer: target.renderer,
      bloom: { enabled: true, quality: "low" },
    });

    renderer.createEffect(emissiveBloomEffect({ intensity: 16 }), {
      seed: 1,
      timeSeconds: 0,
    });
    renderer.update(0.01, 0.01);

    expect(renderer.stats.bloomActive).toBe(true);
    expect(renderer.bloomSourceRoot.x).toBeCloseTo(120, 5);
    expect(renderer.bloomSourceRoot.y).toBeCloseTo(80, 5);
    const bloomOverlay = renderer.root.children[0] as Container;
    expect(bloomOverlay.x).toBeCloseTo(-120, 5);
    expect(bloomOverlay.y).toBeCloseTo(-80, 5);

    renderer.destroy();
  });

  it("keeps the existing additive LDR fallback when bloom is disabled", () => {
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      bloom: { enabled: false, quality: "off" },
    });

    const low = renderer.createEffect(
      emissiveBloomEffect({ intensity: 1, blend: "additive", alpha: 0.25 }),
      { seed: 1, timeSeconds: 0 },
    );
    renderer.update(0.01, 0.01);
    const lowAlpha = firstParticle(low).alpha;
    renderer.removeEffect(low);

    const high = renderer.createEffect(
      emissiveBloomEffect({ intensity: 4, blend: "additive", alpha: 0.25 }),
      { seed: 1, timeSeconds: 0 },
    );
    renderer.update(0.01, 0.01);
    const highAlpha = firstParticle(high).alpha;
    renderer.removeEffect(high);

    const higher = renderer.createEffect(
      emissiveBloomEffect({ intensity: 16, blend: "additive", alpha: 0.25 }),
      { seed: 1, timeSeconds: 0 },
    );
    renderer.update(0.01, 0.01);

    expect(highAlpha).toBeGreaterThan(lowAlpha);
    expect(firstParticle(higher).alpha).toBeGreaterThan(highAlpha);
    expect(firstParticle(higher).alpha).toBeLessThan(1);
    expect(renderer.stats.bloomSourceParticles).toBe(0);
    expect(renderer.stats.bloomActive).toBe(false);

    renderer.destroy();
  });

  it("composes initialize size with the size-over-life multiplier", () => {
    const makeSizeInstance = (
      initSize: number,
      overLife: number,
      sizeModule = true,
    ) =>
      new PixiVfxEffectInstance({
        effect: {
          id: `init-size-${initSize}-${overLife}`,
          emitters: [
            {
              id: "init-size-emitter",
              maxParticles: 1,
              duration: 1,
              loop: false,
              modules: {
                color: false,
                rotation: false,
                size: sizeModule,
                velocity: false,
              },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
                shape: "point",
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                size: { mode: "constant", value: initSize },
              },
              billboard: { sizeValue: { mode: "constant", value: overLife } },
            },
          ],
        },
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

    // Base case: init size 1 * over-life 0.5.
    const base = makeSizeInstance(1, 0.5);
    base.update(0.01, 0.01);
    const baseScale = firstParticle(base).scaleX;

    // Doubling the INITIAL size doubles the rendered size (multiplicative).
    const doubled = makeSizeInstance(2, 0.5);
    doubled.update(0.01, 0.01);
    expect(firstParticle(doubled).scaleX).toBeCloseTo(baseScale * 2, 5);

    // Doubling the over-life multiplier also doubles the rendered size.
    const doubledOverLife = makeSizeInstance(1, 1);
    doubledOverLife.update(0.01, 0.01);
    expect(firstParticle(doubledOverLife).scaleX).toBeCloseTo(baseScale * 2, 5);

    const sizeOffSmall = makeSizeInstance(2, 0.25, false);
    sizeOffSmall.update(0.01, 0.01);
    const sizeOffLarge = makeSizeInstance(2, 2, false);
    sizeOffLarge.update(0.01, 0.01);
    expect(firstParticle(sizeOffLarge).scaleX).toBeCloseTo(
      firstParticle(sizeOffSmall).scaleX,
      5,
    );

    base.destroy();
    doubled.destroy();
    doubledOverLife.destroy();
    sizeOffSmall.destroy();
    sizeOffLarge.destroy();
  });

  it("applies separate billboard X/Y size over lifetime", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "separate-billboard-size",
        emitters: [
          {
            id: "separate-billboard-size-emitter",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: {
              color: false,
              rotation: false,
              size: true,
              velocity: false,
            },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              size: { mode: "constant", value: 1 },
            },
            billboard: {
              separateAxes: true,
              sizeValue: { mode: "constant", value: 0.5 },
              sizeValueY: { mode: "constant", value: 1.25 },
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);
    const particle = firstParticle(instance);

    expect(
      (particle.scaleY * particle.texture.height) /
        (particle.scaleX * particle.texture.width),
    ).toBeCloseTo(2.5, 4);

    instance.destroy();
  });

  it("applies separate billboard X/Y INITIAL Start Size (V4)", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "separate-billboard-start-size",
        emitters: [
          {
            id: "separate-billboard-start-size-emitter",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: {
              color: false,
              rotation: false,
              // Size-over-lifetime off so only the INITIAL Start Size drives
              // the rendered aspect.
              size: false,
              velocity: false,
            },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              startSizeSeparateAxes: true,
              size3D: {
                x: { mode: "constant", value: 2 },
                y: { mode: "constant", value: 5 },
                z: { mode: "constant", value: 1 },
              },
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);
    const particle = firstParticle(instance);

    // Slot 11 (X=2) -> scaleX, slot 12 (Y=5) -> scaleY; aspect = Y / X = 2.5.
    expect(
      (particle.scaleY * particle.texture.height) /
        (particle.scaleX * particle.texture.width),
    ).toBeCloseTo(2.5, 4);

    instance.destroy();
  });

  it("maps mesh vec3 start scale, Z rotation, and XY pivot to flat particles", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "mesh-3d-preview-map",
        emitters: [
          {
            id: "mesh-3d-preview-map-emitter",
            mode: "mesh",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: {
              color: false,
              rotation: false,
              size: false,
              velocity: false,
            },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              size3D: {
                x: { mode: "constant", value: 2 },
                y: { mode: "constant", value: 4 },
                z: { mode: "constant", value: 8 },
              },
              rotation3D: {
                x: { mode: "constant", value: 0.2 },
                y: { mode: "constant", value: 0.4 },
                z: { mode: "constant", value: 0.7 },
              },
            },
            mesh: {
              thickness: 1,
              pivot: [0.25, -0.25, 0.75],
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);
    const particle = firstParticle(instance);

    expect(particle.rotation).toBeCloseTo(0.7, 4);
    expect(
      (particle.scaleY * particle.texture.height) /
        (particle.scaleX * particle.texture.width),
    ).toBeCloseTo(2, 4);
    expect(particle.anchorX).toBeCloseTo(0.75, 4);
    expect(particle.anchorY).toBeCloseTo(0.25, 4);

    instance.destroy();
  });

  const billboardPivotEffect = (pivot: [number, number] | undefined) => ({
    id: "billboard-pivot-map",
    emitters: [
      {
        id: "billboard-pivot-map-emitter",
        mode: "billboard",
        maxParticles: 1,
        duration: 1,
        loop: false,
        modules: {
          color: false,
          rotation: false,
          size: false,
          velocity: false,
        },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          rotation: { mode: "constant", value: 0 },
          angularVelocity: { mode: "constant", value: 0 },
        },
        billboard: {
          sizeValue: { mode: "constant", value: 0.5 },
          ...(pivot ? { pivot } : {}),
        },
      },
    ],
  });

  it("maps billboard pivot to the sprite anchor and negates Y (I13-B T4)", () => {
    const instance = new PixiVfxEffectInstance({
      effect: billboardPivotEffect([0.3, 0.4]),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);
    const particle = firstParticle(instance);

    expect(particle.anchorX).toBeCloseTo(0.8, 4);
    // Y is negated for billboards (D4): 0.5 - 0.4 = 0.1 (NOT 0.9).
    expect(particle.anchorY).toBeCloseTo(0.1, 4);

    instance.destroy();
  });

  it("keeps billboard pivot=0 byte-identical to a no-pivot billboard (I13-B T5)", () => {
    const withZero = new PixiVfxEffectInstance({
      effect: billboardPivotEffect([0, 0]),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });
    const noPivot = new PixiVfxEffectInstance({
      effect: billboardPivotEffect(undefined),
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    withZero.update(0.01, 0.01);
    noPivot.update(0.01, 0.01);
    const a = firstParticle(withZero);
    const b = firstParticle(noPivot);

    expect(a.anchorX).toBe(0.5);
    expect(a.anchorY).toBe(0.5);
    expect(a.anchorX).toBe(b.anchorX);
    expect(a.anchorY).toBe(b.anchorY);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);

    withZero.destroy();
    noPivot.destroy();
  });

  it("pushes clamped billboard pivot overflow into the rotated position (I13-B T6)", () => {
    // pivot X beyond the quad edge clamps the anchor to 1 and re-expresses the
    // remainder as a rotated position offset. Start rotation π/2 rotates the
    // X-overflow into the Y axis, proving pivot composes through rotation (F).
    const makeInstance = (pivot: [number, number]) =>
      new PixiVfxEffectInstance({
        effect: {
          id: "billboard-pivot-overflow",
          emitters: [
            {
              id: "billboard-pivot-overflow-emitter",
              mode: "billboard",
              maxParticles: 1,
              duration: 1,
              loop: false,
              modules: {
                color: false,
                rotation: false,
                size: false,
                velocity: false,
              },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
                shape: "point",
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                rotation: { mode: "constant", value: Math.PI / 2 },
                angularVelocity: { mode: "constant", value: 0 },
              },
              billboard: { sizeValue: { mode: "constant", value: 0.5 }, pivot },
            },
          ],
        },
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

    const overflow = makeInstance([1, 0]);
    const centered = makeInstance([0, 0]);
    overflow.update(0.01, 0.01);
    centered.update(0.01, 0.01);
    const a = firstParticle(overflow);
    const ref = firstParticle(centered);

    // desiredAnchorX = 0.5 + 1 = 1.5 → clamps to 1.
    expect(a.anchorX).toBeCloseTo(1, 4);
    expect(a.anchorY).toBeCloseTo(0.5, 4);
    expect(a.rotation).toBeCloseTo(Math.PI / 2, 4);
    // pivotOverflowX = (1 - 1.5) * pixelSizeX * renderScaleX = -0.5 * scaleX(px).
    const scaleXPixels = a.scaleX * Math.max(1, a.texture.width);
    // rotation π/2: overflow X rotates fully into +y (cos≈0, sin≈1).
    expect(a.x).toBeCloseTo(ref.x, 3);
    expect(a.y).toBeCloseTo(ref.y - 0.5 * scaleXPixels, 3);

    overflow.destroy();
    centered.destroy();
  });

  it("pushes clamped billboard pivot Y-overflow (flipped sign) into the rotated position (I13-B T6b)", () => {
    // Y twin of T6, pinning the D4-flipped-Y overflow branch: pivot Y beyond the
    // quad edge drives desiredAnchorY = 0.5 - pivotY BELOW 0, so anchorY clamps to
    // 0 and the remainder (anchorY - desiredAnchorY) is POSITIVE — the opposite
    // sign a mesh pivot of the same magnitude would produce (mesh: 1 - 1.5 = -0.5).
    // Start rotation π/2 rotates that +Y overflow fully into -X, proving the
    // flipped-sign remainder composes correctly through rotation.
    const makeInstance = (pivot: [number, number]) =>
      new PixiVfxEffectInstance({
        effect: {
          id: "billboard-pivot-y-overflow",
          emitters: [
            {
              id: "billboard-pivot-y-overflow-emitter",
              mode: "billboard",
              maxParticles: 1,
              duration: 1,
              loop: false,
              modules: {
                color: false,
                rotation: false,
                size: false,
                velocity: false,
              },
              spawn: {
                rate: 0,
                rateValue: { mode: "constant", value: 0 },
                bursts: [
                  { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
                ],
                shape: "point",
              },
              initializeParticle: {
                lifetime: { mode: "constant", value: 1 },
                rotation: { mode: "constant", value: Math.PI / 2 },
                angularVelocity: { mode: "constant", value: 0 },
              },
              billboard: { sizeValue: { mode: "constant", value: 0.5 }, pivot },
            },
          ],
        },
        fallbackTextures: testFallbackTextures(),
        projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
        seed: 1,
        timeSeconds: 0,
      });

    const overflow = makeInstance([0, 1]);
    const centered = makeInstance([0, 0]);
    overflow.update(0.01, 0.01);
    centered.update(0.01, 0.01);
    const a = firstParticle(overflow);
    const ref = firstParticle(centered);

    // desiredAnchorY = 0.5 - 1 = -0.5 → clamps to 0 (X untouched).
    expect(a.anchorX).toBeCloseTo(0.5, 4);
    expect(a.anchorY).toBeCloseTo(0, 4);
    expect(a.rotation).toBeCloseTo(Math.PI / 2, 4);
    // pivotOverflowY = (0 - (-0.5)) * pixelSizeY * renderScaleY = +0.5 * scaleY(px).
    const scaleYPixels = a.scaleY * Math.max(1, a.texture.height);
    // rotation π/2: overflow Y rotates into -x (particle.x -= pivotOverflowY * sin);
    // y is unchanged (cos ≈ 0). The +0.5 sign (not -0.5) is the flipped-Y pin.
    expect(a.x).toBeCloseTo(ref.x - 0.5 * scaleYPixels, 3);
    expect(a.y).toBeCloseTo(ref.y, 3);

    overflow.destroy();
    centered.destroy();
  });

  it("propagates billboard pivot to the bloom copy (I13-B T7)", () => {
    const renderer = new PixiVfxRenderer({
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      bloom: { enabled: true, quality: "low", threshold: 0.2 },
    });

    const instance = renderer.createEffect(
      {
        id: "billboard-pivot-bloom",
        emitters: [
          {
            id: "billboard-pivot-bloom-emitter",
            mode: "billboard",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: { color: true, rotation: false, velocity: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              color: {
                mode: "constant",
                color: [1, 1, 1, 1],
                intensity: { mode: "constant", value: 4 },
              },
            },
            billboard: {
              sizeValue: { mode: "constant", value: 0.5 },
              pivot: [0.3, 0.4],
            },
            color: {
              gradient: {
                mode: "blend",
                colorStops: [
                  { position: 0, color: [1, 1, 1] },
                  { position: 1, color: [1, 1, 1] },
                ],
                alphaStops: [
                  { position: 0, alpha: 1 },
                  { position: 1, alpha: 1 },
                ],
              },
            },
          },
        ],
      },
      { seed: 1, timeSeconds: 0 },
    );
    renderer.update(0.01, 0.01);

    expect(instance.stats.bloomSourceParticles).toBe(1);
    const main = firstParticle(instance);
    const bloom = firstBloomParticle(instance);
    expect(main.anchorX).toBeCloseTo(0.8, 4);
    expect(main.anchorY).toBeCloseTo(0.1, 4);
    expect(bloom.anchorX).toBe(main.anchorX);
    expect(bloom.anchorY).toBe(main.anchorY);

    renderer.destroy();
  });

  it("exposes live particle debug quads for the wireframe overlay", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "debug-wireframe",
        emitters: [
          {
            id: "debug-wireframe-emitter",
            mode: "mesh",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: {
              color: false,
              rotation: false,
              size: false,
              velocity: false,
            },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              size3D: {
                x: { mode: "constant", value: 1.5 },
                y: { mode: "constant", value: 0.75 },
                z: { mode: "constant", value: 1 },
              },
              rotation3D: {
                x: { mode: "constant", value: 0 },
                y: { mode: "constant", value: 0 },
                z: { mode: "constant", value: 0.35 },
              },
            },
            mesh: {
              thickness: 1,
              pivot: [0.2, -0.1, 0],
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);
    const particle = firstParticle(instance);
    const quad = instance.getParticleDebugQuads()[0];

    expect(quad).toMatchObject({
      emitterId: "debug-wireframe-emitter",
      emitterIndex: 0,
      mode: "mesh",
      anchorX: particle.anchorX,
      anchorY: particle.anchorY,
    });
    expect(quad?.width).toBeCloseTo(particle.scaleX * particle.texture.width);
    expect(quad?.height).toBeCloseTo(particle.scaleY * particle.texture.height);
    expect(quad?.rotation).toBeCloseTo(particle.rotation);

    instance.destroy();
  });

  it("keeps alpha-zero particles in debug quads without rendering them", () => {
    const instance = new PixiVfxEffectInstance({
      effect: {
        id: "debug-alpha-zero",
        emitters: [
          {
            id: "debug-alpha-zero-emitter",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: {
              color: false,
              rotation: false,
              size: false,
              velocity: false,
            },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              color: {
                color: [1, 1, 1, 0],
                intensity: { mode: "constant", value: 1 },
              },
              size: { mode: "constant", value: 1 },
              rotation: { mode: "constant", value: 0 },
            },
          },
        ],
      },
      fallbackTextures: testFallbackTextures(),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);
    const [quad] = instance.getParticleDebugQuads();

    expect(instance.stats.activeParticles).toBe(1);
    expect(instance.stats.visibleParticles).toBe(0);
    expect(quad?.emitterId).toBe("debug-alpha-zero-emitter");
    expect(quad?.alpha).toBe(0);
    expect(quad?.width).toBeGreaterThanOrEqual(2);
    expect(quad?.height).toBeGreaterThanOrEqual(2);

    instance.destroy();
  });
});

function testEffect(): unknown {
  return {
    id: "provider-effect",
    name: "Provider Effect",
    emitters: [
      {
        id: "provider-emitter",
        maxParticles: 8,
        duration: 1,
        loop: false,
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 2, cycles: 1, interval: 0, probability: 1 },
          ],
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
        },
        billboard: {
          sizeValue: { mode: "constant", value: 0.5 },
        },
        render: {
          texture: "fx/spark.png",
        },
      },
    ],
  };
}

/**
 * A FAITHFUL Tier-1 graph: baseColor ← a bare textureSample (the texture-only
 * path resolveFixed reproduces) whose UV is animated by a vertex-stage panner
 * (so it is NOT preempted by the static Tier-0 bake), PLUS a non-white "Tint"
 * color param that resolveFixed folds into the per-particle tint. This exercises
 * M6-A's faithful Tier-1 fallback through the renderer's per-particle fold
 * (resolveEmitterMaterialFixed → updateParticle), NOT evaluatePreviewOutputs.
 */
function tintParamGraph(tint: [number, number, number, number]): ShaderGraph {
  return normalizeShaderGraph({
    id: "tint-param",
    name: "Tint Param",
    blend: "normal",
    params: [
      {
        name: "Tint",
        type: "color",
        group: "Color",
        default: tint,
        scope: "per-material",
      },
    ],
    nodes: [
      matNode("uv", "uv"),
      matNode("time", "time"),
      matNode(
        "pan",
        "panner",
        { uv: "e-uv", time: "e-time" },
        { speed: [0.1, 0] },
      ),
      matNode("tex", "textureSample", { uv: "e-pan" }),
    ],
    edges: [
      matEdge("e-uv", "uv", "pan", "uv"),
      matEdge("e-time", "time", "pan", "time"),
      matEdge("e-pan", "pan", "tex", "uv"),
      matEdge("e-base", "tex", "out", "baseColor", "RGB"),
    ],
    outputs: { baseColor: "e-base" },
  });
}

/**
 * A NON-faithful per-particle graph: particleColor drives baseColor through no
 * magic param. Pre-M6-A this collapsed to a no-op tier1-fixed{tint:[1,1,1,1]};
 * now it must escalate to a real Tier-2 shader.
 */
function particleColorBaseColorGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "particle-color-base",
    name: "Particle Color BaseColor",
    blend: "normal",
    nodes: [matNode("pc", "particleColor")],
    edges: [matEdge("e-base", "pc", "out", "baseColor", "RGB")],
    outputs: { baseColor: "e-base" },
  });
}

function textureDynamicParameterGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "texture-dynamic-parameter",
    name: "Texture Dynamic Parameter",
    blend: "normal",
    nodes: [
      matNode("tex", "textureSample"),
      matNode("dyn", "dynamicParameter"),
      matNode("mul", "multiply", { a: "e-tex", b: "e-dyn" }),
    ],
    edges: [
      matEdge("e-tex", "tex", "mul", "a", "RGB"),
      matEdge("e-dyn", "dyn", "mul", "b", "Param1"),
      matEdge("e-base", "mul", "out", "baseColor", "RGB"),
    ],
    outputs: { baseColor: "e-base" },
  });
}

function scrollingTextureGraph(
  speed: [number, number],
  id = "scrolling-texture",
): ShaderGraph {
  return normalizeShaderGraph({
    id,
    name: "Scrolling Texture",
    blend: "normal",
    nodes: [
      matNode("uv", "uv"),
      matNode("time", "time"),
      matNode("pan", "panner", { uv: "e-uv", time: "e-time" }, { speed }),
      matNode("tex", "textureSample", { uv: "e-pan" }),
    ],
    edges: [
      matEdge("e-uv", "uv", "pan", "uv"),
      matEdge("e-time", "time", "pan", "time"),
      matEdge("e-pan", "pan", "tex", "uv"),
      matEdge("e-base", "tex", "out", "baseColor", "RGB"),
    ],
    outputs: { baseColor: "e-base" },
  });
}

function rotatingTextureGraph(speed: number): ShaderGraph {
  return normalizeShaderGraph({
    id: "rotating-texture",
    name: "Rotating Texture",
    blend: "normal",
    nodes: [
      matNode("uv", "uv"),
      matNode("time", "time"),
      matNode(
        "rot",
        "rotateUV",
        { uv: "e-uv", angle: "e-time" },
        { speed, center: [0.5, 0.5] },
      ),
      matNode("tex", "textureSample", { uv: "e-rot" }),
    ],
    edges: [
      matEdge("e-uv", "uv", "rot", "uv"),
      matEdge("e-time", "time", "rot", "angle"),
      matEdge("e-rot", "rot", "tex", "uv"),
      matEdge("e-base", "tex", "out", "baseColor", "RGB"),
    ],
    outputs: { baseColor: "e-base" },
  });
}

function tier2DissolveGraph(edgeValue: number, sliderMax = 1): ShaderGraph {
  return normalizeShaderGraph({
    id: "tier2-dissolve",
    name: "Tier 2 Dissolve",
    blend: "normal",
    params: [
      {
        name: "Dissolve",
        type: "float",
        group: "FX",
        default: 0.5,
        sliderMin: 0,
        sliderMax,
        scope: "per-material",
        perParticle: true,
      },
    ],
    nodes: [
      matNode("tex", "textureSample"),
      matNode("dyn", "dynamicParameter"),
      matNode("mask", "step", { in: "e-dyn" }, { edge: edgeValue }),
    ],
    edges: [
      matEdge("e-dyn", "dyn", "mask", "in", "Param1"),
      matEdge("e-mask", "mask", "out", "opacityMask", "R"),
      matEdge("e-base", "tex", "out", "baseColor", "RGB"),
    ],
    outputs: { baseColor: "e-base", opacityMask: "e-mask" },
  });
}

function animatedOpacityGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "animated-opacity",
    name: "Animated Opacity",
    blend: "normal",
    nodes: [
      matNode("uv", "uv"),
      matNode("time", "time"),
      matNode(
        "pan",
        "panner",
        { uv: "e-uv", time: "e-time" },
        { speed: [0, 0.2, 0, 0] },
      ),
      matNode(
        "noise",
        "noise",
        { Position: "e-pan" },
        { function: "voronoi", scale: 4.2 },
      ),
      matNode(
        "spherical",
        "sphericalParticleOpacity",
        {},
        { radius: 0.4, density: 0.32 },
      ),
      matNode("opacity", "multiply", { a: "e-noise", b: "e-spherical" }),
    ],
    edges: [
      matEdge("e-uv", "uv", "pan", "uv"),
      matEdge("e-time", "time", "pan", "time"),
      matEdge("e-pan", "pan", "noise", "Position"),
      matEdge("e-noise", "noise", "opacity", "a", "R"),
      matEdge("e-spherical", "spherical", "opacity", "b", "R"),
      matEdge("e-base", "spherical", "out", "baseColor", "RGB"),
      matEdge("e-opacity", "opacity", "out", "opacity", "R"),
    ],
    outputs: { baseColor: "e-base", opacity: "e-opacity" },
  });
}

function matNode(
  id: string,
  type: ShaderGraph["nodes"][number]["type"],
  inputs: Record<string, string | null> = {},
  params: Record<string, unknown> = {},
): ShaderGraph["nodes"][number] {
  return { id, type, inputs, params, position: { x: 0, y: 0 } };
}

function matEdge(
  id: string,
  source: string,
  target: string,
  targetHandle: string,
  sourceHandle = "out",
): ShaderGraph["edges"][number] {
  return { id, source, target, targetHandle, sourceHandle };
}

function unitTexture(): Texture {
  return new Texture({
    source: Texture.WHITE.source,
    frame: new Rectangle(0, 0, 1, 1),
    orig: new Rectangle(0, 0, 1, 1),
  });
}

function orderInLayerEffect(lowOrder = 5, highOrder = 9): unknown {
  const makeEmitter = (
    id: string,
    texture: string,
    orderInLayer: number,
  ): unknown => ({
    id,
    maxParticles: 4,
    duration: 1,
    loop: false,
    modules: { color: false, rotation: false },
    spawn: {
      rate: 0,
      rateValue: { mode: "constant", value: 0 },
      bursts: [{ time: 0, count: 1, cycles: 1, interval: 0, probability: 1 }],
      shape: "point",
    },
    initializeParticle: {
      lifetime: { mode: "constant", value: 1 },
      velocity: {
        mode: "shapeDirection",
        speed: { mode: "constant", value: 0 },
      },
    },
    billboard: { sizeValue: { mode: "constant", value: 0.4 } },
    render: { texture, orderInLayer },
  });
  return {
    id: "order-in-layer-effect",
    emitters: [
      makeEmitter("low", "fx/low.png", lowOrder),
      makeEmitter("high", "fx/high.png", highOrder),
    ],
  };
}

function parentSubEffect(effectFile = "child.json"): unknown {
  return {
    id: "parent-sub-emitter",
    emitters: [
      {
        id: "parent",
        maxParticles: 4,
        duration: 1,
        loop: false,
        modules: {
          color: false,
          rotation: false,
          subEmitters: true,
        },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
        },
        billboard: { sizeValue: { mode: "constant", value: 0.5 } },
        advanced: {
          subEmitters: {
            birth: {
              effectFile,
              probability: 1,
              inheritColor: true,
              inheritSize: true,
            },
          },
        },
      },
    ],
  };
}

function childSubEffect(): unknown {
  return {
    id: "child-sub-emitter",
    emitters: [
      {
        id: "child",
        maxParticles: 4,
        duration: 1,
        loop: false,
        modules: {
          color: false,
          rotation: false,
        },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          velocity: {
            mode: "shapeDirection",
            speed: { mode: "constant", value: 0 },
          },
        },
        billboard: { sizeValue: { mode: "constant", value: 0.35 } },
      },
    ],
  };
}

function trailEffect(trailOverrides: Record<string, unknown> = {}): unknown {
  return {
    id: "trail-effect",
    emitters: [
      {
        id: "trail-emitter",
        maxParticles: 1,
        duration: 1,
        loop: false,
        modules: {
          color: false,
          rotation: false,
          velocity: true,
          trails: true,
        },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          velocity: {
            mode: "vector",
            min: [2, 0, 0],
            max: [2, 0, 0],
            speed: { mode: "constant", value: 0 },
          },
        },
        billboard: { sizeValue: { mode: "constant", value: 0.4 } },
        advanced: {
          trails: {
            length: { mode: "constant", value: 2 },
            width: { mode: "constant", value: 0.15 },
            lifetime: { mode: "constant", value: 0.5 },
            ratio: 1,
            inheritColor: true,
            textureMode: "stretch",
            minVertexDistance: 0.001,
            worldSpace: true,
            ...trailOverrides,
          },
        },
      },
    ],
  };
}

function trailMotionEffect(trailLifetime: number): unknown {
  return {
    id: "trail-motion-effect",
    emitters: [
      {
        id: "trail-motion-emitter",
        maxParticles: 1,
        duration: 100,
        loop: false,
        modules: {
          color: false,
          rotation: false,
          velocity: true,
          trails: true,
        },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
        },
        initializeParticle: {
          // Long particle lifetime so the head keeps moving and adding points.
          lifetime: { mode: "constant", value: 100 },
          velocity: {
            mode: "vector",
            min: [2, 0, 0],
            max: [2, 0, 0],
            speed: { mode: "constant", value: 0 },
          },
        },
        billboard: { sizeValue: { mode: "constant", value: 0.4 } },
        advanced: {
          trails: {
            // Long length so points are pruned by lifetime, not by length.
            length: { mode: "constant", value: 12 },
            width: { mode: "constant", value: 0.15 },
            lifetime: { mode: "constant", value: trailLifetime },
            ratio: 1,
            inheritColor: true,
            textureMode: "stretch",
            minVertexDistance: 0.001,
            worldSpace: true,
          },
        },
      },
    ],
  };
}

function emissiveBloomEffect({
  intensity,
  color = [1, 0.5, 0, 1],
  blend = "normal",
  alpha = 0.25,
  emitterEnabled = true,
}: {
  intensity: number;
  color?: [number, number, number, number];
  blend?: "normal" | "additive";
  alpha?: number;
  emitterEnabled?: boolean;
}): unknown {
  return {
    id: `emissive-bloom-${blend}-${intensity}`,
    emitters: [
      {
        id: "emissive-bloom-emitter",
        enabled: emitterEnabled,
        maxParticles: 1,
        duration: 1,
        loop: false,
        modules: { color: true, rotation: false, velocity: false },
        render: { blend },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          color: {
            mode: "constant",
            color,
            intensity: { mode: "constant", value: intensity },
          },
        },
        billboard: { sizeValue: { mode: "constant", value: 0.5 } },
        color: {
          gradient: {
            mode: "blend",
            colorStops: [
              { position: 0, color: [1, 1, 1] },
              { position: 1, color: [1, 1, 1] },
            ],
            alphaStops: [
              { position: 0, alpha },
              { position: 1, alpha },
            ],
          },
        },
      },
    ],
  };
}

function createFakeRenderTargetRenderer(
  width = 640,
  height = 360,
): {
  renderer: PixiVfxRenderTargetRenderer;
  calls: Array<{
    container: Container;
    target?: Texture;
    clear?: boolean;
  }>;
} {
  const calls: Array<{
    container: Container;
    target?: Texture;
    clear?: boolean;
  }> = [];
  const renderer: PixiVfxRenderTargetRenderer = {
    screen: { width, height },
    render(options) {
      if (options instanceof Container) {
        calls.push({ container: options });
        return;
      }
      calls.push({
        container: options.container,
        target: options.target,
        clear: options.clear,
      });
    },
  };
  return { renderer, calls };
}

function testFallbackTextures(): PixiVfxFallbackTextures {
  return {
    circle: Texture.EMPTY,
    square: Texture.EMPTY,
    triangleShard: Texture.EMPTY,
    quadShard: Texture.EMPTY,
    grassShard: Texture.EMPTY,
  };
}

function firstParticle(instance: PixiVfxEffectInstance) {
  const container =
    particleContainers(instance)[1] ?? particleContainers(instance)[0];
  const particle = container.particleChildren[0] as Particle | undefined;
  if (!particle) throw new Error("Expected one rendered particle");
  return particle;
}

function firstEmitterView(instance: PixiVfxEffectInstance): {
  key: string;
  effectiveBlend: string;
  container: { blendMode: string };
  texture: Texture;
} {
  const views = (
    instance as unknown as {
      emitterViews: Array<{
        key: string;
        effectiveBlend: string;
        container: { blendMode: string };
        texture: Texture;
      }>;
    }
  ).emitterViews;
  const view = views[0];
  if (!view) throw new Error("Expected one emitter view");
  return view;
}

function firstBloomParticle(instance: PixiVfxEffectInstance) {
  const container = instance.bloomRoot.children.find(
    (child): child is ParticleContainer => child instanceof ParticleContainer,
  );
  const particle = container?.particleChildren[0] as Particle | undefined;
  if (!particle) throw new Error("Expected one bloom particle");
  return particle;
}

function firstTrailParticle(instance: PixiVfxEffectInstance) {
  const container = particleContainers(instance)[0];
  const particle = container.particleChildren[0] as Particle | undefined;
  if (!particle) throw new Error("Expected one rendered trail particle");
  return particle;
}

function lastTrailParticle(instance: PixiVfxEffectInstance) {
  const container = particleContainers(instance)[0];
  const particle = container.particleChildren[
    container.particleChildren.length - 1
  ] as Particle | undefined;
  if (!particle) throw new Error("Expected one rendered trail particle");
  return particle;
}

function trailParticleCount(instance: PixiVfxEffectInstance): number {
  const container = particleContainers(instance)[0];
  return container ? container.particleChildren.length : 0;
}

function particleContainers(
  instance: PixiVfxEffectInstance,
): ParticleContainer[] {
  return instance.root.children.filter(
    (child): child is ParticleContainer => child instanceof ParticleContainer,
  );
}

function particleShaderFragment(container: ParticleContainer): string {
  const shader = (
    container as unknown as {
      shader?: { glProgram?: { fragment?: string } };
    }
  ).shader;
  const fragment = shader?.glProgram?.fragment;
  if (!fragment) throw new Error("Expected ParticleContainer material shader");
  return fragment;
}

function particleContainerDynamicUvs(container: ParticleContainer): boolean {
  const props = (
    container as unknown as {
      _properties?: Record<string, { dynamic?: boolean }>;
    }
  )._properties;
  return props?.uvs?.dynamic === true;
}

function withFakePixiDomAdapter<T>(run: () => T): T {
  const previous = DOMAdapter.get();
  DOMAdapter.set({
    ...previous,
    createCanvas(width?: number, height?: number) {
      return {
        width: width ?? 1,
        height: height ?? 1,
        getContext() {
          return {
            HIGH_FLOAT: 0x8df2,
            MEDIUM_FLOAT: 0x8df1,
            getShaderPrecisionFormat() {
              return { precision: 23 };
            },
          };
        },
      } as unknown as HTMLCanvasElement;
    },
  });
  try {
    return run();
  } finally {
    DOMAdapter.set(previous);
  }
}
