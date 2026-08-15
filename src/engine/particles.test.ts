import { describe, expect, it } from "vitest";
import { sampleTextureSheetAnimationFrame } from "@/runtime/modules/advancedEvaluators";
import {
  compileParticleGradient,
  compileParticleScalarValue,
  createDefaultParticleEffect,
  createDefaultParticleEmitter,
  makeParticleEffectFileName,
  normalizeParticleEffect,
  PARTICLE_INSTANCE_STRIDE,
  PARTICLE_RUNTIME_FLAG_ALIGN_TO_DIRECTION,
  PARTICLE_RUNTIME_FLAG_LOCAL_SPACE,
  PARTICLE_RUNTIME_VECTOR_STRIDE,
  ParticleEffectRunner,
  linearToSrgb,
  sampleCompiledParticleGradient,
  sampleCompiledParticleScalar,
  sampleInitialParticleColor,
  sampleParticleGradientAlpha,
  sampleParticleGradientColor,
  sampleParticleCurve,
  sampleParticleMotion,
  sampleParticleScalarValue,
  normalizeParticleScalarValue,
  resolveParticleDepthWrite,
  srgbToLinear,
  type ParticleEffectDefinition,
} from "./particles";

describe("particle effect normalization", () => {
  it("accepts legacy pocket-grass JSON and rewrites app identity", () => {
    const effect = normalizeParticleEffect({
      app: "pocket-grass",
      kind: "particle-effect",
      version: 1,
      id: "legacy-effect",
      name: "Legacy Effect",
      emitters: [],
    });

    expect(effect.app).toBe("vfx-editor");
    expect(effect.id).toBe("legacy-effect");
    expect(effect.name).toBe("Legacy Effect");
  });

  it("creates new effects with vfx-editor identity", () => {
    const effect = createDefaultParticleEffect("new-effect", "New Effect");

    expect(effect.app).toBe("vfx-editor");
    expect(makeParticleEffectFileName(effect)).toBe("new-effect.json");
    expect(effect.timeline.frameRate).toBe(30);
    expect(effect.timeline.duration).toBeGreaterThanOrEqual(2);
  });

  it("seeds at least one emitter so the editor renders module panels (B1)", () => {
    const effect = createDefaultParticleEffect();

    expect(effect.emitters.length).toBeGreaterThanOrEqual(1);
    const [first] = effect.emitters;
    expect(first).toBeDefined();
    expect(first!.id).toBeTruthy();
  });

  it("normalizes renderer shading with an unlit default and authored lit opt-in", () => {
    const defaultEffect = normalizeParticleEffect({
      id: "default-shading",
      emitters: [{ id: "plain" }],
    });
    const litEffect = normalizeParticleEffect({
      id: "lit-shading",
      emitters: [{ id: "lit", render: { shading: "lit" } }],
    });

    expect(defaultEffect.emitters[0]?.render.shading).toBe("unlit");
    expect(litEffect.emitters[0]?.render.shading).toBe("lit");
  });

  it("normalizes particle sort mode with an alpha-correct far-first default", () => {
    const defaultEffect = normalizeParticleEffect({
      id: "default-sort",
      emitters: [{ id: "plain" }],
    });
    const nearFirst = normalizeParticleEffect({
      id: "near-sort",
      emitters: [{ id: "near", render: { sortMode: "distanceNearFirst" } }],
    });
    const unknown = normalizeParticleEffect({
      id: "unknown-sort",
      emitters: [{ id: "bad", render: { sortMode: "bad" } }],
    });

    expect(defaultEffect.emitters[0]?.render.sortMode).toBe("distanceFarFirst");
    expect(nearFirst.emitters[0]?.render.sortMode).toBe("distanceNearFirst");
    expect(unknown.emitters[0]?.render.sortMode).toBe("distanceFarFirst");
  });

  it("no longer clamps initial velocity vectors to the old +/-80 range (B2)", () => {
    const effect = normalizeParticleEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "free-velocity",
      emitters: [
        {
          id: "free-velocity-emitter",
          initializeParticle: {
            velocity: {
              mode: "vector",
              min: [-500, -120, 0],
              max: [500, 250, 0],
            },
          },
        },
      ],
    });
    const velocity = effect.emitters[0]!.initializeParticle.velocity;
    expect(velocity.min[0]).toBe(-500);
    expect(velocity.min[1]).toBe(-120);
    expect(velocity.max[0]).toBe(500);
    expect(velocity.max[1]).toBe(250);
  });

  it("migrates legacy initial alpha endpoints into a scalar value mode", () => {
    const effect = normalizeParticleEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "legacy-alpha",
      emitters: [
        {
          id: "legacy-alpha-emitter",
          initializeParticle: {
            color: {
              mode: "random",
              color: [1, 0.2, 0.1, 0.25],
              colorB: [0.2, 0.6, 1, 0.75],
            },
          },
        },
      ],
    });
    const color = effect.emitters[0]!.initializeParticle.color;

    expect(color.alpha.mode).toBe("random");
    expect(sampleInitialParticleColor(color, 0)[3]).toBeCloseTo(0.25);
    expect(sampleInitialParticleColor(color, 1)[3]).toBeCloseTo(0.75);
    expect(sampleInitialParticleColor(color, 0.5)[3]).toBeCloseTo(0.5);
  });

  it("samples initial alpha curves independently from RGB color", () => {
    const effect = normalizeParticleEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "curve-alpha",
      emitters: [
        {
          id: "curve-alpha-emitter",
          initializeParticle: {
            color: {
              mode: "constant",
              color: [1, 0.2, 0.1, 1],
              alpha: {
                mode: "curve",
                curve: [
                  { x: 0, y: 0 },
                  { x: 1, y: 0.8 },
                ],
              },
            },
          },
        },
      ],
    });
    const color = effect.emitters[0]!.initializeParticle.color;

    expect(sampleInitialParticleColor(color, 0.5, 0)[3]).toBeCloseTo(0);
    expect(sampleInitialParticleColor(color, 0.5, 1)[3]).toBeCloseTo(0.8);
  });

  it("mirrors legacy scalar angular velocity into the Z axis fallback", () => {
    const effect = normalizeParticleEffect({
      id: "legacy-angular-velocity",
      emitters: [
        {
          id: "legacy-angular-velocity-emitter",
          initializeParticle: {
            angularVelocity: { mode: "constant", value: 2.5 },
          },
        },
      ],
    });
    const init = effect.emitters[0]!.initializeParticle;

    expect(init.angularVelocitySeparateAxes).toBe(false);
    expect(init.angularVelocity3D.x.value).toBeCloseTo(0);
    expect(init.angularVelocity3D.y.value).toBeCloseTo(0);
    expect(init.angularVelocity3D.z.value).toBeCloseTo(2.5);
  });

  it("normalizes persisted effect timeline and emitter starts", () => {
    const effect = normalizeParticleEffect({
      id: "timed-effect",
      timeline: {
        frameRate: 60,
        duration: 4,
        loop: { enabled: true, start: 0.5, end: 2.5 },
        groups: [{ id: "main-group", name: "Main", collapsed: true }],
      },
      emitters: [
        {
          id: "timed-emitter",
          duration: 1,
          timeline: { start: 0.75, groupId: "main-group", locked: true },
        },
      ],
    });

    expect(effect.timeline.frameRate).toBe(60);
    expect(effect.timeline.duration).toBe(4);
    expect(effect.timeline.loop).toEqual({
      enabled: true,
      start: 0.5,
      end: 2.5,
    });
    expect(effect.timeline.groups[0]).toMatchObject({
      id: "main-group",
      name: "Main",
      collapsed: true,
    });
    expect(effect.emitters[0]?.timeline).toEqual({
      start: 0.75,
      groupId: "main-group",
      locked: true,
    });
  });

  it("preserves long emitter timing values within the wide authoring guard", () => {
    const effect = normalizeParticleEffect({
      id: "long-timing-effect",
      timeline: {
        duration: 120,
      },
      emitters: [
        {
          id: "long-delay-emitter",
          duration: 240,
          timeline: { start: 90 },
          initializeParticle: {
            lifetime: {
              mode: "constant",
              value: 75,
              min: 75,
              max: 75,
              editorMin: 0.02,
              editorMax: 30,
              curve: [
                { x: 0, y: 75 },
                { x: 1, y: 75 },
              ],
              curveB: [
                { x: 0, y: 75 },
                { x: 1, y: 75 },
              ],
            },
          },
        },
      ],
    });

    expect(effect.timeline.duration).toBe(120);
    expect(effect.emitters[0]!.timeline.start).toBe(90);
    expect(effect.emitters[0]!.duration).toBe(240);
    expect(effect.emitters[0]!.initializeParticle.lifetime.value).toBe(75);
  });

  it("migrates the visual tail group into persisted timeline metadata", () => {
    const effect = normalizeParticleEffect({
      id: "legacy-group-effect",
      emitters: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    });

    expect(effect.timeline.groups).toEqual([
      {
        id: "track-group",
        name: "Track Group",
        collapsed: false,
        hidden: false,
        locked: false,
      },
    ]);
    expect(effect.emitters[0]?.timeline.groupId).toBeNull();
    expect(effect.emitters[3]?.timeline.groupId).toBe("track-group");
  });

  it("keeps copied mesh templates normalized", () => {
    const effect = normalizeParticleEffect({
      id: "mesh-effect",
      emitters: [
        {
          id: "mesh-emitter",
          mode: "mesh",
          mesh: { template: "grassShard" },
        },
      ],
    });

    expect(effect.emitters[0]?.mesh.template).toBe("grassShard");
  });

  it("normalizes mesh asset winding repair flags as explicit artist opt-ins", () => {
    const effect = normalizeParticleEffect({
      id: "mesh-winding-effect",
      emitters: [
        {
          id: "mesh-winding-emitter",
          mode: "mesh",
          mesh: {
            renderMode: "meshAsset",
            flipWinding: true,
            recomputeNormals: true,
          },
        },
      ],
    });
    const emitter = effect.emitters[0]!;

    expect(emitter.mesh.flipWinding).toBe(true);
    expect(emitter.mesh.recomputeNormals).toBe(true);
  });

  it("normalizes mesh size-over-life separate axes with legacy scalar fan-out", () => {
    const legacy = normalizeParticleEffect({
      id: "mesh-size-legacy",
      emitters: [
        {
          id: "mesh-size",
          mode: "mesh",
          mesh: { sizeValue: { mode: "constant", value: 2 } },
        },
      ],
    }).emitters[0]!;

    expect(legacy.mesh.separateAxes).toBe(false);
    expect(legacy.mesh.sizeValue.value).toBe(2);
    expect(legacy.mesh.sizeValueY.value).toBe(2);
    expect(legacy.mesh.sizeValueZ.value).toBe(2);

    const split = normalizeParticleEffect({
      id: "mesh-size-split",
      emitters: [
        {
          id: "mesh-size",
          mode: "mesh",
          mesh: {
            separateAxes: true,
            sizeValue: { mode: "constant", value: 1 },
            sizeValueY: { mode: "constant", value: 2 },
            sizeValueZ: { mode: "constant", value: 3 },
          },
        },
      ],
    }).emitters[0]!;

    expect(split.mesh.separateAxes).toBe(true);
    expect(split.mesh.sizeValue.value).toBe(1);
    expect(split.mesh.sizeValueY.value).toBe(2);
    expect(split.mesh.sizeValueZ.value).toBe(3);
  });

  it("resolves particle depth writes from effective opacity", () => {
    expect(
      resolveParticleDepthWrite({ blend: "alpha", depthWrite: true }),
    ).toBe(true);
    expect(
      resolveParticleDepthWrite({ blend: "alpha", depthWrite: true }, 0.5),
    ).toBe(false);
    expect(
      resolveParticleDepthWrite({ blend: "additive", depthWrite: true }),
    ).toBe(false);
    expect(
      resolveParticleDepthWrite({ blend: "additive", depthWrite: false }),
    ).toBe(false);
    // I13-A D5: premultiplied never depth-writes, even at fully-opaque alpha.
    expect(
      resolveParticleDepthWrite({ blend: "premultiplied", depthWrite: true }),
    ).toBe(false);
    expect(
      resolveParticleDepthWrite(
        { blend: "premultiplied", depthWrite: true },
        0.999,
      ),
    ).toBe(false);
  });

  it("keeps, falls back, and round-trips the premultiplied emitter blend", () => {
    const survives = normalizeParticleEffect({
      id: "premultiplied-blend-effect",
      emitters: [
        {
          id: "premultiplied-blend-emitter",
          render: { blend: "premultiplied" },
        },
      ],
    });
    expect(survives.emitters[0]!.render.blend).toBe("premultiplied");

    // Unknown strings still fall back to alpha (compat pin unchanged).
    const unknown = normalizeParticleEffect({
      id: "unknown-blend-effect",
      emitters: [{ id: "unknown-blend-emitter", render: { blend: "glow" } }],
    });
    expect(unknown.emitters[0]!.render.blend).toBe("alpha");

    const additive = normalizeParticleEffect({
      id: "additive-blend-effect",
      emitters: [
        { id: "additive-blend-emitter", render: { blend: "additive" } },
      ],
    });
    expect(additive.emitters[0]!.render.blend).toBe("additive");

    // Serialize → re-normalize is byte-identical for the premultiplied value.
    const twice = normalizeParticleEffect(survives);
    expect(twice.emitters[0]!.render.blend).toBe("premultiplied");
    expect(twice).toEqual(survives);
  });

  it("promotes legacy mesh scalar size/rotation into 3D initialize fields", () => {
    const effect = normalizeParticleEffect({
      id: "mesh-3d-init-effect",
      emitters: [
        {
          id: "mesh-3d-init-emitter",
          mode: "mesh",
          initializeParticle: {
            size: { mode: "random", min: 2, max: 4 },
            rotation: { mode: "constant", value: 0.75 },
          },
          mesh: { pivot: [0.25, -0.5, 0.75] },
        },
      ],
    });
    const emitter = effect.emitters[0]!;

    expect(emitter.initializeParticle.size3D.x.mode).toBe("random");
    expect(emitter.initializeParticle.size3D.y.mode).toBe("random");
    expect(emitter.initializeParticle.size3D.z.mode).toBe("random");
    expect(emitter.initializeParticle.rotation3D.x.value).toBeCloseTo(0);
    expect(emitter.initializeParticle.rotation3D.y.value).toBeCloseTo(0);
    expect(emitter.initializeParticle.rotation3D.z.value).toBeCloseTo(0.75);
    expect(emitter.mesh.pivot).toEqual([0.25, -0.5, 0.75]);
  });

  it("normalizes 3D Start Rotation as an opt-in for billboards", () => {
    const legacy = normalizeParticleEffect({
      id: "legacy-start-rotation",
      emitters: [{ id: "legacy-billboard" }],
    });
    const authored = normalizeParticleEffect({
      id: "3d-start-rotation",
      emitters: [
        {
          id: "3d-billboard",
          initializeParticle: { startRotationSeparateAxes: true },
        },
      ],
    });

    expect(
      legacy.emitters[0]!.initializeParticle.startRotationSeparateAxes,
    ).toBe(false);
    expect(
      authored.emitters[0]!.initializeParticle.startRotationSeparateAxes,
    ).toBe(true);
    expect(normalizeParticleEffect(authored)).toEqual(authored);
  });

  it("defaults billboard pivot to center and keeps mesh pivot independent", () => {
    const emitter = createDefaultParticleEmitter();
    expect(emitter.billboard.pivot).toEqual([0, 0]);
    expect(emitter.mesh.pivot).toEqual([0, 0, 0]);
  });

  it("normalizes billboard pivot with Vec2 clamp and migration fallback", () => {
    const passthrough = normalizeParticleEffect({
      id: "billboard-pivot-effect",
      emitters: [
        {
          id: "billboard-pivot-emitter",
          mode: "billboard",
          billboard: { pivot: [0.25, -0.5] },
        },
      ],
    });
    expect(passthrough.emitters[0]!.billboard.pivot).toEqual([0.25, -0.5]);

    const clamped = normalizeParticleEffect({
      id: "billboard-pivot-clamp-effect",
      emitters: [
        {
          id: "billboard-pivot-clamp-emitter",
          mode: "billboard",
          billboard: { pivot: [50, -50] },
        },
      ],
    });
    expect(clamped.emitters[0]!.billboard.pivot).toEqual([10, -10]);

    const legacy = normalizeParticleEffect({
      id: "billboard-pivot-legacy-effect",
      emitters: [
        {
          id: "billboard-pivot-legacy-emitter",
          mode: "billboard",
          billboard: { shape: "circle" },
        },
      ],
    });
    expect(legacy.emitters[0]!.billboard.pivot).toEqual([0, 0]);

    const nonArray = normalizeParticleEffect({
      id: "billboard-pivot-nonarray-effect",
      emitters: [
        {
          id: "billboard-pivot-nonarray-emitter",
          mode: "billboard",
          billboard: { pivot: "nope" },
        },
      ],
    });
    expect(nonArray.emitters[0]!.billboard.pivot).toEqual([0, 0]);
  });

  it("migrates legacy spawn align-to-direction into renderer alignment", () => {
    const effect = normalizeParticleEffect({
      id: "align-migration-effect",
      emitters: [
        {
          id: "align-migration-emitter",
          spawn: { alignToDirection: true },
        },
      ],
    });

    expect(effect.emitters[0]?.spawn.alignToDirection).toBe(true);
    expect(effect.emitters[0]?.render.alignment).toBe("spawnDirection");
    expect(effect.emitters[0]?.render.alignAxis).toBe("spawnDirection");
    expect(effect.emitters[0]?.render.facing).toBe("off");
  });

  it("migrates legacy renderer alignment into explicit axis and facing fields", () => {
    const cases = [
      {
        alignment: "faceCamera",
        alignAxis: "screen",
        facing: "cameraPlane",
      },
      { alignment: "velocity", alignAxis: "velocity", facing: "off" },
      {
        alignment: "spawnDirection",
        alignAxis: "spawnDirection",
        facing: "off",
      },
      { alignment: "vector", alignAxis: "vector", facing: "off" },
    ] as const;

    for (const expected of cases) {
      const effect = normalizeParticleEffect({
        id: `legacy-${expected.alignment}`,
        emitters: [
          {
            id: `legacy-${expected.alignment}-emitter`,
            render: { alignment: expected.alignment },
          },
        ],
      });

      expect(effect.emitters[0]?.render).toMatchObject(expected);
    }
  });

  it("preserves authored renderer axis and facing fields", () => {
    const effect = normalizeParticleEffect({
      id: "authored-facing-effect",
      emitters: [
        {
          id: "authored-facing-emitter",
          render: { alignAxis: "velocity", facing: "cameraPosition" },
        },
      ],
    });

    expect(effect.emitters[0]?.render.alignment).toBe("velocity");
    expect(effect.emitters[0]?.render.alignAxis).toBe("velocity");
    expect(effect.emitters[0]?.render.facing).toBe("cameraPosition");
  });

  it("normalizes extended particle module toggles and settings", () => {
    const effect = normalizeParticleEffect({
      id: "extended-effect",
      emitters: [
        {
          id: "extended-emitter",
          modules: {
            lifetimeByEmitterSpeed: true,
            noise: true,
            trails: true,
          },
          advanced: {
            lifetimeByEmitterSpeed: {
              speedRange: { min: 20, max: 4 },
              multiplier: { mode: "constant", value: 2 },
            },
            noise: {
              frequency: 64,
              octaves: 10,
              strength: { mode: "constant", value: 3 },
            },
            collision: { mode: "plane", killBelow: 999 },
            customData: {
              vector1: [0.2, 0.3, 0.4, 0.5],
              color: [0.9, 0.8, 0.7, 0.6],
            },
          },
        },
      ],
    });

    const emitter = effect.emitters[0];
    expect(emitter?.modules.lifetimeByEmitterSpeed).toBe(true);
    expect(emitter?.modules.noise).toBe(true);
    expect(emitter?.modules.trails).toBe(true);
    expect(emitter?.modules.colorBySpeed).toBe(false);
    expect(emitter?.advanced.lifetimeByEmitterSpeed.speedRange).toEqual({
      min: 4,
      max: 20,
    });
    expect(emitter?.advanced.lifetimeByEmitterSpeed.multiplier.value).toBe(2);
    expect(emitter?.advanced.noise.frequency).toBe(32);
    expect(emitter?.advanced.noise.octaves).toBe(6);
    expect(emitter?.advanced.trails.widthOverTrail).toMatchObject({
      mode: "constant",
      value: 1,
    });
    expect(emitter?.advanced.collision.killBelow).toBe(200);
    expect(
      emitter?.advanced.customData.channels.map((channel) => channel.value),
    ).toEqual([0.2, 0.3, 0.4, 0.5]);
  });

  it("keeps missing speed interpolation fields in curve mode", () => {
    const effect = normalizeParticleEffect({
      id: "curve-default-effect",
      emitters: [{ id: "curve-default-emitter" }],
    });

    const emitter = effect.emitters[0];
    expect(emitter?.advanced.lifetimeByEmitterSpeed.multiplier.mode).toBe(
      "curve",
    );
    expect(emitter?.advanced.sizeBySpeed.multiplier.mode).toBe("curve");
    expect(emitter?.advanced.rotationBySpeed.angularVelocity.mode).toBe(
      "curve",
    );
    expect(emitter?.advanced.textureSheetAnimation.frameOverTime.mode).toBe(
      "curve",
    );
    expect(emitter?.advanced.limitVelocityOverLifetime.speed.mode).toBe(
      "curve",
    );
    expect(emitter?.advanced.inheritVelocity.multiplier.mode).toBe("curve");
  });

  it("defaults texture sheet endFrame to the whole-sheet sentinel", () => {
    const effect = normalizeParticleEffect({
      id: "tsa-default-endframe",
      emitters: [
        {
          id: "tsa-emitter",
          advanced: {
            textureSheetAnimation: { tiles: [4, 4], startFrame: 0 },
          },
        },
      ],
    });

    expect(effect.emitters[0]?.advanced.textureSheetAnimation.endFrame).toBe(
      255,
    );
  });

  it("clamps and rounds texture sheet endFrame to [0, 255]", () => {
    const endFrameFor = (endFrame: number) =>
      normalizeParticleEffect({
        id: "tsa-clamp-endframe",
        emitters: [
          {
            id: "tsa-emitter",
            advanced: { textureSheetAnimation: { tiles: [4, 4], endFrame } },
          },
        ],
      }).emitters[0]?.advanced.textureSheetAnimation.endFrame;

    expect(endFrameFor(8)).toBe(8);
    expect(endFrameFor(999)).toBe(255);
    expect(endFrameFor(-3)).toBe(0);
    expect(endFrameFor(8.6)).toBe(9);
  });

  it("round-trips texture sheet endFrame idempotently", () => {
    const roundTrip = (endFrame: number) => {
      const once = normalizeParticleEffect({
        id: "tsa-roundtrip-endframe",
        emitters: [
          {
            id: "tsa-emitter",
            advanced: { textureSheetAnimation: { tiles: [4, 4], endFrame } },
          },
        ],
      });
      const twice = normalizeParticleEffect(once);
      return twice.emitters[0]?.advanced.textureSheetAnimation.endFrame;
    };

    expect(roundTrip(8)).toBe(8);
    expect(roundTrip(255)).toBe(255);
  });

  it("keeps legacy texture sheet JSON whole-sheet through the sampler", () => {
    const effect = normalizeParticleEffect({
      id: "tsa-legacy-endframe",
      emitters: [
        {
          id: "tsa-emitter",
          modules: { textureSheetAnimation: true },
          advanced: {
            textureSheetAnimation: {
              tiles: [4, 4],
              startFrame: 0,
              frameOverTime: { mode: "constant", value: 5 },
              cycles: 2,
              randomStartFrame: false,
            },
          },
        },
      ],
    });
    const tsa = effect.emitters[0]?.advanced.textureSheetAnimation;
    if (!tsa) throw new Error("Expected normalized texture sheet animation");

    // legacy JSON (no endFrame) defaults to the whole-sheet sentinel...
    expect(tsa.endFrame).toBe(255);
    // ...and reproduces the pre-I13-G frame index: floor(5 * 2) % 16 = 10.
    expect(sampleTextureSheetAnimationFrame(tsa, 0.5, 0.25).frame).toBe(10);
  });

  it("normalizes authored burst schedules and simulation space", () => {
    const effect = normalizeParticleEffect({
      id: "scheduled-burst-effect",
      emitters: [
        {
          id: "scheduled-burst-emitter",
          spawn: {
            simulationSpace: "local",
            bursts: [
              {
                time: 0.25,
                count: 4.7,
                cycles: 3,
                interval: 0.2,
                probability: 0.5,
              },
              { time: 0.5, count: 0 },
            ],
          },
        },
      ],
    });

    expect(effect.emitters[0]?.spawn.simulationSpace).toBe("local");
    expect(effect.emitters[0]?.spawn.bursts).toEqual([
      {
        time: 0.25,
        count: 5,
        cycles: 3,
        interval: 0.2,
        probability: 0.5,
      },
    ]);
  });

  it("samples scalar curves without mutating raw fallback input", () => {
    const singlePointCurve = [{ x: 0.4, y: 7 }];

    expect(sampleParticleCurve(singlePointCurve, 0.25)).toBe(7);
    expect(singlePointCurve).toEqual([{ x: 0.4, y: 7 }]);

    const effect = normalizeParticleEffect({
      id: "normalized-curve-effect",
      emitters: [
        {
          id: "normalized-curve-emitter",
          spawn: {
            rateValue: {
              mode: "curve",
              curve: [
                { x: 0, y: 4, slope: 0 },
                { x: 1, y: 12, slope: 0 },
              ],
            },
          },
        },
      ],
    });
    const value = effect.emitters[0]!.spawn.rateValue;
    const points = value.curve;

    expect(sampleParticleCurve(points, 0)).toBeCloseTo(1 / 3);
    expect(sampleParticleCurve(points, 0.5)).toBeCloseTo(2 / 3);
    expect(sampleParticleCurve(points, 1)).toBe(1);
    expect(sampleParticleScalarValue(value, 0, 0)).toBe(4);
    expect(sampleParticleScalarValue(value, 0.5, 0)).toBe(8);
    expect(sampleParticleScalarValue(value, 1, 0)).toBe(12);
  });

  it("samples compiled scalar values with source parity", () => {
    const effect = normalizeParticleEffect({
      id: "compiled-scalar-effect",
      emitters: [
        {
          id: "compiled-scalar-emitter",
          spawn: {
            rateValue: {
              mode: "randomCurve",
              curve: [
                { x: 0, y: 2 },
                { x: 0.5, y: 8, slope: 0 },
                { x: 1, y: 4 },
              ],
              curveB: [
                { x: 0, y: 5 },
                { x: 1, y: 11 },
              ],
            },
          },
        },
      ],
    });
    const value = effect.emitters[0]!.spawn.rateValue;
    const compiled = compileParticleScalarValue(value, 257);

    for (const t of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      for (const random of [0, 0.37, 1]) {
        expect(sampleCompiledParticleScalar(compiled, t, random)).toBeCloseTo(
          sampleParticleScalarValue(value, t, random),
          3,
        );
      }
    }
  });

  it("samples compiled gradients with source parity and reusable output", () => {
    const effect = normalizeParticleEffect({
      id: "compiled-gradient-effect",
      emitters: [
        {
          id: "compiled-gradient-emitter",
          color: {
            gradient: {
              mode: "blend",
              colorStops: [
                { position: 0, color: [1, 0, 0] },
                { position: 0.5, color: [0, 1, 0] },
                { position: 1, color: [0, 0, 1] },
              ],
              alphaStops: [
                { position: 0, alpha: 0.25 },
                { position: 1, alpha: 0.75 },
              ],
            },
          },
        },
      ],
    });
    const gradient = effect.emitters[0]!.color.gradient;
    const compiled = compileParticleGradient(gradient, 257);
    const out: [number, number, number, number] = [0, 0, 0, 0];

    for (const t of [0, 0.125, 0.5, 0.875, 1]) {
      const sampled = sampleCompiledParticleGradient(compiled, t, out);
      const color = sampleParticleGradientColor(gradient, t);
      const alpha = sampleParticleGradientAlpha(gradient, t);
      expect(sampled).toBe(out);
      expect(sampled[0]).toBeCloseTo(color[0], 3);
      expect(sampled[1]).toBeCloseTo(color[1], 3);
      expect(sampled[2]).toBeCloseTo(color[2], 3);
      expect(sampled[3]).toBeCloseTo(alpha, 3);
    }
  });

  it("interpolates gradient RGB in linear light and keeps sRGB endpoints exact", () => {
    const effect = normalizeParticleEffect({
      id: "linear-gradient-effect",
      emitters: [
        {
          id: "linear-gradient-emitter",
          color: {
            gradient: {
              mode: "blend",
              colorStops: [
                { position: 0, color: [1, 0, 0] },
                { position: 1, color: [0, 0, 0] },
              ],
              alphaStops: [
                { position: 0, alpha: 1 },
                { position: 1, alpha: 0 },
              ],
            },
          },
        },
      ],
    });
    const gradient = effect.emitters[0]!.color.gradient;

    expect(sampleParticleGradientColor(gradient, 0)).toEqual([1, 0, 0]);
    expect(sampleParticleGradientColor(gradient, 1)).toEqual([0, 0, 0]);
    expect(sampleParticleGradientColor(gradient, 0.5)[0]).toBeCloseTo(
      linearToSrgb(0.5),
      6,
    );
    expect(sampleParticleGradientAlpha(gradient, 0.5)).toBeCloseTo(0.5, 6);
  });

  it("round-trips sRGB transfer helpers for canonical channel values", () => {
    for (const value of [0, 0.5, 1]) {
      expect(linearToSrgb(srgbToLinear(value))).toBeCloseTo(value, 6);
    }
  });

  it("emits scheduled start bursts once per loop", () => {
    const effect = normalizeParticleEffect({
      id: "loop-burst-effect",
      emitters: [
        {
          id: "loop-burst-emitter",
          maxParticles: 16,
          duration: 0.1,
          loop: true,
          modules: { velocity: false },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 3, cycles: 1, interval: 0, probability: 1 },
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
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);
    expect(runner.stats.emittedLastFrame).toBe(3);

    runner.update(0.01, 0.02);
    expect(runner.stats.emittedLastFrame).toBe(0);

    runner.update(0.1, 0.12);
    expect(runner.stats.emittedLastFrame).toBe(3);
  });

  it("keeps live particles when a looping emitter starts its next cycle", () => {
    const effect = normalizeParticleEffect({
      id: "loop-retains-live-particles-effect",
      emitters: [
        {
          id: "loop-retains-live-particles-emitter",
          maxParticles: 16,
          duration: 1,
          loop: true,
          modules: { velocity: false },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0.95, count: 2, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 1.2 },
            velocity: {
              mode: "shapeDirection",
              speed: { mode: "constant", value: 0 },
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.96, 0.96);
    expect(runner.stats.emittedLastFrame).toBe(2);
    expect(runner.stats.activeParticles).toBe(2);

    runner.update(0.05, 1.01);
    expect(runner.states[0]!.age).toBeCloseTo(0.01);
    expect(runner.stats.emittedLastFrame).toBe(0);
    expect(runner.stats.activeParticles).toBe(2);
    expect(runner.isActive).toBe(true);
  });

  it("delays emitter simulation until its timeline start", () => {
    const effect = normalizeParticleEffect({
      id: "delayed-emitter-effect",
      emitters: [
        {
          id: "delayed-emitter",
          maxParticles: 16,
          duration: 1,
          loop: false,
          timeline: { start: 0.2 },
          modules: { velocity: false },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 3, cycles: 1, interval: 0, probability: 1 },
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
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.1, 0.1);
    expect(runner.stats.emittedLastFrame).toBe(0);

    runner.update(0.11, 0.21);
    expect(runner.stats.emittedLastFrame).toBe(3);
  });

  it("emits authored burst schedules by time, cycle, interval, and probability", () => {
    const effect = normalizeParticleEffect({
      id: "scheduled-burst-runner-effect",
      emitters: [
        {
          id: "scheduled-burst-runner-emitter",
          maxParticles: 16,
          duration: 1,
          loop: false,
          modules: { velocity: false },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              {
                time: 0.1,
                count: 2,
                cycles: 3,
                interval: 0.2,
                probability: 1,
              },
              {
                time: 0.15,
                count: 8,
                cycles: 1,
                interval: 0,
                probability: 0,
              },
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
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.05, 0.05);
    expect(runner.stats.emittedLastFrame).toBe(0);

    runner.update(0.06, 0.11);
    expect(runner.stats.emittedLastFrame).toBe(2);

    runner.update(0.19, 0.3);
    expect(runner.stats.emittedLastFrame).toBe(2);

    runner.update(0.2, 0.5);
    expect(runner.stats.emittedLastFrame).toBe(2);

    runner.update(0.2, 0.7);
    expect(runner.stats.emittedLastFrame).toBe(0);
  });

  it("emits particles from rate over distance", () => {
    const effect = normalizeParticleEffect({
      id: "distance-rate-effect",
      emitters: [
        {
          id: "distance-rate-emitter",
          maxParticles: 16,
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            rateOverDistance: 2,
            rateOverDistanceValue: { mode: "constant", value: 2 },
            bursts: [],
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.1, 0.1);
    runner.setPosition([2, 0, 0]);
    runner.update(0.1, 0.2);

    expect(runner.stats.emittedLastFrame).toBe(4);
  });

  it("applies inherited emitter velocity to distance-spawned particles", () => {
    const effect = normalizeParticleEffect({
      id: "inherit-velocity-effect",
      emitters: [
        {
          id: "inherit-velocity-emitter",
          maxParticles: 4,
          modules: { velocity: false, inheritVelocity: true },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            rateOverDistance: 1,
            rateOverDistanceValue: { mode: "constant", value: 1 },
            bursts: [],
          },
          advanced: {
            inheritVelocity: {
              mode: "initial",
              multiplier: { mode: "constant", value: 1 },
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.1, 0.1);
    runner.setPosition([1, 0, 0]);
    runner.update(0.1, 0.2);

    const velocityX = runner.states[0]?.instanceData[4] ?? 0;
    expect(runner.stats.emittedLastFrame).toBe(1);
    expect(velocityX).toBeCloseTo(10);
  });

  it("keeps local-space particles attached to emitter movement", () => {
    const localRunner = createSpaceRunner("local");
    const worldRunner = createSpaceRunner("world");

    localRunner.setPosition([10, 0, 0]);
    worldRunner.setPosition([10, 0, 0]);
    localRunner.update(0.1, 0.11);
    worldRunner.update(0.1, 0.11);

    expect(localRunner.states[0]?.instanceData[0]).toBeCloseTo(11);
    expect(worldRunner.states[0]?.instanceData[0]).toBeCloseTo(1);
    expect(localRunner.states[0]?.runtimeFlagsData[0]).toBe(
      PARTICLE_RUNTIME_FLAG_LOCAL_SPACE,
    );
    expect(worldRunner.states[0]?.runtimeFlagsData[0]).toBe(0);
  });

  it("exposes align-to-direction metadata without changing packed stride", () => {
    const effect = normalizeParticleEffect({
      id: "align-direction-effect",
      emitters: [
        {
          id: "align-direction-emitter",
          maxParticles: 2,
          modules: { velocity: false, rotation: false },
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
            velocity: {
              mode: "shapeDirection",
              speed: { mode: "constant", value: 3 },
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);

    const state = runner.states[0]!;
    expect(state.runtimeFlagsData[0]).toBe(
      PARTICLE_RUNTIME_FLAG_ALIGN_TO_DIRECTION,
    );
    expect(state.spawnDirectionData[0]).toBeCloseTo(0);
    expect(state.spawnDirectionData[1]).toBeCloseTo(1);
    expect(state.spawnDirectionData[2]).toBeCloseTo(0);
  });

  it("applies start rotation even when rotation-over-lifetime is off (B4)", () => {
    const startRotation = 0.75;
    const effect = normalizeParticleEffect({
      id: "start-rotation-effect",
      emitters: [
        {
          id: "start-rotation-emitter",
          maxParticles: 2,
          modules: { velocity: false, rotation: false },
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
            rotation: { mode: "constant", value: startRotation },
            angularVelocity: { mode: "constant", value: 2 },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);
    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);

    const state = runner.states[0]!;
    // slot+9 is the initial-rotation slot for particle 0 — written regardless
    // of the rotation module.
    expect(state.instanceData[9]).toBeCloseTo(startRotation);
    // slot+10 (over-life angular velocity) stays gated by the module toggle.
    expect(state.instanceData[10]).toBeCloseTo(0);
  });

  it("packs billboard XYZ start rotation when 3D Start Rotation is enabled", () => {
    const effect = normalizeParticleEffect({
      id: "billboard-3d-start-rotation-effect",
      emitters: [
        {
          id: "billboard-3d-start-rotation-emitter",
          maxParticles: 2,
          modules: { velocity: false, rotation: false },
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
            startRotationSeparateAxes: true,
            rotation3D: {
              x: { mode: "constant", value: 0.1 },
              y: { mode: "constant", value: 0.2 },
              z: { mode: "constant", value: 0.3 },
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);

    const state = runner.states[0]!;
    expect(state.instanceData[13]).toBeCloseTo(0.1);
    expect(state.instanceData[14]).toBeCloseTo(0.2);
    expect(state.instanceData[9]).toBeCloseTo(0.3);
  });

  it("packs mesh vec3 start rotation, angular velocity, and scale into previewable slots", () => {
    const effect = normalizeParticleEffect({
      id: "mesh-init-slots-effect",
      emitters: [
        {
          id: "mesh-init-slots-emitter",
          mode: "mesh",
          maxParticles: 2,
          modules: { velocity: false, rotation: true },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
          },
          render: { alignment: "spawnDirection" },
          initializeParticle: {
            lifetime: { mode: "constant", value: 1 },
            size3D: {
              x: { mode: "constant", value: 2 },
              y: { mode: "constant", value: 3 },
              z: { mode: "constant", value: 4 },
            },
            rotation3D: {
              x: { mode: "constant", value: 0.1 },
              y: { mode: "constant", value: 0.2 },
              z: { mode: "constant", value: 0.9 },
            },
            angularVelocitySeparateAxes: true,
            angularVelocity3D: {
              x: { mode: "constant", value: 1.1 },
              y: { mode: "constant", value: 1.2 },
              z: { mode: "constant", value: 1.3 },
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);

    const state = runner.states[0]!;
    expect(state.runtimeFlagsData[0]).toBe(
      PARTICLE_RUNTIME_FLAG_ALIGN_TO_DIRECTION,
    );
    expect(state.instanceData[9]).toBeCloseTo(0.9);
    expect(state.instanceData[10]).toBeCloseTo(1.3);
    expect(state.instanceData[11]).toBeCloseTo(2);
    expect(state.instanceData[12]).toBeCloseTo(3);
    expect(state.instanceData[13]).toBeCloseTo(0.1);
    expect(state.instanceData[14]).toBeCloseTo(0.2);
    expect(state.instanceData[15]).toBeCloseTo(1.1);
    expect(state.instanceData[16]).toBeCloseTo(1.2);
    expect(state.instanceData[17]).toBeCloseTo(4);
  });

  it("samples non-uniform billboard Start Size from size3D X/Y (V4)", () => {
    const effect = normalizeParticleEffect({
      id: "billboard-separate-size-effect",
      emitters: [
        {
          id: "billboard-separate-size-emitter",
          maxParticles: 2,
          modules: { velocity: false, rotation: false },
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
              y: { mode: "constant", value: 4 },
              z: { mode: "constant", value: 1 },
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);

    const state = runner.states[0]!;
    // Slot 11 -> scaleX (size3D.x), slot 12 -> scaleY (size3D.y).
    expect(state.instanceData[11]).toBeCloseTo(2);
    expect(state.instanceData[12]).toBeCloseTo(4);
  });

  it("keeps uniform Start Size when the separate-axes flag is absent (V4 migration)", () => {
    // Legacy payload: no startSizeSeparateAxes flag and no size3D block.
    const effect = normalizeParticleEffect({
      id: "billboard-uniform-size-effect",
      emitters: [
        {
          id: "billboard-uniform-size-emitter",
          maxParticles: 2,
          modules: { velocity: false, rotation: false },
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
            size: { mode: "constant", value: 3 },
          },
        },
      ],
    });
    // Migration: absent flag normalizes to false.
    expect(effect.emitters[0]!.initializeParticle.startSizeSeparateAxes).toBe(
      false,
    );

    const runner = new ParticleEffectRunner(effect);
    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);

    const state = runner.states[0]!;
    // Both slots carry the uniform size — byte-identical to pre-change behavior.
    expect(state.instanceData[11]).toBeCloseTo(3);
    expect(state.instanceData[12]).toBeCloseTo(3);
    expect(state.instanceData[11]).toBe(state.instanceData[12]);
  });

  it("does not shift the RNG sequence when toggling separate Start Size axes (V4 determinism)", () => {
    // Two particles spawn in one burst; particle 1's random lifetime draw is a
    // downstream RNG witness. With all size inputs constant, neither the
    // uniform nor the separate-axes branch consumes an rng draw, so the witness
    // must match regardless of the toggle.
    const makeRunner = (separate: boolean): ParticleEffectRunner => {
      // Same id/seed for both runs so the RNG stream is identical; only the
      // toggle differs (the runner seeds rng from the effect id).
      const effect = normalizeParticleEffect({
        id: "billboard-size-determinism",
        emitters: [
          {
            id: "billboard-size-determinism-emitter",
            maxParticles: 4,
            modules: { velocity: false, rotation: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 2, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              // Random lifetime is the downstream witness.
              lifetime: { mode: "random", min: 0.5, max: 2 },
              size: { mode: "constant", value: 1 },
              startSizeSeparateAxes: separate,
              size3D: {
                x: { mode: "constant", value: 2 },
                y: { mode: "constant", value: 4 },
                z: { mode: "constant", value: 1 },
              },
            },
          },
        ],
      });
      const runner = new ParticleEffectRunner(effect);
      runner.reset(effect, [0, 0, 0], 0);
      runner.update(0.01, 0.01);
      return runner;
    };

    const stride = PARTICLE_INSTANCE_STRIDE;
    const off = makeRunner(false).states[0]!.instanceData;
    const on = makeRunner(true).states[0]!.instanceData;
    // Particle index 1's lifetime (slot+7) is unaffected by the toggle.
    expect(on[stride + 7]).toBeCloseTo(off[stride + 7]);
    expect(on[stride + 7]).not.toBe(off[0 + 7]);
  });

  it("samples INDEPENDENT random non-uniform billboard Start Size (I13-C)", () => {
    const runOnce = (): Float32Array => {
      const effect = normalizeParticleEffect({
        id: "billboard-random-separate-size-effect",
        emitters: [
          {
            id: "billboard-random-separate-size-emitter",
            maxParticles: 16,
            modules: { velocity: false, rotation: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 16, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              startSizeSeparateAxes: true,
              size3D: {
                x: { mode: "random", min: 1, max: 2 },
                y: { mode: "random", min: 3, max: 4 },
                z: { mode: "constant", value: 1 },
              },
            },
          },
        ],
      });
      const runner = new ParticleEffectRunner(effect);
      runner.reset(effect, [0, 0, 0], 0);
      runner.update(0.01, 0.01);
      return runner.states[0]!.instanceData;
    };

    const stride = PARTICLE_INSTANCE_STRIDE;
    const data = runOnce();
    let maxGap = 0;
    for (let i = 0; i < 16; i++) {
      const x = data[i * stride + 11]!;
      const y = data[i * stride + 12]!;
      // Range pins: each axis stays inside its own [min, max].
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(2);
      expect(y).toBeGreaterThanOrEqual(3);
      expect(y).toBeLessThanOrEqual(4);
      // Recover the per-axis interpolants; independent draws decorrelate them.
      maxGap = Math.max(maxGap, Math.abs(x - 1 - (y - 3)));
    }
    // Under the old SHARED draw the two fractions matched to float32 noise
    // (~1.2e-7). Independent per-axis draws push the gap far above that; 0.1 is
    // safely below the deterministic LCG spread over 16 particles.
    expect(maxGap).toBeGreaterThan(0.1);

    // Determinism: the LCG is seeded from the effect id, so a second identical
    // run reproduces the same (decorrelated) sizes element-wise.
    const data2 = runOnce();
    for (let i = 0; i < 16; i++) {
      expect(data2[i * stride + 11]).toBe(data[i * stride + 11]);
      expect(data2[i * stride + 12]).toBe(data[i * stride + 12]);
    }
  });

  it("samples independent random per-axis mesh Start Scale (I13-C)", () => {
    const effect = normalizeParticleEffect({
      id: "mesh-random-separate-size-effect",
      emitters: [
        {
          id: "mesh-random-separate-size-emitter",
          mode: "mesh",
          maxParticles: 16,
          modules: { velocity: false, rotation: false },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 16, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 1 },
            size3D: {
              x: { mode: "random", min: 1, max: 2 },
              y: { mode: "random", min: 3, max: 4 },
              z: { mode: "random", min: 5, max: 6 },
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);
    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);

    const stride = PARTICLE_INSTANCE_STRIDE;
    const data = runner.states[0]!.instanceData;
    let maxGapXY = 0;
    let maxGapXZ = 0;
    let maxGapYZ = 0;
    for (let i = 0; i < 16; i++) {
      const x = data[i * stride + 11]!;
      const y = data[i * stride + 12]!;
      const z = data[i * stride + 17]!;
      // Range pins: each axis stays inside its own [min, max].
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(2);
      expect(y).toBeGreaterThanOrEqual(3);
      expect(y).toBeLessThanOrEqual(4);
      expect(z).toBeGreaterThanOrEqual(5);
      expect(z).toBeLessThanOrEqual(6);
      // Independent draws mutually decorrelate all three interpolants.
      maxGapXY = Math.max(maxGapXY, Math.abs(x - 1 - (y - 3)));
      maxGapXZ = Math.max(maxGapXZ, Math.abs(x - 1 - (z - 5)));
      maxGapYZ = Math.max(maxGapYZ, Math.abs(y - 3 - (z - 5)));
    }
    expect(maxGapXY).toBeGreaterThan(0.1);
    expect(maxGapXZ).toBeGreaterThan(0.1);
    expect(maxGapYZ).toBeGreaterThan(0.1);
  });

  it("keeps constant per-axis mesh Start Scale byte-identical (I13-C)", () => {
    // Constant axes draw zero rng samples (scalarRandom returns 0.5 without
    // drawing), so the packed sizes must equal the authored values exactly.
    const effect = normalizeParticleEffect({
      id: "mesh-constant-separate-size-effect",
      emitters: [
        {
          id: "mesh-constant-separate-size-emitter",
          mode: "mesh",
          maxParticles: 2,
          modules: { velocity: false, rotation: false },
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
              x: { mode: "constant", value: 7 },
              y: { mode: "constant", value: 9 },
              z: { mode: "constant", value: 11 },
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);
    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);

    const data = runner.states[0]!.instanceData;
    expect(data[11]).toBe(7);
    expect(data[12]).toBe(9);
    expect(data[17]).toBe(11);
  });

  it("random per-axis Start Size shifts the RNG stream across the separate-axes toggle (I13-C intentional)", () => {
    // Mirror image of the constant-input determinism test above: with RANDOM
    // per-axis size, the separate-axes branch draws two rng samples for
    // particle 0 while the uniform branch draws zero (constant `size`), so
    // particle 1's downstream lifetime witness shifts. This stream shift is the
    // deliberately-accepted D2 tradeoff for correct per-axis decorrelation.
    const makeRunner = (separate: boolean): ParticleEffectRunner => {
      const effect = normalizeParticleEffect({
        id: "billboard-random-size-stream-shift",
        emitters: [
          {
            id: "billboard-random-size-stream-shift-emitter",
            maxParticles: 4,
            modules: { velocity: false, rotation: false },
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              bursts: [
                { time: 0, count: 2, cycles: 1, interval: 0, probability: 1 },
              ],
              shape: "point",
            },
            initializeParticle: {
              // Random lifetime is the downstream witness.
              lifetime: { mode: "random", min: 0.5, max: 2 },
              size: { mode: "constant", value: 1 },
              startSizeSeparateAxes: separate,
              size3D: {
                x: { mode: "random", min: 1, max: 2 },
                y: { mode: "random", min: 3, max: 4 },
                z: { mode: "constant", value: 1 },
              },
            },
          },
        ],
      });
      const runner = new ParticleEffectRunner(effect);
      runner.reset(effect, [0, 0, 0], 0);
      runner.update(0.01, 0.01);
      return runner;
    };

    const stride = PARTICLE_INSTANCE_STRIDE;
    const off = makeRunner(false).states[0]!.instanceData;
    const on = makeRunner(true).states[0]!.instanceData;
    // Particle index 1's lifetime (slot+7) shifts because particle 0 consumed a
    // different number of size draws with the flag on. Contrast the constant
    // case above, which uses toBeCloseTo.
    expect(on[stride + 7]).not.toBe(off[stride + 7]);
  });

  it("uses initializeParticle.lifetime to control particle death time", () => {
    const effect = normalizeParticleEffect({
      id: "init-lifetime-effect",
      emitters: [
        {
          id: "init-lifetime-emitter",
          maxParticles: 4,
          duration: 10,
          loop: false,
          modules: { velocity: false },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 0.5 },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0);
    runner.update(0.01, 0.01);
    expect(runner.states[0]?.instanceData[7]).toBeCloseTo(0.5);

    // Still alive just before its lifetime elapses.
    runner.update(0.48, 0.49);
    expect(runner.states[0]?.activeCount).toBe(1);

    // Dead once the simulation passes the 0.5s lifetime.
    runner.update(0.1, 0.59);
    expect(runner.states[0]?.activeCount).toBe(0);
  });

  it("spawns shapeDirection and vector initial velocity modes", () => {
    const shapeRunner = createVelocityModeRunner({
      mode: "shapeDirection",
      speed: { mode: "constant", value: 4 },
    });
    // Point shape emits straight up (+Y); shapeDirection scales that by speed.
    const shapeState = shapeRunner.states[0]!;
    expect(shapeState.instanceData[4]).toBeCloseTo(0);
    expect(shapeState.instanceData[5]).toBeCloseTo(4);
    expect(shapeState.instanceData[6]).toBeCloseTo(0);

    const vectorRunner = createVelocityModeRunner({
      mode: "vector",
      min: [2, -3, 5],
      max: [2, -3, 5],
      speed: { mode: "constant", value: 99 },
    });
    // Vector mode ignores shape direction/speed and uses the per-axis range.
    const vectorState = vectorRunner.states[0]!;
    expect(vectorState.instanceData[4]).toBeCloseTo(2);
    expect(vectorState.instanceData[5]).toBeCloseTo(-3);
    expect(vectorState.instanceData[6]).toBeCloseTo(5);
  });

  it("samples deterministic point, circle, box, and cone spawn sidecars", () => {
    expect(sampleSpawnSidecar("point").local).toEqual([0, 0, 0]);
    expect(sampleSpawnSidecar("circle").local).toEqual([1, 0, 0]);

    const box = sampleSpawnSidecar("box");
    expect(box.local[0]).toBeGreaterThanOrEqual(-1);
    expect(box.local[0]).toBeLessThanOrEqual(1);
    expect(box.local[1]).toBeGreaterThanOrEqual(-2);
    expect(box.local[1]).toBeLessThanOrEqual(2);
    expect(box.local[2]).toBeGreaterThanOrEqual(-3);
    expect(box.local[2]).toBeLessThanOrEqual(3);
    expect(box).toEqual(sampleSpawnSidecar("box"));

    const cone = sampleSpawnSidecar("cone");
    expect(cone.local[0]).toBeCloseTo(2);
    expect(cone.local[1]).toBeCloseTo(0);
    expect(cone.local[2]).toBeCloseTo(0);
    expect(cone.direction[0]).toBeCloseTo(0.5);
    expect(cone.direction[1]).toBeCloseTo(Math.cos(Math.PI / 6));
    expect(cone.direction[2]).toBeCloseTo(0);
  });

  it("normalizes sphere and hemisphere shapes without coercing to circle", () => {
    const effect = normalizeParticleEffect({
      id: "sphere-shape-normalize",
      emitters: [
        { id: "sphere", spawn: { shape: "sphere" } },
        { id: "hemisphere", spawn: { shape: "hemisphere" } },
      ],
    });
    expect(effect.emitters[0]?.spawn.shape).toBe("sphere");
    expect(effect.emitters[1]?.spawn.shape).toBe("hemisphere");
  });

  it("samples sphere and hemisphere spawn positions within the radius", () => {
    const radius = 2;
    const surface = sampleShapePositions("sphere", 32, 0, radius);
    for (const [x, y, z] of surface) {
      expect(Math.hypot(x, y, z)).toBeCloseTo(radius, 4);
    }
    // Deterministic for a fixed seed.
    expect(sampleShapePositions("sphere", 32, 0, radius)).toEqual(surface);

    const volume = sampleShapePositions("sphere", 64, 1, radius);
    for (const [x, y, z] of volume) {
      expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(radius + 1e-6);
    }
    // Volume fill should produce at least one point clearly inside the shell.
    expect(volume.some(([x, y, z]) => Math.hypot(x, y, z) < radius - 0.1)).toBe(
      true,
    );

    const hemisphere = sampleShapePositions("hemisphere", 48, 0, radius);
    for (const [x, y, z] of hemisphere) {
      expect(Math.hypot(x, y, z)).toBeCloseTo(radius, 4);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("samples loop, ping-pong, and arc-speed shape modes deterministically", () => {
    expect(sampleCircleArcSidecar("loop", 0, 0.25)).toEqual([0, 1]);
    expect(sampleCircleArcSidecar("pingPong", 0, 0.75)).toEqual([-1, 0]);
    expect(sampleCircleArcSidecar("loop", 360, 0.25)).toEqual([-1, 0]);
  });

  it("keeps seeded stress simulation deterministic", () => {
    const effect = createDeterministicStressEffect();

    expect(runStressSnapshot(effect)).toEqual(runStressSnapshot(effect));
  });

  it("records birth, normalized-time, and death trigger events", () => {
    const effect = normalizeParticleEffect({
      id: "trigger-event-effect",
      emitters: [
        {
          id: "trigger-event-emitter",
          maxParticles: 2,
          duration: 1,
          loop: false,
          modules: { velocity: false, triggers: true },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 0.2 },
            velocity: {
              mode: "shapeDirection",
              speed: { mode: "constant", value: 0 },
            },
          },
          advanced: {
            triggers: {
              birthEvent: "spark-born",
              deathEvent: "spark-dead",
              normalizedTime: 0.5,
              oneShot: true,
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);

    runner.reset(effect, [0, 0, 0], 0, 0x1234);
    runner.update(0.01, 0.01);
    expect(runner.events).toMatchObject([
      {
        kind: "birth",
        eventName: "spark-born",
        emitterId: "trigger-event-emitter",
        particleAge: 0,
        normalizedAge: 0,
      },
    ]);

    runner.update(0.1, 0.11);
    expect(runner.events).toMatchObject([
      {
        kind: "normalizedTime",
        eventName: "normalized-time",
        normalizedAge: 0.5,
      },
    ]);
    expect(runner.events[0]?.particleAge).toBeCloseTo(0.1);

    runner.update(0.2, 0.31);
    expect(runner.events).toMatchObject([
      {
        kind: "death",
        eventName: "spark-dead",
        normalizedAge: 1,
      },
    ]);
    expect(runner.events[0]?.particleAge).toBeCloseTo(0.2);
  });

  it("queues deterministic sub-emitter requests with inheritance and hook guards", () => {
    const effect = createSubEmitterHookEffect();

    expect(collectSubEmitterRequests(effect)).toEqual(
      collectSubEmitterRequests(effect),
    );
    expect(collectSubEmitterRequests(effect)).toEqual([
      {
        hook: "birth",
        effectFile: "birth-spark.json",
        normalizedAge: 0,
        inheritedColor: [1, 0, 0, 1],
        inheritedSize: 0.5,
        depth: 0,
        nextDepth: 1,
        maxDepth: 4,
      },
      {
        hook: "collision",
        effectFile: "impact-spark.json",
        normalizedAge: 0.75,
        inheritedColor: null,
        inheritedSize: null,
        depth: 0,
        nextDepth: 1,
        maxDepth: 4,
      },
      {
        hook: "death",
        effectFile: "death-spark.json",
        normalizedAge: 1,
        inheritedColor: [0, 0, 1, 0.5],
        inheritedSize: null,
        depth: 0,
        nextDepth: 1,
        maxDepth: 4,
      },
    ]);

    const cappedRunner = new ParticleEffectRunner(effect, {
      maxSubEmitterRequestsPerFrame: 0,
    });
    cappedRunner.reset(effect, [0, 0, 0], 0, 0x1234);
    cappedRunner.update(0.01, 0.01);
    expect(cappedRunner.subEmitterRequests).toEqual([]);

    const deepRunner = new ParticleEffectRunner(effect, {
      subEmitterDepth: 4,
      maxSubEmitterDepth: 4,
    });
    deepRunner.reset(effect, [0, 0, 0], 0, 0x1234);
    deepRunner.update(0.01, 0.01);
    expect(deepRunner.subEmitterRequests).toEqual([]);
  });
});

describe("particle scalar multiplier and x-axis", () => {
  const curveValue = (
    extra: Partial<{ multiplier: number; xAxis: "lifetime" | "loopAge" }>,
  ) =>
    normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: 0, slope: 0 },
          { x: 1, y: 1, slope: 0 },
        ],
        ...extra,
      },
      0,
      0,
      1,
    );

  it("omits multiplier and xAxis when they are at their defaults", () => {
    const value = curveValue({});
    expect(value.multiplier).toBeUndefined();
    expect(value.xAxis).toBeUndefined();
  });

  it("preserves multiplier and xAxis only when non-default", () => {
    const value = curveValue({ multiplier: 2, xAxis: "loopAge" });
    expect(value.multiplier).toBe(2);
    expect(value.xAxis).toBe("loopAge");
    // A multiplier of exactly 1 and lifetime axis collapse back to defaults.
    const reset = normalizeParticleScalarValue(
      { ...value, multiplier: 1, xAxis: "lifetime" },
      0,
      0,
      1,
    );
    expect(reset.multiplier).toBeUndefined();
    expect(reset.xAxis).toBeUndefined();
  });

  it("scales the sampled curve output by the multiplier", () => {
    const plain = curveValue({});
    const doubled = curveValue({ multiplier: 2 });
    expect(sampleParticleScalarValue(plain, 0.5, 0)).toBeCloseTo(0.5, 5);
    expect(sampleParticleScalarValue(doubled, 0.5, 0)).toBeCloseTo(1, 5);
    expect(sampleParticleScalarValue(doubled, 1, 0)).toBeCloseTo(2, 5);
  });

  it("normalizes saved curve magnitudes into the multiplier without changing sampled output", () => {
    const rawCurve = [
      { x: 0, y: 4, slope: 0 },
      { x: 1, y: 12, slope: 0 },
    ];
    const before = sampleParticleCurve(rawCurve, 0.5);
    const value = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: rawCurve,
        editorMin: 0,
        editorMax: 24,
      },
      0,
      0,
      24,
    );
    expect(value.editorMin).toBe(0);
    expect(value.editorMax).toBe(1);
    expect(value.multiplier).toBeCloseTo(12);
    expect(Math.max(...value.curve.map((point) => point.y))).toBeCloseTo(1);
    expect(sampleParticleScalarValue(value, 0.5, 0)).toBeCloseTo(before, 5);

    const again = normalizeParticleScalarValue(value, value.value, 0, 24);
    expect(again.multiplier).toBeCloseTo(value.multiplier!);
    expect(sampleParticleScalarValue(again, 0.5, 0)).toBeCloseTo(before, 5);
  });

  it("preserves manually lowered curve floors during magnitude normalization", () => {
    const value = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: 0 },
          { x: 1, y: 12 },
        ],
        editorMin: -24,
        editorMax: 24,
      },
      0,
      0,
      24,
    );

    expect(value.multiplier).toBeCloseTo(12);
    expect(value.editorMin).toBeCloseTo(-2);
    expect(value.editorMax).toBe(1);

    const again = normalizeParticleScalarValue(value, value.value, 0, 24);
    expect(again.editorMin).toBeCloseTo(value.editorMin);
    expect(again.multiplier).toBeCloseTo(value.multiplier!);
  });

  it("keeps legacy curve floors byte-equivalent when no lower floor is authored", () => {
    const positive = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: 4 },
          { x: 1, y: 12 },
        ],
        editorMin: 0,
        editorMax: 24,
      },
      0,
      0,
      24,
    );
    const mixed = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: -2 },
          { x: 1, y: 4 },
        ],
        editorMin: -1,
        editorMax: 4,
      },
      0,
      -1,
      4,
    );

    expect(positive.editorMin).toBe(0);
    expect(mixed.editorMin).toBe(-1);
  });

  it("does not invent negative floors for legacy positive curves on negative-min fields", () => {
    const positiveRotation = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: 0 },
          { x: 1, y: Math.PI },
        ],
      },
      0,
      -Math.PI * 2,
      Math.PI * 2,
    );

    expect(positiveRotation.editorMin).toBe(0);
    expect(positiveRotation.editorMax).toBe(1);
    expect(positiveRotation.multiplier).toBeCloseTo(Math.PI);
  });

  it("normalizes randomCurve magnitudes without double-multiplying an existing multiplier", () => {
    const curveA = [
      { x: 0, y: 4 },
      { x: 1, y: 8 },
    ];
    const curveB = [
      { x: 0, y: 10 },
      { x: 1, y: 12 },
    ];
    const rawA = sampleParticleCurve(curveA, 0.25);
    const rawB = sampleParticleCurve(curveB, 0.25);
    const before = (rawA + (rawB - rawA) * 0.25) * 2;
    const value = normalizeParticleScalarValue(
      {
        mode: "randomCurve",
        curve: curveA,
        curveB,
        multiplier: 2,
        editorMin: 0,
        editorMax: 24,
      },
      0,
      0,
      24,
    );
    expect(value.editorMax).toBe(1);
    expect(value.multiplier).toBeCloseTo(24);
    expect(sampleParticleScalarValue(value, 0.25, 0.25)).toBeCloseTo(before, 5);

    const again = normalizeParticleScalarValue(value, value.value, 0, 24);
    expect(again.multiplier).toBeCloseTo(24);
    expect(sampleParticleScalarValue(again, 0.25, 0.25)).toBeCloseTo(before, 5);
  });

  it("normalizes saved emitter curves through the effect normalization path", () => {
    const rawCurve = [
      { x: 0, y: 50 },
      { x: 1, y: 100 },
    ];
    const before = sampleParticleCurve(rawCurve, 0.75);
    const effect = normalizeParticleEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "curve-migration",
      emitters: [
        {
          id: "curve-emitter",
          spawn: {
            rateValue: {
              mode: "curve",
              curve: rawCurve,
              editorMin: 0,
              editorMax: 3000,
            },
          },
        },
      ],
    });
    const value = effect.emitters[0]!.spawn.rateValue;
    expect(value.editorMax).toBe(1);
    expect(value.multiplier).toBeCloseTo(100);
    expect(sampleParticleScalarValue(value, 0.75, 0)).toBeCloseTo(before, 5);
  });

  it("samples against loop age when xAxis is loopAge and a loop value is supplied", () => {
    const lifetime = curveValue({});
    const loop = curveValue({ xAxis: "loopAge" });
    // Lifetime curve ignores the 4th arg; the loopAge curve samples at the loop
    // position (0.75) instead of the lifetime position (0.25).
    expect(sampleParticleScalarValue(lifetime, 0.25, 0, 0.75)).toBeCloseTo(
      sampleParticleScalarValue(lifetime, 0.25, 0),
      5,
    );
    expect(sampleParticleScalarValue(loop, 0.25, 0, 0.75)).toBeCloseTo(
      sampleParticleScalarValue(lifetime, 0.75, 0),
      5,
    );
    // Without a loop value, a loopAge curve falls back to the lifetime axis.
    expect(sampleParticleScalarValue(loop, 0.25, 0)).toBeCloseTo(
      sampleParticleScalarValue(lifetime, 0.25, 0),
      5,
    );
  });

  it("leaves constant values unaffected by the multiplier", () => {
    const value = normalizeParticleScalarValue(
      { mode: "constant", value: 5, multiplier: 3 },
      0,
      0,
      10,
    );
    expect(sampleParticleScalarValue(value, 0.5, 0)).toBe(5);
  });

  it("does not re-fold a canonically folded curve during editing (editorMax===1)", () => {
    // A folded negative field (editorMax===1 + a magnitude multiplier) is the
    // canonical shape the auto-fold produces. Dragging point [1] down to the
    // floor must leave the range, the multiplier, and the untouched point [0]
    // fixed. The pre-fix fold re-derived them to editorMin:-1, multiplier:16 and
    // slid the untouched point from y:0.5 to y:0.125.
    const dragged = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: 0.5, slope: 0 },
          { x: 1, y: -4, slope: 0 },
        ],
        editorMin: -4,
        editorMax: 1,
        multiplier: 4,
      },
      0,
      -4,
      1,
    );
    expect(dragged.editorMin).toBe(-4);
    expect(dragged.editorMax).toBe(1);
    expect(dragged.multiplier).toBe(4);
    expect(dragged.curve[0]!.y).toBe(0.5);
    expect(dragged.curve[1]!.y).toBe(-4);
  });

  it("does not flip multiplier sign for an all-negative folded curve", () => {
    // All-non-positive points took the divisor=-1 branch pre-fix, flipping the
    // stored multiplier to -4 and inverting the graph (ceiling below floor).
    const dragged = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: -0.25, slope: 0 },
          { x: 1, y: -1, slope: 0 },
        ],
        editorMin: -4,
        editorMax: 1,
        multiplier: 4,
      },
      0,
      -4,
      1,
    );
    expect(dragged.multiplier).toBe(4);
    const ceiling = dragged.editorMax * (dragged.multiplier ?? 1);
    const floor = dragged.editorMin * (dragged.multiplier ?? 1);
    expect(ceiling).toBeGreaterThan(floor);
  });

  it("still folds legacy un-folded curves on load (editorMax!==1)", () => {
    const value = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: 4, slope: 0 },
          { x: 1, y: 12, slope: 0 },
        ],
        editorMin: 0,
        editorMax: 24,
      },
      0,
      0,
      24,
    );
    expect(value.editorMax).toBe(1);
    expect(value.multiplier).toBeCloseTo(12);
    expect(Math.max(...value.curve.map((point) => point.y))).toBeCloseTo(1);
  });

  it("folded negative curve is stable across a serialize round-trip", () => {
    const authored = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: -0.25, slope: 0 },
          { x: 1, y: -1, slope: 0 },
        ],
        editorMin: -4,
        editorMax: 1,
        multiplier: 4,
      },
      0,
      -4,
      1,
    );
    const reloaded = normalizeParticleScalarValue(
      JSON.parse(JSON.stringify(authored)),
      authored.value,
      -4,
      1,
    );
    // The stored (upright) magnitude survives a reload unchanged; pre-fix the
    // load-path fold inverted the multiplier to -4.
    expect(authored.multiplier).toBe(4);
    expect(reloaded.multiplier).toBe(4);
    expect(reloaded.editorMin).toBe(-4);
    expect(reloaded.editorMax).toBe(1);
    expect(reloaded.curve).toEqual(authored.curve);
  });

  it("folded editorMax===1 curve preserves sampled output when re-normalized", () => {
    // Runtime output is curve × multiplier and is invariant under the fold, so
    // skipping it must sample identically to the raw curve scaled by the stored
    // multiplier (which is also what the pre-fix fold produced).
    const raw = {
      mode: "curve" as const,
      curve: [
        { x: 0, y: 0.5, slope: 0 },
        { x: 1, y: -4, slope: 0 },
      ],
      editorMin: -4,
      editorMax: 1,
      multiplier: 4,
    };
    const normalized = normalizeParticleScalarValue(raw, 0, -4, 1);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(sampleParticleScalarValue(normalized, t, 0)).toBeCloseTo(
        sampleParticleCurve(raw.curve, t) * raw.multiplier,
        6,
      );
    }
  });

  it("explicit multiplier:1 with a wide negative range is left un-folded (unchanged)", () => {
    // multiplier:1 short-circuits the fold entirely (hasExplicitUnitMultiplier),
    // independent of the editorMax gate; the range and points pass through.
    const value = normalizeParticleScalarValue(
      {
        mode: "curve",
        curve: [
          { x: 0, y: -2, slope: 0 },
          { x: 1, y: 4, slope: 0 },
        ],
        editorMin: -6,
        editorMax: 6,
        multiplier: 1,
      },
      0,
      -6,
      6,
    );
    expect(value.multiplier).toBeUndefined();
    expect(value.editorMin).toBe(-6);
    expect(value.editorMax).toBe(6);
    expect(value.curve[0]!.y).toBe(-2);
    expect(value.curve[1]!.y).toBe(4);
  });
});

