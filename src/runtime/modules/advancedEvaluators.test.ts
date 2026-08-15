import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Vec3, Vec4 } from "@/engine/math";
import {
  ParticleEffectRunner,
  linearToSrgb,
  normalizeParticleEffect,
  sampleParticleMotion,
  srgbToLinear,
  type ParticleEmitterDefinition,
  type ParticleEmitterRuntimeState,
} from "@/engine/particles";
import {
  applyParticleMotionModules,
  applyPositionalMotionModules,
  computeEffectiveAlignmentVelocity,
  particleRotationBySpeedOffset,
  particleSizeBySpeedMultiplier,
  sampleParticleModuleColor,
  sampleTextureSheetAnimationFrame,
  type ParticleMotionSample,
} from "./advancedEvaluators";

describe("runtime advanced particle module evaluators", () => {
  it("applies force over lifetime and external forces deterministically", () => {
    const emitter = makeEmitter({
      modules: {
        forceOverLifetime: true,
        externalForces: true,
      },
      advanced: {
        forceOverLifetime: {
          force: [2, 4, -2],
          randomized: [0, 0, 0],
          multiplier: { mode: "constant", value: 1 },
        },
        externalForces: {
          wind: [1, 2, 3],
          gravityMultiplier: { mode: "constant", value: 2 },
          drag: { mode: "constant", value: 1 },
          vortexStrength: 0,
        },
      },
    });
    const world: Vec3 = [10, 10, 10];

    const alive = applyParticleMotionModules({
      emitter,
      seed: 0.25,
      normalizedAge: 0.5,
      ageSeconds: 2,
      timeSeconds: 3,
      world,
      velocity: [2, 3, 4],
    });

    expect(alive).toBe(true);
    expect(world[0]).toBeCloseTo(11.2);
    expect(world[1]).toBeCloseTo(16);
    expect(world[2]).toBeCloseTo(8.4);
  });

  it("samples noise as a deterministic pure displacement", () => {
    const emitter = makeEmitter({
      modules: {
        noise: true,
      },
      advanced: {
        noise: {
          strength: { mode: "constant", value: 1 },
          frequency: 1.25,
          speed: 0.5,
          scroll: [1, 0.25, -0.5],
          octaves: 3,
          damping: 0.5,
        },
      },
    });
    const first: Vec3 = [0.2, -0.3, 0.4];
    const second: Vec3 = [0.2, -0.3, 0.4];
    const changedSeed: Vec3 = [0.2, -0.3, 0.4];

    applyParticleMotionModules({
      emitter,
      seed: 0.42,
      normalizedAge: 0.4,
      ageSeconds: 0.8,
      timeSeconds: 1.5,
      world: first,
      velocity: [0, 0, 0],
    });
    applyParticleMotionModules({
      emitter,
      seed: 0.42,
      normalizedAge: 0.4,
      ageSeconds: 0.8,
      timeSeconds: 1.5,
      world: second,
      velocity: [0, 0, 0],
    });
    applyParticleMotionModules({
      emitter,
      seed: 0.84,
      normalizedAge: 0.4,
      ageSeconds: 0.8,
      timeSeconds: 1.5,
      world: changedSeed,
      velocity: [0, 0, 0],
    });

    expect(first).toEqual(second);
    expect(first).not.toEqual([0.2, -0.3, 0.4]);
    expect(changedSeed).not.toEqual(first);
  });

  it("ramps noise displacement from zero at particle spawn", () => {
    const emitter = makeEmitter({
      modules: {
        noise: true,
      },
      advanced: {
        noise: {
          strength: { mode: "constant", value: 1 },
          frequency: 1.25,
          speed: 0.5,
          scroll: [1, 0.25, -0.5],
          octaves: 3,
          damping: 0.5,
        },
      },
    });

    const spawn: Vec3 = [0.2, -0.3, 0.4];
    applyParticleMotionModules({
      emitter,
      seed: 0.42,
      normalizedAge: 0,
      ageSeconds: 0,
      timeSeconds: 1.5,
      world: spawn,
      velocity: [0, 0, 0],
    });
    // (a) exactly zero displacement at normalizedAge 0, even with strength > 0.
    expect(spawn).toEqual([0.2, -0.3, 0.4]);

    // (b) at normalizedAge >= 0.1 the displacement matches the legacy
    // un-ramped magnitude, derived from the existing 0.4-age determinism test.
    const legacy: Vec3 = [0.2, -0.3, 0.4];
    applyParticleMotionModules({
      emitter,
      seed: 0.42,
      normalizedAge: 0.4,
      ageSeconds: 0.8,
      timeSeconds: 1.5,
      world: legacy,
      velocity: [0, 0, 0],
    });
    const atRampEnd: Vec3 = [0.2, -0.3, 0.4];
    applyParticleMotionModules({
      emitter,
      seed: 0.42,
      normalizedAge: 0.1,
      ageSeconds: 0.2,
      timeSeconds: 1.5,
      world: atRampEnd,
      velocity: [0, 0, 0],
    });
    const legacyDisplacement: Vec3 = [
      legacy[0] - 0.2,
      legacy[1] - -0.3,
      legacy[2] - 0.4,
    ];
    const atRampEndDisplacement: Vec3 = [
      atRampEnd[0] - 0.2,
      atRampEnd[1] - -0.3,
      atRampEnd[2] - 0.4,
    ];
    // normalizedAge only affects world[]-independent terms (phase depends on
    // timeSeconds, not normalizedAge), so displacement is identical at 0.1 and 0.4.
    expect(atRampEndDisplacement).toEqual(legacyDisplacement);

    // (c) the ramp is monotonically increasing on [0, 0.1].
    const samples = [0, 0.025, 0.05, 0.075, 0.1];
    const magnitudes = samples.map((normalizedAge) => {
      const world: Vec3 = [0.2, -0.3, 0.4];
      applyParticleMotionModules({
        emitter,
        seed: 0.42,
        normalizedAge,
        ageSeconds: normalizedAge,
        timeSeconds: 1.5,
        world,
        velocity: [0, 0, 0],
      });
      return Math.hypot(world[0] - 0.2, world[1] - -0.3, world[2] - 0.4);
    });
    for (let i = 1; i < magnitudes.length; i++) {
      expect(magnitudes[i]).toBeGreaterThan(magnitudes[i - 1]);
    }
  });

  it("evaluates color, size, and rotation by speed without editor state", () => {
    const emitter = makeEmitter({
      modules: {
        color: false,
        colorBySpeed: true,
        sizeBySpeed: true,
        rotationBySpeed: true,
      },
      advanced: {
        colorBySpeed: {
          speedRange: { min: 0, max: 10 },
          gradient: {
            mode: "blend",
            colorStops: [
              { position: 0, color: [1, 0, 0] },
              { position: 1, color: [0, 0, 1] },
            ],
            alphaStops: [
              { position: 0, alpha: 0.25 },
              { position: 1, alpha: 1 },
            ],
          },
          blend: 0.5,
        },
        sizeBySpeed: {
          speedRange: { min: 0, max: 10 },
          multiplier: { mode: "constant", value: 3 },
          blend: 0.25,
        },
        rotationBySpeed: {
          speedRange: { min: 0, max: 10 },
          angularVelocity: { mode: "constant", value: 2 },
          blend: 0.5,
        },
      },
    });
    const baseColor: Vec4 = [0.2, 0.4, 0.6, 0.8];

    expect(
      sampleParticleModuleColor(emitter, 0.25, 10, 0.5, baseColor),
    ).toEqual([
      linearToSrgb(srgbToLinear(baseColor[0]) * 0.5),
      linearToSrgb(srgbToLinear(baseColor[1]) * 0.5),
      linearToSrgb(srgbToLinear(baseColor[2]) * 0.5 + 0.5),
      0.9,
    ]);
    expect(particleSizeBySpeedMultiplier(emitter, 10, 0.5)).toBeCloseTo(1.5);
    expect(particleRotationBySpeedOffset(emitter, 10, 4, 0.5)).toBeCloseTo(4);
  });

  it("samples texture sheet animation frames without tint fakery", () => {
    const emitter = makeEmitter({
      modules: {
        color: false,
        lights: false,
        customData: false,
        textureSheetAnimation: true,
      },
      advanced: {
        textureSheetAnimation: {
          tiles: [4, 2],
          startFrame: 1,
          frameOverTime: { mode: "constant", value: 3 },
          cycles: 2,
          randomStartFrame: false,
        },
      },
    });

    const frame = sampleTextureSheetAnimationFrame(
      emitter.advanced.textureSheetAnimation,
      0.5,
      0.25,
    );

    expect(frame).toEqual({
      frame: 7,
      column: 3,
      row: 1,
      tilesX: 4,
      tilesY: 2,
      totalFrames: 8,
    });
    expect(sampleParticleModuleColor(emitter, 0.5, 0, 0.25)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it("loops within an inclusive [startFrame, endFrame] sub-range", () => {
    const sampleFrame = (frameOverTime: number) =>
      sampleTextureSheetAnimationFrame(
        makeEmitter({
          modules: { textureSheetAnimation: true },
          advanced: {
            textureSheetAnimation: {
              tiles: [4, 4],
              startFrame: 0,
              endFrame: 8,
              frameOverTime: { mode: "constant", value: frameOverTime },
              cycles: 1,
              randomStartFrame: false,
            },
          },
        }).advanced.textureSheetAnimation,
        0.5,
        0.25,
      ).frame;

    const visited: number[] = [];
    for (let v = 0; v <= 20; v++) visited.push(sampleFrame(v));
    expect(visited.every((frame) => frame >= 0 && frame <= 8)).toBe(true);
    expect(Math.min(...visited)).toBe(0);
    expect(Math.max(...visited)).toBe(8);
    // one frame past the inclusive end wraps back to the range floor
    expect(sampleFrame(8)).toBe(8);
    expect(sampleFrame(9)).toBe(0);
  });

  it("overshooting cycles never leaks frames above endFrame", () => {
    const sampleFrame = (frameOverTime: number) =>
      sampleTextureSheetAnimationFrame(
        makeEmitter({
          modules: { textureSheetAnimation: true },
          advanced: {
            textureSheetAnimation: {
              tiles: [4, 4],
              startFrame: 0,
              endFrame: 8,
              frameOverTime: { mode: "constant", value: frameOverTime },
              cycles: 4,
              randomStartFrame: false,
            },
          },
        }).advanced.textureSheetAnimation,
        0.5,
        0.25,
      ).frame;

    // rawFrame sweeps well past totalFrames (16); the old modulo-16 wrap leaked
    // 11..15, the range wrap must not.
    for (let v = 0; v <= 8; v++) {
      expect(sampleFrame(v)).toBeLessThanOrEqual(8);
    }
    // e.g. rawFrame 12 (v=3, cycles 4): old mod-16 gave 12 (leaked); range gives 3.
    expect(sampleFrame(3)).toBe(3);
  });

  it("default endFrame reproduces whole-sheet output byte-for-byte", () => {
    const totalFrames = 16;
    const sampleFrame = (frameOverTime: number, cycles: number) =>
      sampleTextureSheetAnimationFrame(
        makeEmitter({
          modules: { textureSheetAnimation: true },
          advanced: {
            textureSheetAnimation: {
              tiles: [4, 4],
              startFrame: 0,
              endFrame: 255,
              frameOverTime: { mode: "constant", value: frameOverTime },
              cycles,
              randomStartFrame: false,
            },
          },
        }).advanced.textureSheetAnimation,
        0.5,
        0.25,
      ).frame;

    for (const cycles of [1, 2, 8]) {
      for (let v = 0; v <= 40; v++) {
        // pre-I13-G formula: positiveModulo(floor(fot * cycles), totalFrames);
        // fot, cycles >= 0 so positiveModulo collapses to %.
        const expected = Math.floor(v * cycles) % totalFrames;
        expect(sampleFrame(v, cycles)).toBe(expected);
      }
    }
  });

  it("random start draws within the range", () => {
    const settings = makeEmitter({
      modules: { textureSheetAnimation: true },
      advanced: {
        textureSheetAnimation: {
          tiles: [4, 4],
          startFrame: 3,
          endFrame: 6,
          frameOverTime: { mode: "constant", value: 0 },
          cycles: 1,
          randomStartFrame: true,
        },
      },
    }).advanced.textureSheetAnimation;

    for (let i = 0; i < 200; i++) {
      const seed = i / 200;
      const frame = sampleTextureSheetAnimationFrame(settings, 0.5, seed).frame;
      expect(frame).toBeGreaterThanOrEqual(3);
      expect(frame).toBeLessThanOrEqual(6);
    }
  });

  it("draws the random start offset from rangeLen, not totalFrames (D6)", () => {
    // Pins the D6 scoping: startOffset = floor(seeded01(seed,71) * rangeLen).
    // The outer positiveModulo(_, rangeLen) keeps every frame in [3,6] under
    // BOTH the new (* rangeLen) and the reverted (* totalFrames) scoping, so a
    // [3,6] bound alone cannot witness D6. These four seeds each land on a
    // DIFFERENT frame under the two scopings (rangeLen=4 vs totalFrames=16):
    // reverting the sampler to `* totalFrames` makes each expectation fail.
    const settings = makeEmitter({
      modules: { textureSheetAnimation: true },
      advanced: {
        textureSheetAnimation: {
          tiles: [4, 4],
          startFrame: 3,
          endFrame: 6,
          frameOverTime: { mode: "constant", value: 0 },
          cycles: 1,
          randomStartFrame: true,
        },
      },
    }).advanced.textureSheetAnimation;

    // seed -> exact frame under rangeLen scoping (totalFrames scoping in comment)
    const perSeed: Array<[number, number]> = [
      [0, 3], // totalFrames scoping would give 5
      [0.015, 4], // totalFrames scoping would give 3
      [0.02, 5], // totalFrames scoping would give 4
      [0.01, 6], // totalFrames scoping would give 4
    ];
    for (const [seed, expected] of perSeed) {
      expect(sampleTextureSheetAnimationFrame(settings, 0.5, seed).frame).toBe(
        expected,
      );
    }
  });

  it("inverted range collapses to a single frame", () => {
    const settings = makeEmitter({
      modules: { textureSheetAnimation: true },
      advanced: {
        textureSheetAnimation: {
          tiles: [4, 4],
          startFrame: 5,
          endFrame: 3,
          frameOverTime: { mode: "constant", value: 4 },
          cycles: 3,
          randomStartFrame: false,
        },
      },
    }).advanced.textureSheetAnimation;

    for (const age of [0, 0.25, 0.5, 0.75, 1]) {
      const frame = sampleTextureSheetAnimationFrame(settings, age, 0.25).frame;
      expect(frame).toBe(5);
    }
  });

  it("does not tint particle color through Shader Custom Data", () => {
    const emitter = makeEmitter({
      modules: {
        color: false,
        lights: false,
        customData: true,
      },
      advanced: {
        customData: {
          channels: [
            { mode: "constant", value: 0.2 },
            { mode: "constant", value: 0.3 },
            { mode: "constant", value: 0.4 },
            { mode: "constant", value: 0.5 },
          ],
        },
      },
    });

    expect(sampleParticleModuleColor(emitter, 0.5, 0, 0.25)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it("keeps runtime module helpers free of editor imports", async () => {
    const files = await listSourceFiles(
      path.dirname(fileURLToPath(import.meta.url)),
    );
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (
        /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["'](?:@\/editor|(?:\.\.\/)+editor)\//m.test(
          source,
        )
      ) {
        violations.push(path.basename(file));
      }
    }

    expect(violations).toEqual([]);
  });

  describe("collision plane response", () => {
    const G = 9.8;
    // Gravity must be enabled (modules.velocity) so the response can re-sample it
    // to recover the parabola's −2G acceleration (design D7).
    const makeCollisionEmitter = (
      collisionOverrides: Record<string, unknown> = {},
    ): ParticleEmitterDefinition =>
      makeEmitter({
        modules: { velocity: true, collision: true },
        forces: { gravityValue: { mode: "constant", value: G } },
        advanced: {
          collision: {
            mode: "plane",
            planeY: 0,
            radius: 0,
            bounce: 0.35,
            dampen: 0.45,
            killBelow: 20,
            ...collisionOverrides,
          },
        },
      });

    // Drive the module with the RAW analytic parabola the engine emits at age t
    // (y0=5, v0=2, floor=0): the impact happens at t ≈ 0.8236 s.
    const resolveAt = (
      emitter: ParticleEmitterDefinition,
      t: number,
      opts: { x0?: number; z0?: number; vx?: number; vz?: number } = {},
    ): { world: Vec3; velocity: Vec3; alive: boolean } => {
      const y0 = 5;
      const v0 = 2;
      const world: Vec3 = [opts.x0 ?? 0, y0 + v0 * t - G * t * t, opts.z0 ?? 0];
      const velocity: Vec3 = [opts.vx ?? 0, v0 - 2 * G * t, opts.vz ?? 0];
      const alive = applyParticleMotionModules({
        emitter,
        seed: 0.5,
        normalizedAge: 0.3,
        loopAge: 0,
        ageSeconds: t,
        timeSeconds: t,
        world,
        velocity,
      });
      return { world, velocity, alive };
    };

    it("reflects into a decaying arc instead of drifting upward", () => {
      const emitter = makeCollisionEmitter();
      // All samples lie inside the first reflected arc (impact ≈0.82 → return ≈1.33).
      const ys: number[] = [];
      for (let i = 0; i <= 14; i++) {
        ys.push(resolveAt(emitter, 0.85 + i / 30).world[1]);
      }
      let maxIdx = 0;
      for (let i = 1; i < ys.length; i++) {
        if (ys[i]! > ys[maxIdx]!) maxIdx = i;
      }
      // The bug drifted monotonically upward (argmax at the last frame); the fix
      // produces an interior maximum that rises then falls.
      expect(maxIdx).toBeGreaterThan(0);
      expect(maxIdx).toBeLessThan(ys.length - 1);
      expect(ys[maxIdx]!).toBeGreaterThan(ys[0]!);
      expect(ys[maxIdx]!).toBeGreaterThan(ys[ys.length - 1]!);
    });

    it("peaks near the bounce²-scaled impact energy", () => {
      const emitter = makeCollisionEmitter();
      const v0 = 2;
      const y0 = 5;
      const expectedPeak =
        (0.35 * Math.sqrt(v0 * v0 + 4 * G * y0)) ** 2 / (4 * G); // ≈ 0.625
      let maxY = -Infinity;
      for (let i = 0; i <= 400; i++) {
        const t = 0.83 + (i / 400) * 0.5;
        maxY = Math.max(maxY, resolveAt(emitter, t).world[1]);
      }
      expect(Math.abs(maxY - expectedPeak)).toBeLessThan(expectedPeak * 0.05);
    });

    it("writes an upward reflected velocity right after impact", () => {
      const emitter = makeCollisionEmitter();
      // Input vertical velocity is downward (< 0); the reflection must flip it up.
      const { velocity } = resolveAt(emitter, 0.85);
      expect(velocity[1]).toBeGreaterThan(0);
    });

    it("slides on the plane when bounce is zero", () => {
      const emitter = makeCollisionEmitter({ bounce: 0 });
      const { world, velocity } = resolveAt(emitter, 0.85, { vx: 3 });
      expect(world[1]).toBe(0); // pinned to the floor
      expect(velocity[1]).toBe(0); // no vertical rebound
      expect(velocity[0]).toBeCloseTo(3 * (1 - 0.45)); // tangential, dampened
    });

    it("dampens tangential velocity, not distance to origin", () => {
      const emitter = makeCollisionEmitter({ dampen: 0.5 });
      const { world, velocity } = resolveAt(emitter, 0.85, { x0: 100, vx: 4 });
      // Old bug did world[0] *= (1−dampen) → 50; velocity was never touched.
      expect(world[0]).toBeGreaterThan(99);
      expect(velocity[0]).toBeCloseTo(2);
    });

    it("kills the particle below floor − killBelow", () => {
      const emitter = makeCollisionEmitter();
      // rawY at t=1.8 ≈ −23.15, below floor − killBelow (−20).
      expect(resolveAt(emitter, 1.8).alive).toBe(false);
    });

    it("leaves above-floor particles untouched", () => {
      const emitter = makeCollisionEmitter();
      const { world, velocity, alive } = resolveAt(emitter, 0.5, {
        x0: 1,
        z0: 2,
        vx: 3,
        vz: 4,
      });
      expect(alive).toBe(true);
      // Free-fall pin: at t=0.5 rawY ≈ 3.55 > floor, so nothing is rewritten.
      expect(world).toEqual([1, 5 + 2 * 0.5 - G * 0.5 * 0.5, 2]);
      expect(velocity).toEqual([3, 2 - 2 * G * 0.5, 4]);
    });

    it("settles onto the plane after multiple decaying bounces", () => {
      const emitter = makeCollisionEmitter();
      // t=1.65: elapsed since impact exceeds the total geometric bounce time, so
      // the re-folding loop converges onto the plane (and must not spin forever).
      const { world, velocity } = resolveAt(emitter, 1.65);
      expect(world[1]).toBe(0);
      expect(velocity[1]).toBe(0);
    });

    it("reflects once with no gravity given a downward spawn velocity", () => {
      // modules.velocity:false ⇒ g=0 ⇒ single elastic arc, no re-fold.
      const emitter = makeEmitter({
        modules: { velocity: false, collision: true },
        advanced: {
          collision: {
            mode: "plane",
            planeY: 0,
            radius: 0,
            bounce: 0.35,
            dampen: 0.45,
            killBelow: 20,
          },
        },
      });
      const world: Vec3 = [0, -2, 0];
      const velocity: Vec3 = [0, -4, 0];
      const alive = applyParticleMotionModules({
        emitter,
        seed: 0.5,
        normalizedAge: 0.3,
        loopAge: 0,
        ageSeconds: 0.5,
        timeSeconds: 0.5,
        world,
        velocity,
      });
      expect(alive).toBe(true);
      expect(velocity[1]).toBeCloseTo(0.35 * 4); // bounce · |impact velocity|
      expect(world[1]).toBeGreaterThan(0); // launched back above the plane
    });

    it("never sinks a live particle below the floor on a near-elastic bounce", () => {
      // Review item 1: a bounce near 1 with a gentle impact exhausts the 64-fold
      // re-fold cap while `tau` is still past the current arc; the buggy arc
      // branch then evaluated floor + vUp·tau − g·tau² with a runaway −g·tau²,
      // teleporting LIVE particles far below the plane (bug: world[1] ≈ −3
      // sustained for ~950 frames at the default killBelow). The fix settles on
      // the plane instead.
      const emitter = makeCollisionEmitter({ bounce: 0.9 }); // killBelow stays 20
      const y0 = 0.05; // spawns just above the floor → gentle impact
      const v0 = 0;
      let collidedFrames = 0;
      for (let frame = 7; frame <= 121; frame++) {
        const t = frame / 60; // ~0.117 s (just after impact) … ~2.0 s (near cull)
        const rawY = y0 + v0 * t - G * t * t;
        const world: Vec3 = [0, rawY, 0];
        const velocity: Vec3 = [0, v0 - 2 * G * t, 0];
        const alive = applyParticleMotionModules({
          emitter,
          seed: 0.5,
          normalizedAge: 0.3,
          loopAge: 0,
          ageSeconds: t,
          timeSeconds: t,
          world,
          velocity,
        });
        if (!alive) continue; // culled once raw trajectory passes floor − killBelow
        collidedFrames++;
        expect(Number.isFinite(world[1])).toBe(true);
        // A live, collided particle is at or above the plane — never below it.
        expect(world[1]).toBeGreaterThanOrEqual(-1e-6);
      }
      // Guard the guard: the sweep must actually exercise the below-floor path.
      expect(collidedFrames).toBeGreaterThan(50);
    });

    it("settles finitely when a below-floor particle moves upward with no gravity", () => {
      // Review item 2 (g=0 arm): modules.velocity:false ⇒ g=0, and a plane above
      // an upward-moving particle (vyNow ≥ 0) drove the impact-time denominator
      // sqrtDisc − vyNow to 0 ⇒ elapsed = +Infinity ⇒ world = [-Inf, NaN, NaN],
      // with NaN reaching the instanced matrix. The domain guard settles it.
      const emitter = makeEmitter({
        modules: { velocity: false, collision: true },
        advanced: {
          collision: {
            mode: "plane",
            planeY: 0,
            radius: 0,
            bounce: 0.35,
            dampen: 0.45,
            killBelow: 20,
          },
        },
      });
      const world: Vec3 = [3, -0.5, 4]; // below the floor
      const velocity: Vec3 = [2, 2, 5]; // moving UP under the plane
      const alive = applyParticleMotionModules({
        emitter,
        seed: 0.5,
        normalizedAge: 0.3,
        loopAge: 0,
        ageSeconds: 0.5,
        timeSeconds: 0.5,
        world,
        velocity,
      });
      expect(alive).toBe(true);
      expect(world.every((v) => Number.isFinite(v))).toBe(true);
      expect(velocity.every((v) => Number.isFinite(v))).toBe(true);
      expect(world[1]).toBe(0); // settled onto the plane, not shoved to ±Infinity
      expect(velocity[1]).toBe(0); // vertical zeroed
      expect(velocity[0]).toBeCloseTo(2 * (1 - 0.45)); // tangential dampened
      expect(velocity[2]).toBeCloseTo(5 * (1 - 0.45));
    });

    it("settles a below-floor particle moving upward under gravity", () => {
      // Review item 2 (g>0 arm): vyNow ≥ 0 below the floor made elapsed negative,
      // shoving the particle further down with velocity flipped upward.
      const emitter = makeCollisionEmitter(); // g = 9.8, bounce 0.35
      const world: Vec3 = [1, -0.5, 2];
      const velocity: Vec3 = [3, 5, 4]; // upward vertical velocity below the plane
      const alive = applyParticleMotionModules({
        emitter,
        seed: 0.5,
        normalizedAge: 0.3,
        loopAge: 0,
        ageSeconds: 0.5,
        timeSeconds: 0.5,
        world,
        velocity,
      });
      expect(alive).toBe(true);
      expect(world.every((v) => Number.isFinite(v))).toBe(true);
      expect(world[1]).toBe(0); // settled, not shoved below the floor
      expect(velocity[1]).toBe(0);
    });

    it("is a no-op when collision mode is not plane", () => {
      const emitter = makeCollisionEmitter({ mode: "none" });
      const world: Vec3 = [1, -5, 2];
      const velocity: Vec3 = [3, -4, 5];
      const alive = applyParticleMotionModules({
        emitter,
        seed: 0.5,
        normalizedAge: 0.3,
        loopAge: 0,
        ageSeconds: 1,
        timeSeconds: 1,
        world,
        velocity,
      });
      expect(alive).toBe(true);
      expect(world).toEqual([1, -5, 2]);
      expect(velocity).toEqual([3, -4, 5]);
    });
  });
});

describe("effective alignment velocity", () => {
  it("constant velocity yields the analytic direction", () => {
    const { emitter, state, life, seed, loopAge } = makeEffVelState();
    const out: Vec3 = [0, 0, 0];
    computeEffectiveAlignmentVelocity(
      emitter,
      state,
      0,
      0.5,
      life,
      0.5,
      seed,
      loopAge,
      [0, 0, 0],
      1,
      displacedPositionAt(emitter, state, 0.5, life, 0.5, seed, loopAge),
      out,
    );
    expect(out[0]).toBeCloseTo(1, 5);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
    expect(Math.abs(out[2])).toBeLessThan(1e-6);
  });

  it("noise turns the effective velocity off the spawn direction", () => {
    const { emitter, state, life, seed, loopAge } = makeEffVelState({
      modules: { noise: true },
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
    });
    const early: Vec3 = [0, 0, 0];
    const late: Vec3 = [0, 0, 0];
    computeEffectiveAlignmentVelocity(
      emitter,
      state,
      0,
      0.5,
      life,
      0.5,
      seed,
      loopAge,
      [0, 0, 0],
      1,
      displacedPositionAt(emitter, state, 0.5, life, 0.5, seed, loopAge),
      early,
    );
    computeEffectiveAlignmentVelocity(
      emitter,
      state,
      0,
      1.5,
      life,
      1.5,
      seed,
      loopAge,
      [0, 0, 0],
      1,
      displacedPositionAt(emitter, state, 1.5, life, 1.5, seed, loopAge),
      late,
    );
    // The spawn velocity is purely +X; noise injects lateral / vertical turn.
    expect(Math.abs(early[1]) + Math.abs(early[2])).toBeGreaterThan(0.05);
    // The direction genuinely evolves with age (not a constant offset).
    expect(
      Math.hypot(early[0] - late[0], early[1] - late[1], early[2] - late[2]),
    ).toBeGreaterThan(0.01);
  });

  it("effective velocity is tangent to the displaced path", () => {
    const { emitter, state, life, seed, loopAge } = makeEffVelState({
      modules: { noise: true },
      advanced: {
        noise: {
          strength: { mode: "constant", value: 4 },
          frequency: 1,
          speed: 0.5,
          scroll: [1, 0.5, -0.5],
          octaves: 3,
          damping: 0.5,
        },
      },
    });
    for (const age of [0.3, 0.7, 1.2, 2.5]) {
      const coarse: Vec3 = [0, 0, 0];
      computeEffectiveAlignmentVelocity(
        emitter,
        state,
        0,
        age,
        life,
        age,
        seed,
        loopAge,
        [0, 0, 0],
        1,
        displacedPositionAt(emitter, state, age, life, age, seed, loopAge),
        coarse,
      );
      const fine = finiteDiffAlignmentVelocity(
        emitter,
        state,
        age,
        life,
        age,
        seed,
        loopAge,
        1 / 4000,
      );
      expect(normalizedDot(coarse, fine)).toBeGreaterThan(0.999);
    }
  });

  it("forceOverLifetime tilts the effective velocity", () => {
    const { emitter, state, life, seed, loopAge } = makeEffVelState({
      modules: { forceOverLifetime: true },
      advanced: {
        forceOverLifetime: {
          force: [0, 10, 0],
          randomized: [0, 0, 0],
          multiplier: { mode: "constant", value: 1 },
        },
      },
    });
    const out: Vec3 = [0, 0, 0];
    computeEffectiveAlignmentVelocity(
      emitter,
      state,
      0,
      1,
      life,
      1,
      seed,
      loopAge,
      [0, 0, 0],
      1,
      displacedPositionAt(emitter, state, 1, life, 1, seed, loopAge),
      out,
    );
    expect(out[0]).toBeCloseTo(1, 4);
    expect(out[1]).toBeGreaterThan(5);
  });

  it("collision is excluded from the effective velocity", () => {
    const withCollision = makeEffVelState({
      modules: { velocity: true, collision: true },
      forces: { gravityValue: { mode: "constant", value: 9.8 } },
      advanced: {
        collision: {
          mode: "plane",
          planeY: 0,
          radius: 0,
          bounce: 0.5,
          dampen: 0,
          killBelow: 100,
        },
      },
    });
    const noCollision = makeEffVelState({
      modules: { velocity: true },
      forces: { gravityValue: { mode: "constant", value: 9.8 } },
    });
    const withColl: Vec3 = [0, 0, 0];
    const withoutColl: Vec3 = [0, 0, 0];
    // At age 1 the particle is at y = -9.8, well below the collision plane.
    computeEffectiveAlignmentVelocity(
      withCollision.emitter,
      withCollision.state,
      0,
      1,
      withCollision.life,
      1,
      withCollision.seed,
      withCollision.loopAge,
      [0, 0, 0],
      1,
      displacedPositionAt(
        withCollision.emitter,
        withCollision.state,
        1,
        withCollision.life,
        1,
        withCollision.seed,
        withCollision.loopAge,
      ),
      withColl,
    );
    computeEffectiveAlignmentVelocity(
      noCollision.emitter,
      noCollision.state,
      0,
      1,
      noCollision.life,
      1,
      noCollision.seed,
      noCollision.loopAge,
      [0, 0, 0],
      1,
      displacedPositionAt(
        noCollision.emitter,
        noCollision.state,
        1,
        noCollision.life,
        1,
        noCollision.seed,
        noCollision.loopAge,
      ),
      withoutColl,
    );
    // Collision never enters the finite difference: no impact spike, byte-equal.
    expect(withColl).toEqual(withoutColl);
  });

  it("forward difference near spawn stays finite", () => {
    const { emitter, state, life, seed, loopAge } = makeEffVelState({
      modules: { noise: true },
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
    });
    const out: Vec3 = [0, 0, 0];
    computeEffectiveAlignmentVelocity(
      emitter,
      state,
      0,
      0.001,
      life,
      0.001,
      seed,
      loopAge,
      [0, 0, 0],
      1,
      displacedPositionAt(emitter, state, 0.001, life, 0.001, seed, loopAge),
      out,
    );
    expect(out.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(out[0], out[1], out[2])).toBeLessThan(100);
  });

  it("pure velocity-over-lifetime matches the analytic velocity direction", () => {
    // Linear VOL: velocity is the exact derivative of the analytic position, so
    // veff tracks it (regression pin for the VOL path that already worked). NB:
    // ORBITAL is deliberately not used here — the engine's orbital analytic
    // velocity is the frozen spawn-frame tangent cross(w, rel_spawn), which veff
    // (the true curving position tangent) legitimately diverges from over life.
    const { emitter, state, life, seed, loopAge } = makeEffVelState({
      modules: { velocity: false, velocityOverLifetime: true },
      velocity: {
        mode: "vector",
        min: [1, 0, 0],
        max: [1, 0, 0],
        speed: { mode: "constant", value: 0 },
      },
      advanced: {
        velocityOverLifetime: {
          space: "world",
          linear: {
            x: { mode: "constant", value: 0 },
            y: { mode: "constant", value: 5 },
            z: { mode: "constant", value: 0 },
          },
        },
      },
    });
    const age = 0.7;
    const out: Vec3 = [0, 0, 0];
    computeEffectiveAlignmentVelocity(
      emitter,
      state,
      0,
      age,
      life,
      age,
      seed,
      loopAge,
      [0, 0, 0],
      1,
      displacedPositionAt(emitter, state, age, life, age, seed, loopAge),
      out,
    );
    const analytic = sampleParticleMotion(
      emitter,
      state,
      0,
      age,
      Math.min(1, age / life),
      [0, 0, 0],
    );
    // Direction match AND a genuinely off-axis (VOL-tilted) direction — not the
    // bare spawn +X — so the pin exercises the VOL contribution, not just [1,0,0].
    expect(normalizedDot(out, analytic.velocity)).toBeGreaterThan(0.999999);
    expect(out[1]).toBeGreaterThan(4);
  });

  it("orbital velocity-over-lifetime turns the effective alignment velocity across ages", () => {
    // Regression pin for the orbital-alignment fix (review fix-round-1 #4).
    // The engine's ANALYTIC orbital velocity is the FROZEN spawn-frame tangent
    // cross(w, rel_spawn): a particle circling a displaced center keeps a
    // constant analytic velocity DIRECTION at every age, so pre-F a
    // velocity-aligned sprite never re-pointed around the orbit. F's veff is
    // the true (continuously curving) position tangent, which rotates with the
    // orbit. Without this test a perf shortcut that reused analytic velocity
    // for VOL emitters would silently revert the fix with every test green.
    // Fixture: no spawn/linear velocity, orbital omega ~= 1 rad/s about +Y,
    // center offset -1 on X => a unit circle in the X/Z plane about [-1,0,0].
    const { emitter, state, life, seed, loopAge } = makeEffVelState({
      velocity: {
        mode: "vector",
        min: [0, 0, 0],
        max: [0, 0, 0],
        speed: { mode: "constant", value: 0 },
      },
      modules: { velocityOverLifetime: true },
      advanced: {
        velocityOverLifetime: {
          space: "world",
          orbital: {
            x: { mode: "constant", value: 0 },
            y: { mode: "constant", value: 1 },
            z: { mode: "constant", value: 0 },
          },
          orbitalOffset: {
            x: { mode: "constant", value: -1 },
            y: { mode: "constant", value: 0 },
            z: { mode: "constant", value: 0 },
          },
        },
      },
    });
    const evalVeff = (age: number): Vec3 => {
      const out: Vec3 = [0, 0, 0];
      computeEffectiveAlignmentVelocity(
        emitter,
        state,
        0,
        age,
        life,
        age,
        seed,
        loopAge,
        [0, 0, 0],
        1,
        displacedPositionAt(emitter, state, age, life, age, seed, loopAge),
        out,
      );
      return out;
    };
    const early = evalVeff(0.2);
    const late = evalVeff(1.6);
    // Finite and non-degenerate (unit-normalizable) at both ages.
    for (const v of [early, late]) {
      expect(v.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(v[0], v[1], v[2])).toBeGreaterThan(1e-3);
    }
    // The effective velocity DIRECTION rotates with the orbit: omega * dAge ~=
    // 1.4 rad between age 0.2 and 1.6, well past the ~0.5 rad the review asks.
    expect(normalizedDot(early, late)).toBeLessThan(Math.cos(0.5));
    // ...and it genuinely diverges from the FROZEN analytic velocity a perf
    // shortcut would reuse: analytic stays put while veff turns around the orbit.
    const analyticLate = sampleParticleMotion(
      emitter,
      state,
      0,
      1.6,
      Math.min(1, 1.6 / life),
      [0, 0, 0],
    ).velocity;
    expect(normalizedDot(late, analyticLate)).toBeLessThan(Math.cos(0.5));
  });
});

function makeEffVelState(overrides: Record<string, unknown> = {}): {
  emitter: ParticleEmitterDefinition;
  state: ParticleEmitterRuntimeState;
  life: number;
  seed: number;
  loopAge: number;
} {
  const {
    velocity = {
      mode: "vector",
      min: [1, 0, 0],
      max: [1, 0, 0],
      speed: { mode: "constant", value: 0 },
    },
    spawnPosition = [0, 0, 0],
    lifetime = 4,
    ...rest
  } = overrides as {
    velocity?: unknown;
    spawnPosition?: [number, number, number];
    lifetime?: number;
    [key: string]: unknown;
  };
  const effect = normalizeParticleEffect({
    id: "eff-vel-effect",
    emitters: [
      {
        id: "eff-vel-emitter",
        maxParticles: 4,
        duration: 10,
        loop: false,
        forces: {
          gravityValue: { mode: "constant", value: 0 },
          dragValue: { mode: "constant", value: 0 },
        },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
          position: spawnPosition,
          simulationSpace: "world",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: lifetime },
          rotation: { mode: "constant", value: 0 },
          velocity,
        },
        ...rest,
      },
    ],
  });
  const runner = new ParticleEffectRunner(effect);
  runner.reset(effect, [0, 0, 0], 0, 0xabcdef01);
  runner.update(0.001, 0.001);
  const emitter = runner.definition.emitters[0]!;
  const state = runner.states[0]!;
  const life = state.instanceData[7] ?? lifetime;
  const seed = state.instanceData[8] ?? 0.5;
  const loopAge = Math.min(
    1,
    Math.max(0, state.age / Math.max(0.001, emitter.duration)),
  );
  return { emitter, state, life, seed, loopAge };
}

// Reference finite difference at an arbitrary dt, replicating the evaluator's
// forward/central logic so tests can pin dt=1/120 against a finer step.
/**
 * Mirrors the renderers' pre-collision displaced position at (age, time):
 * analytic motion + positional modules, collision excluded. This is what the
 * renderers pass to computeEffectiveAlignmentVelocity as
 * `currentDisplacedPosition`.
 */
function displacedPositionAt(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  ageSeconds: number,
  life: number,
  timeSeconds: number,
  seed: number,
  loopAge: number,
): Vec3 {
  const clampedAge = Math.max(0, ageSeconds);
  const normalizedAge = Math.min(
    1,
    Math.max(0, clampedAge / Math.max(0.001, life)),
  );
  const motion = sampleParticleMotion(
    emitter,
    state,
    0,
    clampedAge,
    normalizedAge,
    [0, 0, 0],
  );
  const sample: ParticleMotionSample = {
    seed,
    normalizedAge,
    loopAge,
    ageSeconds: clampedAge,
    timeSeconds,
    world: motion.position,
    velocity: motion.velocity,
  };
  applyPositionalMotionModules(emitter, sample);
  return [motion.position[0], motion.position[1], motion.position[2]];
}

function finiteDiffAlignmentVelocity(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  ageSeconds: number,
  life: number,
  timeSeconds: number,
  seed: number,
  loopAge: number,
  dt: number,
): Vec3 {
  const evalAt = (age: number, time: number): Vec3 =>
    displacedPositionAt(emitter, state, age, life, time, seed, loopAge);
  const forward = ageSeconds < dt;
  const pPlus = evalAt(ageSeconds + dt, timeSeconds + dt);
  const pMinus = forward
    ? evalAt(ageSeconds, timeSeconds)
    : evalAt(ageSeconds - dt, timeSeconds - dt);
  const inv = 1 / (forward ? dt : 2 * dt);
  return [
    (pPlus[0] - pMinus[0]) * inv,
    (pPlus[1] - pMinus[1]) * inv,
    (pPlus[2] - pMinus[2]) * inv,
  ];
}

function normalizedDot(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
}

function makeEmitter(value: unknown): ParticleEmitterDefinition {
  const effect = normalizeParticleEffect({
    id: "runtime-module-test",
    emitters: [
      {
        id: "emitter",
        ...asRecord(value),
      },
    ],
  });
  const emitter = effect.emitters[0];
  if (!emitter) throw new Error("Expected normalized emitter");
  return emitter;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}
