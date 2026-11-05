import { describe, it, expect } from "vitest";
import {
  createDefaultParticleEffect,
  normalizeParticleEffect,
} from "./particles";
import {
  createGpuSimulation,
  gpuSimulationIssues,
  resolveParticleSimulation,
} from "./particleSimulation";

describe("native GPU simulation contract", () => {
  it("preserves legacy CPU files and their capacity limit", () => {
    const effect = createDefaultParticleEffect();
    effect.emitters[0]!.maxParticles = 100000;
    const normalized = normalizeParticleEffect(effect);
    expect(normalized.version).toBe(1);
    expect(normalized.emitters[0]!.simulation).toBeUndefined();
    expect(normalized.emitters[0]!.maxParticles).toBe(4096);
  });
  it("round trips GPU settings and high capacity without affecting CPU emitters", () => {
    const effect = createDefaultParticleEffect();
    const emitter = effect.emitters[0]!;
    emitter.simulation = createGpuSimulation();
    emitter.maxParticles = 100000;
    const normalized = normalizeParticleEffect(
      JSON.parse(JSON.stringify(effect)),
    );
    expect(normalized.version).toBe(2);
    expect(normalized.emitters[0]!.maxParticles).toBe(100000);
    expect(normalized.emitters[0]!.simulation).toEqual(emitter.simulation);
  });
  it("blocks invalid GPU capacities without erasing the requested value", () => {
    for (const capacity of [262145, 0, 12.5, Number.NaN]) {
      const effect = createDefaultParticleEffect();
      effect.emitters[0]!.simulation = createGpuSimulation();
      effect.emitters[0]!.maxParticles = capacity;
      const emitter = normalizeParticleEffect(effect).emitters[0]!;
      expect(emitter.maxParticles).toBe(capacity);
      const result = resolveParticleSimulation(emitter, {
        compute: true,
        maxParticles: 262144,
      });
      expect(result.target).toBe("blocked");
      expect(result.messages.join(" ")).toContain("GPU capacity");
    }
  });
  it("never treats a renderer fallback as compute support", () => {
    const emitter = createDefaultParticleEffect().emitters[0]!;
    emitter.simulation = createGpuSimulation();
    expect(resolveParticleSimulation(emitter).target).toBe("blocked");
    emitter.maxParticles = 100000;
    emitter.simulation.fallback = { mode: "cpu", maxParticles: 512 };
    const result = resolveParticleSimulation(emitter);
    expect(result.target).toBe("cpu");
    expect(result.capacity).toBe(512);
    expect(result.messages.join(" ")).toMatch(/fidelity/i);
  });
  it("reports unsupported modules and rejects insufficient adapter capacity", () => {
    const emitter = createDefaultParticleEffect().emitters[0]!;
    emitter.simulation = createGpuSimulation();
    emitter.modules.collision = true;
    expect(gpuSimulationIssues(emitter).join(" ")).toMatch(/collision/);
    emitter.modules.collision = false;
    emitter.maxParticles = 100000;
    expect(
      resolveParticleSimulation(emitter, { compute: true, maxParticles: 4096 })
        .target,
    ).toBe("blocked");
  });
});