function createSubEmitterHookEffect(): ParticleEffectDefinition {
  return normalizeParticleEffect({
    id: "sub-emitter-hook-effect",
    emitters: [
      {
        id: "sub-emitter-hook",
        maxParticles: 2,
        duration: 1,
        loop: false,
        modules: {
          velocity: true,
          color: true,
          size: true,
          collision: true,
          subEmitters: true,
        },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
          position: [0, 1, 0],
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 0.4 },
          velocity: {
            mode: "vector",
            min: [0, -4, 0],
            max: [0, -4, 0],
            speed: { mode: "constant", value: 0 },
          },
        },
        forces: {
          gravity: 0,
          gravityValue: { mode: "constant", value: 0 },
          drag: 0,
          dragValue: { mode: "constant", value: 0 },
        },
        billboard: {
          sizeValue: { mode: "constant", value: 0.5 },
        },
        color: {
          gradient: {
            mode: "blend",
            colorStops: [
              { position: 0, color: [1, 0, 0] },
              { position: 1, color: [0, 0, 1] },
            ],
            alphaStops: [
              { position: 0, alpha: 1 },
              { position: 1, alpha: 0.5 },
            ],
          },
        },
        advanced: {
          collision: {
            mode: "plane",
            planeY: 0,
            radius: 0,
          },
          subEmitters: {
            birth: {
              effectFile: "birth-spark.json",
              probability: 1,
              inheritColor: true,
              inheritSize: true,
            },
            collision: {
              effectFile: "impact-spark.json",
              probability: 1,
              inheritColor: false,
              inheritSize: false,
            },
            death: {
              effectFile: "death-spark.json",
              probability: 1,
              inheritColor: true,
              inheritSize: false,
            },
          },
        },
      },
    ],
  });
}

