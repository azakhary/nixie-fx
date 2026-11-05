import { describe, it, expect, vi } from "vitest";
import { createThreeNodeAdapter } from "../node/adapter";
import { Group, PerspectiveCamera } from "three";
import {
  createDefaultParticleEffect,
  createDefaultParticleEmitter,
  ParticleEffectRunner,
} from "../../../engine/particles";
import { createGpuSimulation } from "../../../engine/particleSimulation";
import { ThreeVfxEffectInstance } from "../effectInstance";
import type { ThreeVfxRenderAdapter, ThreeGpuEmitter } from "../renderAdapter";
import { compileVfxEffect } from "../../../export/compiler";
import { normalizeThreeVfxEffect } from "../normalizeEffect";

function hybrid() {
  const e = createDefaultParticleEffect("hybrid");
  e.targetProfile = "three-world-3d";
  const gpu = createDefaultParticleEmitter("gpu");
  gpu.simulation = createGpuSimulation();
  gpu.maxParticles = 100000;
  gpu.render.sortMode = "none";
  e.emitters.push(gpu);
  return e;
}
describe("hybrid lifecycle", () => {
  it("never runs a GPU population in the CPU runner, preserving CPU samples", () => {
    const mixed = hybrid();
    const cpu = { ...mixed, emitters: mixed.emitters.slice(0, 1) };
    const a = new ParticleEffectRunner(cpu),
      b = new ParticleEffectRunner(mixed);
    a.reset(cpu, [0, 0, 0], 0, 42);
    b.reset(mixed, [0, 0, 0], 0, 42);
    for (let i = 1; i <= 60; i++) {
      a.update(1 / 60, i / 60);
      b.update(1 / 60, i / 60);
    }
    expect(b.states[0]!.instanceData).toEqual(a.states[0]!.instanceData);
    expect(b.states[0]!.activeCount).toBe(a.states[0]!.activeCount);
    expect(b.states[1]!.capacity).toBe(1);
    expect(b.states[1]!.activeCount).toBe(0);
  });
  it("coordinates one GPU update, pause, reset and disposal", () => {
    const created: ThreeGpuEmitter[] = [];
    const adapter = {
      ...createThreeNodeAdapter(),
      computeCapabilities: { compute: true, maxParticles: 262144 },
      createGpuEmitter: () => {
        const gpu = {
          root: new Group(),
          capacity: 100000,
          active: true,
          estimatedCount: 10,
          reset: vi.fn(),
          update: vi.fn(),
          allowCompletion: vi.fn(),
          resumeEmission: vi.fn(),
          setRuntimeParameters: vi.fn(),
          dispose: vi.fn(),
        };
        created.push(gpu);
        return gpu;
      },
    } as unknown as ThreeVfxRenderAdapter;
    const instance = new ThreeVfxEffectInstance({
      effect: hybrid(),
      camera: new PerspectiveCamera(),
      renderAdapter: adapter,
      captureDebugTransforms: false,
    });
    instance.update(1 / 60);
    expect(created[0]!.update).toHaveBeenCalledTimes(1);
    instance.pause();
    instance.update(1 / 60);
    expect(created[0]!.update).toHaveBeenCalledTimes(1);
    instance.seek(2 / 60);
    expect(created[0]!.reset).toHaveBeenCalledTimes(1);
    expect(created[0]!.update).toHaveBeenCalledTimes(3);
    instance.stop();
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
    instance.restart();
    expect(created).toHaveLength(2);
    instance.destroy();
    expect(created[1]!.dispose).toHaveBeenCalledTimes(1);
  });
  it("exports and reloads simulation requirements and capacity in format 2", () => {
    const effect = hybrid();
    const compiled = compileVfxEffect(effect);
    expect(compiled.validation.blockers).toEqual([]);
    expect(compiled.effect.version).toBe(2);
    const loaded = normalizeThreeVfxEffect(
      JSON.parse(JSON.stringify(compiled.effect)),
    );
    expect(loaded.emitters[1]!.simulation).toEqual(
      effect.emitters[1]!.simulation,
    );
    expect(loaded.emitters[1]!.maxParticles).toBe(100000);
  });
});
