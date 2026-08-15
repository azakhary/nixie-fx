import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";
import { describe, expect, it, vi } from "vitest";
import {
  ParticleEffectRunner,
  normalizeParticleEffect,
} from "../../engine/particles";
import { ThreeVfxRenderer } from "./renderer";

function createCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  return camera;
}

function twoEmitterRateEffect() {
  const emitter = (id: string) => ({
    id,
    maxParticles: 64,
    duration: 1,
    loop: true,
    spawn: {
      rate: 60,
      rateValue: { mode: "constant", value: 60 },
      bursts: [],
      shape: "point",
    },
    initializeParticle: {
      lifetime: { mode: "constant", value: 5 },
      velocity: { mode: "vector", min: [1, 0, 0], max: [1, 0, 0] },
    },
  });
  return normalizeParticleEffect({
    id: "per-emitter-params",
    emitters: [emitter("a"), emitter("b")],
  });
}

function oneShotBurstEffect(maxParticles = 64) {
  return normalizeParticleEffect({
    id: "host-burst",
    emitters: [
      {
        id: "embers",
        maxParticles,
        duration: 0.5,
        loop: false,
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [],
          shape: "point",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 0.3 },
          velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
        },
      },
    ],
  });
}

/**
 * Burst-only emitter with unit lifetime/duration and constant unit size, so
 * normalizedAge tracks seconds 1:1 and rendered width equals the host size
 * multiplier exactly. `modules` is passed explicitly per test.
 */
function unitParticleEmitter(
  modules: Record<string, boolean>,
): Record<string, unknown> {
  return {
    maxParticles: 8,
    duration: 1,
    loop: false,
    modules,
    spawn: {
      rate: 0,
      rateValue: { mode: "constant", value: 0 },
      bursts: [],
      shape: "point",
    },
    initializeParticle: {
      lifetime: { mode: "constant", value: 1 },
      size: { mode: "constant", value: 1 },
      velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
    },
  };
}

function firstParticleBasicMaterial(instance: {
  root: { children: unknown[] };
}): MeshBasicMaterial {
  for (const child of instance.root.children) {
    if (
      child instanceof Mesh &&
      child.visible &&
      child.material instanceof MeshBasicMaterial
    ) {
      return child.material;
    }
  }
  throw new Error("Expected a visible particle mesh with a basic material.");
}

describe("per-emitter runtime parameters (engine)", () => {
  it("mutes one emitter's emission while the other keeps spawning", () => {
    const effect = twoEmitterRateEffect();
    const runner = new ParticleEffectRunner(effect);
    runner.setEmitterRuntimeParameters("a", { emissionRateMultiplier: 0 });
    runner.reset(effect, [0, 0, 0], 0, 9);
    runner.update(0.5, 0.5);
    expect(runner.states[0]!.activeCount).toBe(0);
    expect(runner.states[1]!.activeCount).toBeGreaterThan(20);
  });

  it("composes multiplicatively with the effect-level multiplier", () => {
    const effect = twoEmitterRateEffect();
    const runner = new ParticleEffectRunner(effect);
    runner.setRuntimeParameters({ emissionRateMultiplier: 0.5 });
    runner.setEmitterRuntimeParameters("a", { emissionRateMultiplier: 2 });
    expect(runner.effectiveEmissionRateMultiplier("a")).toBeCloseTo(1);
    expect(runner.effectiveEmissionRateMultiplier("b")).toBeCloseTo(0.5);
    expect(runner.effectiveInitialVelocityMultiplier("a")).toBeCloseTo(1);
  });

  it("patches merge and unknown emitters read as identity", () => {
    const effect = twoEmitterRateEffect();
    const runner = new ParticleEffectRunner(effect);
    runner.setEmitterRuntimeParameters("a", { emissionRateMultiplier: 3 });
    runner.setEmitterRuntimeParameters("a", { initialVelocityMultiplier: 2 });
    expect(runner.getEmitterRuntimeParameters("a")).toMatchObject({
      emissionRateMultiplier: 3,
      initialVelocityMultiplier: 2,
    });
    expect(runner.getEmitterRuntimeParameters("nope")).toBeNull();
    expect(runner.effectiveEmissionRateMultiplier("nope")).toBe(1);
  });
});

