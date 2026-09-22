import { describe, expect, it } from "vitest";
import {
  isSharedParticleEffectDefinition,
  ParticleEffectRuntimeDefinition,
  shareParticleEffectDefinition,
  sharedParticleEffectDefinition,
} from "./ParticleEffectRuntimeDefinition";
import {
  cloneParticleEffect,
  createDefaultParticleEffect,
  normalizeParticleEffect,
  ParticleEffectRunner,
} from "./particles";

describe("ParticleEffectRuntimeDefinition", () => {
  it("isolates mutable editor input and refreshes it on explicit replay", () => {
    const effect = createDefaultParticleEffect();
    const owner = new ParticleEffectRuntimeDefinition(
      effect,
      cloneParticleEffect,
    );
    const originalRate = owner.value.emitters[0]!.spawn.rate;
    effect.emitters[0]!.spawn.rate = originalRate + 1;
    expect(owner.value.emitters[0]!.spawn.rate).toBe(originalRate);
    owner.replace(effect);
    expect(owner.value.emitters[0]!.spawn.rate).toBe(originalRate + 1);
    expect(owner.value).not.toBe(effect);
  });

  it("shares only deeply frozen catalog definitions and keeps public cloning mutable", () => {
    const source = normalizeParticleEffect(createDefaultParticleEffect());
    expect(isSharedParticleEffectDefinition(source)).toBe(false);
    expect(sharedParticleEffectDefinition(source)).toBeUndefined();
    const shared = shareParticleEffectDefinition(source);
    expect(shared).toBe(source);
    expect(isSharedParticleEffectDefinition(shared)).toBe(true);
    expect(sharedParticleEffectDefinition(shared)).toBe(shared);
    expect(Object.isFrozen(shared.emitters[0]!.spawn)).toBe(true);
    expect(Object.isFrozen(shared.emitters[0]!.billboard.sizeValue.curve)).toBe(
      true,
    );
    expect(shareParticleEffectDefinition(shared)).toBe(shared);
    expect(
      new ParticleEffectRuntimeDefinition(shared, cloneParticleEffect).value,
    ).toBe(shared);
    const clone = cloneParticleEffect(shared);
    expect(clone).toEqual(shared);
    expect(Object.isFrozen(clone.emitters[0]!.spawn)).toBe(false);
    clone.emitters[0]!.spawn.rate += 1;
    expect(clone.emitters[0]!.spawn.rate).not.toBe(
      shared.emitters[0]!.spawn.rate,
    );
  });

  it("copies a shared definition on write and keeps an owned one in place", () => {
    const shared = shareParticleEffectDefinition(
      normalizeParticleEffect(createDefaultParticleEffect()),
    );
    const owner = new ParticleEffectRuntimeDefinition(
      shared,
      cloneParticleEffect,
    );
    const mutable = owner.mutable();
    expect(mutable).not.toBe(shared);
    expect(owner.value).toBe(mutable);
    expect(Object.isFrozen(mutable.emitters[0]!.spawn)).toBe(false);
    expect(owner.mutable()).toBe(mutable);
    expect(isSharedParticleEffectDefinition(shared)).toBe(true);
  });
});

describe("ParticleEffectRunner definition ownership", () => {
  it("clones an unshared definition and reuses a shared one", () => {
    const raw = normalizeParticleEffect(createDefaultParticleEffect());
    const owned = new ParticleEffectRunner(raw);
    expect(owned.definition).not.toBe(raw);
    const shared = shareParticleEffectDefinition(
      normalizeParticleEffect(createDefaultParticleEffect()),
    );
    const runner = new ParticleEffectRunner(shared);
    expect(runner.definition).toBe(shared);
    runner.updateDefinition(shared);
    expect(runner.definition).toBe(shared);
    runner.reset(shared, [0, 0, 0], 0, 1234);
    expect(runner.definition).toBe(shared);
    runner.reset(raw, [0, 0, 0], 0, 1234);
    expect(runner.definition).not.toBe(raw);
  });

  it("never mutates a shared definition through runtime parameter patches", () => {
    const shared = shareParticleEffectDefinition(
      normalizeParticleEffect(createDefaultParticleEffect()),
    );
    const before = JSON.stringify(shared);
    const runner = new ParticleEffectRunner(shared);
    runner.reset(shared, [0, 0, 0], 0, 4242);
    runner.setRuntimeParameters({
      emissionRateMultiplier: 0.25,
      initialVelocityMultiplier: 3,
    });
    runner.setEmitterRuntimeParameters(shared.emitters[0]!.id, {
      emissionRateMultiplier: 0,
    });
    for (let frame = 1; frame <= 20; frame++) runner.update(1 / 60, frame / 60);
    expect(runner.definition).toBe(shared);
    expect(JSON.stringify(shared)).toBe(before);
    expect(runner.runtimeParameters.emissionRateMultiplier).toBe(0.25);
    expect(runner.effectiveEmissionRateMultiplier(shared.emitters[0]!.id)).toBe(
      0,
    );
  });

  it("keeps per-instance simulation independent with identical authored playback", () => {
    const raw = normalizeParticleEffect(createDefaultParticleEffect());
    const shared = shareParticleEffectDefinition(
      normalizeParticleEffect(createDefaultParticleEffect()),
    );
    const first = new ParticleEffectRunner(shared);
    const second = new ParticleEffectRunner(shared);
    const reference = new ParticleEffectRunner(raw);
    for (const runner of [first, second, reference]) {
      runner.reset(runner.definition, [2, 3, 0], 0, 12345);
    }
    for (let frame = 1; frame <= 60; frame++) {
      for (const runner of [first, second, reference]) {
        runner.update(1 / 60, frame / 60);
      }
    }
    expect(first.definition).toBe(shared);
    expect(second.definition).toBe(shared);
    expect(first.states[0]).not.toBe(second.states[0]);
    expect(first.states[0]!.instanceData).toEqual(
      reference.states[0]!.instanceData,
    );
    expect(second.states[0]!.instanceData).toEqual(
      first.states[0]!.instanceData,
    );
    first.stop();
    expect(first.states[0]!.activeCount).toBe(0);
    expect(second.states[0]!.activeCount).toBeGreaterThan(0);
  });
});