function collectSubEmitterRequests(
  effect: ParticleEffectDefinition,
): unknown[] {
  const runner = new ParticleEffectRunner(effect);
  const requests: unknown[] = [];

  runner.reset(effect, [0, 0, 0], 0, 0x1234);
  runner.update(0.01, 0.01);
  requests.push(...runner.subEmitterRequests.map(summarizeSubEmitterRequest));

  runner.update(0.3, 0.31);
  requests.push(...runner.subEmitterRequests.map(summarizeSubEmitterRequest));

  runner.update(0.2, 0.51);
  requests.push(...runner.subEmitterRequests.map(summarizeSubEmitterRequest));

  return requests;
}

function summarizeSubEmitterRequest(
  request: ParticleEffectRunner["subEmitterRequests"][number],
): unknown {
  return {
    hook: request.hook,
    effectFile: request.effectFile,
    normalizedAge: Number(request.normalizedAge.toFixed(3)),
    inheritedColor: request.inheritedColor
      ? request.inheritedColor.map((value) => Number(value.toFixed(3)))
      : null,
    inheritedSize:
      request.inheritedSize === null
        ? null
        : Number(request.inheritedSize.toFixed(3)),
    depth: request.depth,
    nextDepth: request.nextDepth,
    maxDepth: request.maxDepth,
  };
}