describe("host-triggered bursts", () => {
  it("emits immediately, clamps to capacity, and supports a burst position", () => {
    const effect = oneShotBurstEffect(10);
    const runner = new ParticleEffectRunner(effect);
    runner.reset(effect, [0, 0, 0], 0, 3);
    runner.update(0.05, 0.05);
    expect(runner.states[0]!.activeCount).toBe(0);

    const emitted = runner.emitBurst("embers", {
      count: 25,
      position: [7, 8, 9],
    });
    expect(emitted).toBe(10);
    expect(runner.states[0]!.activeCount).toBe(10);
    expect(runner.states[0]!.instanceData[0]).toBeCloseTo(7);
    expect(runner.states[0]!.instanceData[1]).toBeCloseTo(8);
    expect(runner.states[0]!.instanceData[2]).toBeCloseTo(9);
    // The runner position is restored after the burst.
    expect(runner.emitBurst("unknown")).toBe(0);
  });

  it("instance emitBurst restarts a completed one-shot so the burst lands", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(oneShotBurstEffect());
    // Run the one-shot to completion (duration 0.5 + lifetime 0.3).
    for (let i = 0; i < 90; i++) renderer.update(1 / 60);
    expect(instance.isActive).toBe(false);

    const emitted = instance.emitBurst("embers", { count: 12 });
    expect(emitted).toBe(12);
    renderer.update(1 / 60);
    expect(instance.getParticleDebugTransforms().length).toBe(12);
  });

  it("instance restart() replays a finished one-shot from t=0", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(oneShotBurstEffect());
    for (let i = 0; i < 90; i++) renderer.update(1 / 60);
    expect(instance.isActive).toBe(false);
    instance.restart();
    expect(instance.isActive).toBe(true);
  });
});

describe("per-emitter draw parameters (three)", () => {
  it("sizeMultiplier scales rendered particles without touching the definition", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(oneShotBurstEffect());
    instance.emitBurst("embers", { count: 4 });
    renderer.update(1 / 60);
    const baseWidth = instance.getParticleDebugTransforms()[0]!.width;

    instance.setEmitterRuntimeParameters("embers", { sizeMultiplier: 2 });
    renderer.update(1 / 60);
    const scaledWidth = instance.getParticleDebugTransforms()[0]!.width;
    expect(scaledWidth).toBeCloseTo(baseWidth * 2, 4);
  });

  it("sizeMultiplierValue samples a curve at the particle's age and composes with sizeMultiplier", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    // lifetime 1 + duration 1 so normalizedAge tracks elapsed seconds 1:1;
    // authored modules off so the authored width is a constant 1.
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "size-over-life",
        emitters: [
          {
            id: "embers",
            ...unitParticleEmitter({ size: false, color: false }),
          },
        ],
      }),
    );
    instance.setEmitterRuntimeParameters("embers", {
      sizeMultiplierValue: {
        mode: "curve",
        curve: [
          { x: 0, y: 1 },
          { x: 1, y: 3 },
        ],
      },
    });
    instance.emitBurst("embers", { count: 1 });
    renderer.update(0.01);
    const young = instance.getParticleDebugTransforms()[0]!.width;
    expect(young).toBeCloseTo(1, 1);

    for (let i = 0; i < 96; i++) renderer.update(0.01); // age ~0.97
    const old = instance.getParticleDebugTransforms()[0]!.width;
    expect(old).toBeGreaterThan(2.5);
    expect(old).toBeLessThanOrEqual(3.05);

    // Composes with the scalar multiplier; null restores authored sizing.
    instance.setEmitterRuntimeParameters("embers", { sizeMultiplier: 2 });
    renderer.update(0.001);
    expect(instance.getParticleDebugTransforms()[0]!.width).toBeCloseTo(
      old * 2,
      1,
    );
    instance.setEmitterRuntimeParameters("embers", {
      sizeMultiplier: 1,
      sizeMultiplierValue: null,
    });
    renderer.update(0.001);
    expect(instance.getParticleDebugTransforms()[0]!.width).toBeCloseTo(1, 4);
  });

  it("colorOverLifetimeGradient overrides the authored gradient and null restores it", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "color-over-life-override",
        emitters: [
          {
            id: "embers",
            ...unitParticleEmitter({ size: false, color: true }),
            color: {
              gradient: {
                mode: "blend",
                colorStops: [
                  { position: 0, color: [1, 0, 0] },
                  { position: 1, color: [1, 0, 0] },
                ],
                alphaStops: [
                  { position: 0, alpha: 1 },
                  { position: 1, alpha: 1 },
                ],
              },
            },
          },
        ],
      }),
    );
    instance.emitBurst("embers", { count: 1 });
    renderer.update(1 / 60);
    const authored = firstParticleBasicMaterial(instance);
    expect(authored.color.r).toBeGreaterThan(0.9);
    expect(authored.color.g).toBeLessThan(0.05);

    instance.setEmitterRuntimeParameters("embers", {
      colorOverLifetimeGradient: {
        mode: "blend",
        colorStops: [
          { position: 0, color: [0, 1, 0] },
          { position: 1, color: [0, 1, 0] },
        ],
        alphaStops: [
          { position: 0, alpha: 0.5 },
          { position: 1, alpha: 0.5 },
        ],
      },
    });
    renderer.update(1 / 60);
    const overridden = firstParticleBasicMaterial(instance);
    expect(overridden.color.g).toBeGreaterThan(0.9);
    expect(overridden.color.r).toBeLessThan(0.05);
    expect(overridden.opacity).toBeCloseTo(0.5, 4);

    instance.setEmitterRuntimeParameters("embers", {
      colorOverLifetimeGradient: null,
    });
    renderer.update(1 / 60);
    const restored = firstParticleBasicMaterial(instance);
    expect(restored.color.r).toBeGreaterThan(0.9);
    expect(restored.color.g).toBeLessThan(0.05);
  });

  it("colorOverLifetimeGradient applies even when the color module is authored off", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "color-override-module-off",
        emitters: [
          {
            id: "embers",
            ...unitParticleEmitter({ size: false, color: false }),
          },
        ],
      }),
    );
    instance.setEmitterRuntimeParameters("embers", {
      colorOverLifetimeGradient: {
        mode: "blend",
        colorStops: [
          { position: 0, color: [0, 0, 1] },
          { position: 1, color: [0, 0, 1] },
        ],
        alphaStops: [
          { position: 0, alpha: 1 },
          { position: 1, alpha: 1 },
        ],
      },
    });
    instance.emitBurst("embers", { count: 1 });
    renderer.update(1 / 60);
    const material = firstParticleBasicMaterial(instance);
    expect(material.color.b).toBeGreaterThan(0.9);
    expect(material.color.r).toBeLessThan(0.05);
  });
});

