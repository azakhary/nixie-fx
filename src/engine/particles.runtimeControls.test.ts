import { describe, expect, it } from "vitest";
import {
  PARTICLE_INSTANCE_STRIDE,
  ParticleEffectRunner,
  normalizeParticleEffect,
} from "./particles";

function loopingEffect(simulationSpace: "local" | "world" = "world") {
  return normalizeParticleEffect({
    id: `runtime-controls-${simulationSpace}`,
    emitters: [
      {
        id: "loop",
        maxParticles: 32,
        duration: 1,
        loop: true,
        spawn: {
          simulationSpace,
          rate: 10,
          rateValue: { mode: "constant", value: 10 },
          bursts: [],
          shape: "point",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 0.5 },
          velocity: { mode: "vector", min: [2, 0, 0], max: [2, 0, 0] },
        },
      },
    ],
  });
}

describe("ParticleEffectRunner runtime controls", () => {
  it("allows live tails to complete, keeps local tails attached, and resets emission", () => {
    const effect = loopingEffect("local");
    const runner = new ParticleEffectRunner(effect);
    runner.reset(effect, [0, 0, 0], 0, 123);
    runner.update(0.1, 0.1);
    expect(runner.stats.activeParticles).toBe(1);

    runner.allowCompletion();
    runner.setPosition([4, 0, 0]);
    runner.update(0.1, 0.2);
    expect(runner.stats.emittedLastFrame).toBe(0);
    expect(runner.stats.activeParticles).toBe(1);
    expect(runner.states[0]!.instanceData[0]).toBeCloseTo(4);

    runner.update(0.5, 0.7);
    expect(runner.isActive).toBe(false);
    expect(runner.stats.activeParticles).toBe(0);

    runner.reset(effect, [0, 0, 0], 1, 123);
    runner.update(0.1, 1.1);
    expect(runner.stats.emittedLastFrame).toBe(1);
  });

  it("clamps runtime multipliers and applies the emission rate multiplier", () => {
    const effect = loopingEffect();
    const runner = new ParticleEffectRunner(effect);
    runner.setRuntimeParameters({
      emissionRateMultiplier: 0.5,
      initialVelocityMultiplier: Number.POSITIVE_INFINITY,
    });
    expect(runner.runtimeParameters).toEqual({
      emissionRateMultiplier: 0.5,
      initialVelocityMultiplier: 0,
    });

    runner.reset(effect, [0, 0, 0], 0, 123);
    runner.update(0.2, 0.2);
    expect(runner.stats.emittedLastFrame).toBe(1);
    expect(runner.states[0]!.instanceData[4]).toBeCloseTo(2);

    runner.setRuntimeParameters({ emissionRateMultiplier: -4 });
    runner.update(0.2, 0.4);
    expect(runner.runtimeParameters.emissionRateMultiplier).toBe(0);
    expect(runner.stats.emittedLastFrame).toBe(0);
    expect(runner.states[0]!.instanceData.length).toBe(
      runner.states[0]!.capacity * PARTICLE_INSTANCE_STRIDE,
    );
  });
});