function createSpaceRunner(space: "local" | "world"): ParticleEffectRunner {
  const effect = normalizeParticleEffect({
    id: `${space}-space-effect`,
    emitters: [
      {
        id: `${space}-space-emitter`,
        maxParticles: 2,
        modules: { velocity: false },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
          position: [1, 0, 0],
          simulationSpace: space,
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          velocity: {
            mode: "shapeDirection",
            speed: { mode: "constant", value: 0 },
          },
        },
      },
    ],
  });
  const runner = new ParticleEffectRunner(effect);

  runner.reset(effect, [0, 0, 0], 0);
  runner.update(0.01, 0.01);
  return runner;
}

function createVelocityModeRunner(velocity: unknown): ParticleEffectRunner {
  const effect = normalizeParticleEffect({
    id: "init-velocity-effect",
    emitters: [
      {
        id: "init-velocity-emitter",
        maxParticles: 2,
        duration: 10,
        loop: false,
        modules: { velocity: false, rotation: false },
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
          velocity,
        },
      },
    ],
  });
  const runner = new ParticleEffectRunner(effect);
  runner.reset(effect, [0, 0, 0], 0, 0xabcdef01);
  runner.update(0.01, 0.01);
  return runner;
}

function sampleSpawnSidecar(shape: "point" | "circle" | "box" | "cone"): {
  local: number[];
  direction: number[];
} {
  const effect = normalizeParticleEffect({
    id: `${shape}-shape-effect`,
    emitters: [
      {
        id: `${shape}-shape-emitter`,
        maxParticles: 2,
        modules: { velocity: false },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape,
          radius: shape === "cone" ? 2 : 1,
          radiusValue: { mode: "constant", value: shape === "cone" ? 2 : 1 },
          radiusThickness: 0,
          box: [2, 4, 6],
          angle: 30,
          arc: 0,
          arcMode: "burstSpread",
          length: 4,
          emitFrom: "base",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          velocity: {
            mode: "shapeDirection",
            speed: { mode: "constant", value: 0 },
          },
        },
      },
    ],
  });
  const runner = new ParticleEffectRunner(effect);

  runner.reset(effect, [0, 0, 0], 0, 0xabcdef01);
  runner.update(0.01, 0.01);

  const state = runner.states[0]!;
  const localOffset = 0;
  return {
    local: Array.from(
      state.spawnLocalPositionData.subarray(
        localOffset,
        localOffset + PARTICLE_RUNTIME_VECTOR_STRIDE,
      ),
      (value) => Number(value.toFixed(6)),
    ),
    direction: Array.from(
      state.spawnDirectionData.subarray(
        localOffset,
        localOffset + PARTICLE_RUNTIME_VECTOR_STRIDE,
      ),
      (value) => Number(value.toFixed(6)),
    ),
  };
}