describe("render geometry injection", () => {
  function meshRenderEffect() {
    return normalizeParticleEffect({
      id: "render-geometry",
      targetProfile: "three-world-3d",
      emitters: [
        {
          id: "shards",
          mode: "mesh",
          mesh: { renderMode: "meshAsset", asset: null },
          maxParticles: 8,
          duration: 1,
          loop: true,
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            bursts: [
              { time: 0, count: 4, cycles: 1, interval: 0, probability: 1 },
            ],
            shape: "point",
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 5 },
            velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
          },
        },
      ],
    });
  }

  it("renders host geometry for a meshAsset emitter with no authored asset", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(meshRenderEffect());
    renderer.update(1 / 60);
    // No asset, no override: the emitter draws nothing.
    expect(instance.getParticleDebugTransforms().length).toBe(0);

    instance.setRenderGeometry("shards", new BoxGeometry(1, 1, 1));
    renderer.update(1 / 60);
    const transforms = instance.getParticleDebugTransforms();
    expect(transforms.length).toBe(4);
    expect(transforms[0]!.mode).toBe("meshAsset");

    instance.setRenderGeometry("shards", null);
    renderer.update(1 / 60);
    expect(instance.getParticleDebugTransforms().length).toBe(0);
  });
});

describe("host material injection", () => {
  it("uses the provider material on the legacy path and never disposes it", () => {
    const hostMaterial = new MeshBasicMaterial({ color: 0xff0000 });
    const disposeSpy = vi.spyOn(hostMaterial, "dispose");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      materialProvider: {
        getParticleMaterial: (_effect, emitterId) =>
          emitterId === "embers" ? hostMaterial : null,
      },
    });
    const instance = renderer.createEffect(oneShotBurstEffect());
    instance.emitBurst("embers", { count: 4 });
    renderer.update(1 / 60);

    // Host material disables the instanced fast path.
    expect(instance.stats.instancedDrawCalls).toBe(0);
    expect(instance.stats.legacyParticleDrawCalls).toBeGreaterThan(0);

    instance.destroy();
    expect(disposeSpy).not.toHaveBeenCalled();
  });
});