function sampleShapePositions(
  shape: "sphere" | "hemisphere",
  count: number,
  radiusThickness: number,
  radius: number,
): number[][] {
  const effect = normalizeParticleEffect({
    id: `${shape}-positions-effect`,
    emitters: [
      {
        id: `${shape}-positions-emitter`,
        maxParticles: count,
        modules: { velocity: false },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: count, cycles: 1, interval: 0, probability: 1 },
          ],
          shape,
          radius,
          radiusValue: { mode: "constant", value: radius },
          radiusThickness,
          arc: 360,
          arcMode: "random",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          velocity: {
            mode: "shapeDirection",
            speed: { mode: "constant", value: 0 },
          },
        },
      },
    ],
  });
  const runner = new ParticleEffectRunner(effect);
  runner.reset(effect, [0, 0, 0], 0, 0xabcdef01);
  runner.update(0.01, 0.01);

  const state = runner.states[0]!;
  const positions: number[][] = [];
  for (let index = 0; index < state.activeCount; index++) {
    const offset = index * PARTICLE_RUNTIME_VECTOR_STRIDE;
    positions.push([
      state.spawnLocalPositionData[offset] ?? 0,
      state.spawnLocalPositionData[offset + 1] ?? 0,
      state.spawnLocalPositionData[offset + 2] ?? 0,
    ]);
  }
  return positions;
}

function sampleCircleArcSidecar(
  arcMode: "loop" | "pingPong",
  arcSpeed: number,
  timeSeconds: number,
): number[] {
  const effect = normalizeParticleEffect({
    id: `${arcMode}-arc-effect`,
    emitters: [
      {
        id: `${arcMode}-arc-emitter`,
        maxParticles: 2,
        duration: 1,
        loop: false,
        modules: { velocity: false },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "circle",
          radius: 1,
          radiusValue: { mode: "constant", value: 1 },
          radiusThickness: 0,
          arc: 360,
          arcMode,
          arcSpeedValue: { mode: "constant", value: arcSpeed },
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          velocity: {
            mode: "shapeDirection",
            speed: { mode: "constant", value: 0 },
          },
        },
      },
    ],
  });
  const runner = new ParticleEffectRunner(effect);

  runner.reset(effect, [0, 0, 0], 0, 0xabcdef01);
  runner.update(timeSeconds, timeSeconds);

  const state = runner.states[0]!;
  return [
    Number((state.spawnLocalPositionData[0] ?? 0).toFixed(6)),
    Number((state.spawnLocalPositionData[2] ?? 0).toFixed(6)),
  ];
}

function createDeterministicStressEffect(): ParticleEffectDefinition {
  return normalizeParticleEffect({
    id: "deterministic-stress-effect",
    emitters: [
      {
        id: "deterministic-stress-emitter",
        maxParticles: 96,
        duration: 2,
        loop: true,
        modules: {
          velocity: true,
          rotation: true,
          inheritVelocity: true,
          limitVelocityOverLifetime: true,
          lifetimeByEmitterSpeed: true,
        },
        spawn: {
          rate: 120,
          rateValue: {
            mode: "curve",
            curve: [
              { x: 0, y: 90 },
              { x: 0.5, y: 150 },
              { x: 1, y: 110 },
            ],
          },
          bursts: [
            { time: 0, count: 12, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "cone",
          radius: 0.6,
          radiusValue: {
            mode: "randomCurve",
            curve: [
              { x: 0, y: 0.4 },
              { x: 1, y: 0.8 },
            ],
            curveB: [
              { x: 0, y: 0.7 },
              { x: 1, y: 1.1 },
            ],
          },
          angle: 35,
          length: 1.8,
          emitFrom: "volume",
          arc: 270,
          arcMode: "burstSpread",
          randomDirectionAmount: 0.35,
          sphericalDirectionAmount: 0.45,
          randomPositionAmount: 0.12,
          rotation: [12, 25, 35],
          scale: [1.2, 0.9, 1],
        },
        initializeParticle: {
          lifetime: {
            mode: "randomCurve",
            curve: [
              { x: 0, y: 0.7 },
              { x: 1, y: 1.1 },
            ],
            curveB: [
              { x: 0, y: 1.2 },
              { x: 1, y: 1.7 },
            ],
          },
          rotation: { mode: "random", min: -6.28318, max: 6.28318 },
          angularVelocity: { mode: "random", min: -14, max: 14 },
          velocity: {
            mode: "vector",
            min: [-1, 1.5, -1],
            max: [1, 3.5, 1],
            speed: { mode: "random", min: 1, max: 4 },
          },
        },
        advanced: {
          inheritVelocity: {
            mode: "initial",
            multiplier: {
              mode: "curve",
              curve: [
                { x: 0, y: 0.4 },
                { x: 1, y: 0.15 },
              ],
            },
          },
          limitVelocityOverLifetime: {
            separateAxes: false,
            speed: {
              mode: "curve",
              curve: [
                { x: 0, y: 4 },
                { x: 1, y: 7 },
              ],
            },
            dampen: 0.35,
            drag: { mode: "constant", value: 0.4 },
            multiplyBySize: false,
          },
          lifetimeByEmitterSpeed: {
            speedRange: { min: 0, max: 8 },
            multiplier: {
              mode: "curve",
              curve: [
                { x: 0, y: 1.2 },
                { x: 1, y: 0.75 },
              ],
            },
          },
        },
      },
    ],
  });
}

function runStressSnapshot(effect: ParticleEffectDefinition): unknown {
  const runner = new ParticleEffectRunner(effect);

  runner.reset(effect, [0, 0, 0], 0, 0x12345678);
  for (let frame = 1; frame <= 18; frame++) {
    const timeSeconds = frame / 30;
    runner.setPosition([
      Math.sin(timeSeconds * 1.7) * 0.5,
      timeSeconds * 0.1,
      Math.cos(timeSeconds * 1.3) * 0.35,
    ]);
    runner.update(1 / 30, timeSeconds);
  }

  const state = runner.states[0]!;
  const liveData = state.instanceData.subarray(
    0,
    state.activeCount * PARTICLE_INSTANCE_STRIDE,
  );
  expect(runner.stats.activeParticles).toBeGreaterThan(0);
  expect(runner.stats.capacity).toBe(96);

  return {
    activeParticles: runner.stats.activeParticles,
    emittedLastFrame: runner.stats.emittedLastFrame,
    data: Array.from(liveData, (value) => Number(value.toFixed(6))),
  };
}

const constant = (value: number): { mode: "constant"; value: number } => ({
  mode: "constant",
  value,
});

const linearCurve = (
  start: number,
  end: number,
): {
  mode: "curve";
  curve: { x: number; y: number; slope: number }[];
} => ({
  mode: "curve",
  curve: [
    { x: 0, y: start, slope: end - start },
    { x: 1, y: end, slope: end - start },
  ],
});

type ScalarTestValue =
  ReturnType<typeof constant> | ReturnType<typeof linearCurve>;

interface VolEffectOptions {
  space?: "local" | "world";
  spawnPosition?: [number, number, number];
  startSpeed?: number;
  linear?: { x?: number; y?: number; z?: number };
  orbital?: { x?: number; y?: number; z?: number };
  orbitalOffset?: { x?: number; y?: number; z?: number };
  radial?: number;
  speedModifier?: number | ScalarTestValue;
}

function createVelocityOverLifetimeEffect(
  options: VolEffectOptions = {},
): ParticleEffectDefinition {
  const lin = options.linear ?? {};
  const orb = options.orbital ?? {};
  const off = options.orbitalOffset ?? {};
  const speedModifier =
    typeof options.speedModifier === "number"
      ? constant(options.speedModifier)
      : (options.speedModifier ?? constant(1));
  return normalizeParticleEffect({
    id: "vol-effect",
    emitters: [
      {
        id: "vol-emitter",
        maxParticles: 2,
        duration: 10,
        loop: false,
        // velocity module OFF so gravity/drag never perturb the analytic math.
        modules: {
          velocity: false,
          rotation: false,
          velocityOverLifetime: true,
        },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
          position: options.spawnPosition ?? [0, 0, 0],
          simulationSpace: "world",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 10 },
          velocity: {
            mode: "shapeDirection",
            speed: { mode: "constant", value: options.startSpeed ?? 0 },
          },
        },
        advanced: {
          velocityOverLifetime: {
            space: options.space ?? "local",
            linear: {
              x: constant(lin.x ?? 0),
              y: constant(lin.y ?? 0),
              z: constant(lin.z ?? 0),
            },
            orbital: {
              x: constant(orb.x ?? 0),
              y: constant(orb.y ?? 0),
              z: constant(orb.z ?? 0),
            },
            orbitalOffset: {
              x: constant(off.x ?? 0),
              y: constant(off.y ?? 0),
              z: constant(off.z ?? 0),
            },
            radial: constant(options.radial ?? 0),
            speedModifier,
          },
        },
      },
    ],
  });
}

function spawnVolRunner(
  effect: ParticleEffectDefinition,
  emitterPosition: [number, number, number] = [0, 0, 0],
): ParticleEffectRunner {
  const runner = new ParticleEffectRunner(effect);
  runner.reset(effect, emitterPosition, 0, 0xabcdef01);
  runner.update(0.001, 0.001);
  return runner;
}

describe("velocity over lifetime", () => {
  it("constant speed modifier 1 leaves start-speed motion unchanged", () => {
    const effect = createVelocityOverLifetimeEffect({
      space: "world",
      startSpeed: 10,
      speedModifier: 1,
    });
    const runner = spawnVolRunner(effect);
    const emitter = runner.definition.emitters[0]!;
    const state = runner.states[0]!;
    const motion = sampleParticleMotion(emitter, state, 0, 2, 0.2, [0, 0, 0]);

    expect(motion.position[1]).toBeCloseTo(20, 5);
    expect(motion.velocity[1]).toBeCloseTo(10, 5);
  });

  it("integrates speed modifier curves so start-speed particles freeze instead of snapping back", () => {
    const effect = createVelocityOverLifetimeEffect({
      space: "world",
      startSpeed: 10,
      speedModifier: linearCurve(1, 0),
    });
    const runner = spawnVolRunner(effect);
    const emitter = runner.definition.emitters[0]!;
    const state = runner.states[0]!;
    const endMotion = sampleParticleMotion(emitter, state, 0, 10, 1, [0, 0, 0]);

    expect(endMotion.position[1]).toBeCloseTo(50, 5);
    expect(endMotion.velocity[1]).toBeCloseTo(0, 5);
  });

  it("speed modifier scales start-speed distance and velocity above 1", () => {
    const effect = createVelocityOverLifetimeEffect({
      space: "world",
      startSpeed: 10,
      speedModifier: 2,
    });
    const runner = spawnVolRunner(effect);
    const emitter = runner.definition.emitters[0]!;
    const state = runner.states[0]!;
    const motion = sampleParticleMotion(emitter, state, 0, 2, 0.2, [0, 0, 0]);

    expect(motion.position[1]).toBeCloseTo(40, 5);
    expect(motion.velocity[1]).toBeCloseTo(20, 5);
  });

  it("linear X moves the particle in +X proportional to age", () => {
    const effect = createVelocityOverLifetimeEffect({
      space: "world",
      linear: { x: 5 },
    });
    const runner = spawnVolRunner(effect);
    const emitter = runner.definition.emitters[0]!;
    const state = runner.states[0]!;
    const motion = sampleParticleMotion(emitter, state, 0, 2, 0.2, [0, 0, 0]);
    // position.x grows ~ linear * age; spawn x is 0.
    expect(motion.position[0]).toBeCloseTo(10, 5);
    expect(motion.velocity[0]).toBeCloseTo(5, 5);
  });

  it("radial positive increases distance from center, negative decreases it", () => {
    // Particle spawns at +X (1,0,0), center is the emitter origin (0,0,0).
    const positive = createVelocityOverLifetimeEffect({
      space: "world",
      spawnPosition: [1, 0, 0],
      radial: 3,
    });
    const pr = spawnVolRunner(positive);
    const pe = pr.definition.emitters[0]!;
    const ps = pr.states[0]!;
    const pPos = sampleParticleMotion(pe, ps, 0, 1, 0.1, [0, 0, 0]).position;
    expect(Math.hypot(pPos[0], pPos[1], pPos[2])).toBeGreaterThan(1);
    expect(pPos[0]).toBeCloseTo(4, 5); // 1 + 3*1

    const negative = createVelocityOverLifetimeEffect({
      space: "world",
      spawnPosition: [4, 0, 0],
      radial: -3,
    });
    const nr = spawnVolRunner(negative);
    const ne = nr.definition.emitters[0]!;
    const ns = nr.states[0]!;
    const nPos = sampleParticleMotion(ne, ns, 0, 1, 0.1, [0, 0, 0]).position;
    expect(Math.hypot(nPos[0], nPos[1], nPos[2])).toBeLessThan(4);
    expect(nPos[0]).toBeCloseTo(1, 5); // 4 + (-3)*1
  });

  it("orbital around Z turns +X toward +Y after a quarter turn", () => {
    // wz * age = PI/2 => quarter turn: (1,0,0) -> (0,1,0).
    const effect = createVelocityOverLifetimeEffect({
      space: "world",
      spawnPosition: [1, 0, 0],
      orbital: { z: Math.PI / 2 },
    });
    const runner = spawnVolRunner(effect);
    const emitter = runner.definition.emitters[0]!;
    const state = runner.states[0]!;
    const motion = sampleParticleMotion(emitter, state, 0, 1, 0.1, [0, 0, 0]);
    expect(motion.position[0]).toBeCloseTo(0, 4);
    expect(motion.position[1]).toBeCloseTo(1, 4);
    expect(motion.position[2]).toBeCloseTo(0, 4);
    // Tangential velocity cross(w, rel) = (0,0,wz) x (1,0,0) = (0, wz, 0).
    expect(motion.velocity[1]).toBeCloseTo(Math.PI / 2, 4);
  });

  it("orbital around Y affects X/Z (quarter turn maps +X toward -Z)", () => {
    const effect = createVelocityOverLifetimeEffect({
      space: "world",
      spawnPosition: [1, 0, 0],
      orbital: { y: Math.PI / 2 },
    });
    const runner = spawnVolRunner(effect);
    const emitter = runner.definition.emitters[0]!;
    const state = runner.states[0]!;
    const motion = sampleParticleMotion(emitter, state, 0, 1, 0.1, [0, 0, 0]);
    expect(motion.position[0]).toBeCloseTo(0, 4);
    expect(motion.position[1]).toBeCloseTo(0, 4);
    expect(motion.position[2]).toBeCloseTo(-1, 4);
  });

  it("local space follows the moving emitter as the orbit center; world does not", () => {
    // Particle is 1 unit ahead of the emitter; orbit a quarter turn about Z.
    const makeMotion = (
      space: "local" | "world",
      emitterPos: [number, number, number],
    ): number[] => {
      const effect = createVelocityOverLifetimeEffect({
        space,
        spawnPosition: [1, 0, 0],
        orbital: { z: Math.PI / 2 },
      });
      const runner = spawnVolRunner(effect, emitterPos);
      const emitter = runner.definition.emitters[0]!;
      const state = runner.states[0]!;
      const motion = sampleParticleMotion(
        emitter,
        state,
        0,
        1,
        0.1,
        emitterPos,
      );
      return [motion.position[0], motion.position[1], motion.position[2]];
    };

    // World space: center stays at the spawn origin regardless of emitterPos.
    const worldAtOrigin = makeMotion("world", [0, 0, 0]);
    expect(worldAtOrigin[0]).toBeCloseTo(0, 3);
    expect(worldAtOrigin[1]).toBeCloseTo(1, 3);

    // Local space: center follows the current emitter position. The particle
    // spawned at emitterPos + [1,0,0]; orbiting about emitterPos keeps the
    // radius 1 and lands at emitterPos + (0,1,0).
    const localMoved = makeMotion("local", [10, 0, 0]);
    expect(localMoved[0]).toBeCloseTo(10, 3);
    expect(localMoved[1]).toBeCloseTo(1, 3);
  });

  it("speed modifier scales the entire velocity-over-lifetime contribution", () => {
    const base = createVelocityOverLifetimeEffect({
      space: "world",
      linear: { x: 4 },
      speedModifier: 1,
    });
    const scaled = createVelocityOverLifetimeEffect({
      space: "world",
      linear: { x: 4 },
      speedModifier: 0.5,
    });
    const baseRunner = spawnVolRunner(base);
    const scaledRunner = spawnVolRunner(scaled);
    const basePos = sampleParticleMotion(
      baseRunner.definition.emitters[0]!,
      baseRunner.states[0]!,
      0,
      2,
      0.2,
      [0, 0, 0],
    ).position;
    const scaledPos = sampleParticleMotion(
      scaledRunner.definition.emitters[0]!,
      scaledRunner.states[0]!,
      0,
      2,
      0.2,
      [0, 0, 0],
    ).position;
    expect(basePos[0]).toBeCloseTo(8, 5);
    expect(scaledPos[0]).toBeCloseTo(4, 5);
  });

  it("is deterministic for fixed seeds", () => {
    const effect = createVelocityOverLifetimeEffect({
      space: "local",
      spawnPosition: [1, 0, 0],
      linear: { y: 2 },
      orbital: { z: 1.3 },
      radial: 0.7,
    });
    const snapshot = (): number[] => {
      const runner = spawnVolRunner(effect, [3, 1, -2]);
      const emitter = runner.definition.emitters[0]!;
      const state = runner.states[0]!;
      const out: number[] = [];
      for (const age of [0.25, 0.75, 1.5]) {
        const motion = sampleParticleMotion(
          emitter,
          state,
          0,
          age,
          age / 10,
          [3, 1, -2],
        );
        out.push(
          ...motion.position.map((v) => Number(v.toFixed(6))),
          ...motion.velocity.map((v) => Number(v.toFixed(6))),
        );
      }
      return out;
    };
    expect(snapshot()).toEqual(snapshot());
  });

  it("birth and death events reflect velocity over lifetime", () => {
    // Linear +X over lifetime + triggers so birth/death events fire. Death
    // position must show the particle has moved in +X (events use the same
    // analytic sampler as the renderer).
    const effect = normalizeParticleEffect({
      id: "vol-event-effect",
      emitters: [
        {
          id: "vol-event-emitter",
          maxParticles: 2,
          duration: 10,
          loop: false,
          modules: {
            velocity: false,
            rotation: false,
            velocityOverLifetime: true,
            triggers: true,
          },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
            simulationSpace: "world",
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 0.5 },
            velocity: {
              mode: "shapeDirection",
              speed: { mode: "constant", value: 0 },
            },
          },
          advanced: {
            velocityOverLifetime: {
              space: "world",
              linear: {
                x: { mode: "constant", value: 6 },
                y: { mode: "constant", value: 0 },
                z: { mode: "constant", value: 0 },
              },
            },
            triggers: {
              birthEvent: "birth",
              deathEvent: "death",
              normalizedTime: 1,
              oneShot: true,
            },
          },
        },
      ],
    });
    const runner = new ParticleEffectRunner(effect);
    runner.reset(effect, [0, 0, 0], 0, 0xabcdef01);
    runner.update(0.001, 0.001);
    const birth = runner.events.find((event) => event.kind === "birth");
    expect(birth).toBeDefined();
    expect(birth!.position[0]).toBeCloseTo(0, 3);
    // Step past the particle's lifetime so the death event fires.
    runner.update(0.6, 0.601);
    const death = runner.events.find((event) => event.kind === "death");
    expect(death).toBeDefined();
    // Death at age 0.5 with linear x=6 => x ~ 3.
    expect(death!.position[0]).toBeGreaterThan(2.5);
    expect(death!.velocity[0]).toBeCloseTo(6, 3);
  });
});

describe("curve graph/runtime parity (B6)", () => {
  const sampleSeries = (
    points: { x: number; y: number; slope?: number }[],
    steps = 40,
  ): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= steps; i++) {
      out.push(sampleParticleCurve(points, i / steps));
    }
    return out;
  };

  const isMonotoneNonDecreasing = (series: number[]): boolean =>
    series.every(
      (value, index) => index === 0 || value >= series[index - 1]! - 1e-9,
    );

  it("rise-to-max-and-hold never overshoots above the endpoint", () => {
    // The exact case reported by the VFX team: grow 0 -> 1 then hold at 1.
    // Before the monotone-tangent fix this peaked at ~1.072 then dipped back
    // ("goes up, then DOWN") while the graph drew a flat plateau.
    const points = [
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 1 },
    ];
    const series = sampleSeries(points);
    expect(sampleParticleCurve(points, 0)).toBeCloseTo(0, 6);
    expect(sampleParticleCurve(points, 1)).toBeCloseTo(1, 6);
    expect(Math.max(...series)).toBeLessThanOrEqual(1 + 1e-6);
    expect(isMonotoneNonDecreasing(series)).toBe(true);
  });

  const monotoneCases: {
    name: string;
    points: { x: number; y: number }[];
  }[] = [
    {
      name: "early rise then hold",
      points: [
        { x: 0, y: 0 },
        { x: 0.25, y: 1 },
        { x: 1, y: 1 },
      ],
    },
    {
      name: "late rise then hold",
      points: [
        { x: 0, y: 0 },
        { x: 0.9, y: 1 },
        { x: 1, y: 1 },
      ],
    },
    {
      name: "straight ramp",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    },
    {
      name: "stepped climb",
      points: [
        { x: 0, y: 0.2 },
        { x: 0.3, y: 0.8 },
        { x: 0.7, y: 0.9 },
        { x: 1, y: 1 },
      ],
    },
  ];
  for (const { name, points } of monotoneCases) {
    it(`monotone data stays within its endpoints and never dips: ${name}`, () => {
      const series = sampleSeries(points);
      const lo = Math.min(...points.map((point) => point.y));
      const hi = Math.max(...points.map((point) => point.y));
      expect(Math.min(...series)).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(Math.max(...series)).toBeLessThanOrEqual(hi + 1e-6);
      expect(isMonotoneNonDecreasing(series)).toBe(true);
    });
  }

  it("still lets a genuine hump rise then fall", () => {
    // Non-monotone data is allowed to go up and back down.
    const points = [
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 0 },
    ];
    expect(sampleParticleCurve(points, 0)).toBeCloseTo(0, 6);
    expect(sampleParticleCurve(points, 0.5)).toBeCloseTo(1, 6);
    expect(sampleParticleCurve(points, 1)).toBeCloseTo(0, 6);
    expect(sampleParticleCurve(points, 0.5)).toBeGreaterThan(
      sampleParticleCurve(points, 0.9),
    );
  });

  it("holds the last point's value for x beyond the final key (not zero)", () => {
    // Disproves the team's "last point counts as 0" hypothesis.
    const points = [
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 1 },
    ];
    expect(sampleParticleCurve(points, 1)).toBeCloseTo(1, 6);
    expect(sampleParticleCurve(points, 1.5)).toBeCloseTo(1, 6);
  });

  it("honors explicit per-point tangents over the auto monotone slopes", () => {
    const points = [
      { x: 0, y: 0, slope: 0 },
      { x: 0.5, y: 1, slope: 0 },
      { x: 1, y: 1, slope: 0 },
    ];
    const series = sampleSeries(points);
    expect(Math.max(...series)).toBeLessThanOrEqual(1 + 1e-6);
  });

  it("uses side-specific weighted Bezier handles when authored", () => {
    const legacy = [
      { x: 0, y: 0, slope: 0 },
      { x: 1, y: 1, slope: 0 },
    ];
    const weighted = [
      { x: 0, y: 0, slopeOut: 0, weightOut: 0.8 },
      { x: 1, y: 1, slopeIn: 0, weightIn: 0.08 },
    ];
    const legacyMid = sampleParticleCurve(legacy, 0.5);
    const weightedMid = sampleParticleCurve(weighted, 0.5);
    expect(legacyMid).toBeCloseTo(0.5, 6);
    expect(Math.abs(weightedMid - legacyMid)).toBeGreaterThan(0.05);
  });

  it("round-trips authored per-point tangent handles through normalization (F9)", () => {
    const effect = normalizeParticleEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "tangent-roundtrip",
      emitters: [
        {
          id: "tangent-emitter",
          spawn: {
            rateValue: {
              mode: "curve",
              curve: [
                { x: 0, y: 0, slope: 1.5 },
                { x: 0.5, y: 1, slope: 0 },
                { x: 1, y: 0.5 },
              ],
            },
          },
        },
      ],
    });
    const curve = effect.emitters[0]!.spawn.rateValue.curve;
    expect(curve[0]!.slope).toBeCloseTo(1.5);
    expect(curve[1]!.slope).toBe(0);
    // A point without an authored tangent stays auto (no slope field).
    expect(curve[2]!.slope).toBeUndefined();
  });

  it("round-trips split tangent fields through normalization (FR1)", () => {
    const effect = normalizeParticleEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "split-tangent-roundtrip",
      emitters: [
        {
          id: "split-tangent-emitter",
          spawn: {
            rateValue: {
              mode: "curve",
              curve: [
                { x: 0, y: 0, slopeOut: 2, weightOut: 0.2 },
                {
                  x: 0.5,
                  y: 1,
                  slopeIn: 0.5,
                  slopeOut: -0.25,
                  weightIn: 0.4,
                  weightOut: 0.6,
                },
                { x: 1, y: 0, slopeIn: -1, weightIn: 0.25 },
              ],
            },
          },
        },
      ],
    });
    const curve = effect.emitters[0]!.spawn.rateValue.curve;
    expect(curve[0]!.slopeOut).toBeCloseTo(2);
    expect(curve[0]!.weightOut).toBeCloseTo(0.2);
    expect(curve[1]!.slopeIn).toBeCloseTo(0.5);
    expect(curve[1]!.slopeOut).toBeCloseTo(-0.25);
    expect(curve[1]!.weightIn).toBeCloseTo(0.4);
    expect(curve[1]!.weightOut).toBeCloseTo(0.6);
    expect(curve[2]!.slopeIn).toBeCloseTo(-1);
    expect(curve[2]!.weightIn).toBeCloseTo(0.25);
  });
});
