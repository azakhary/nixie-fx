import { describe, expect, it } from "vitest";
import { PerspectiveCamera, PointLight, Scene, Vector3 } from "three";
import {
  normalizeParticleEffect,
  normalizeParticleLightEmission,
  ParticleEmitterRuntimeState,
  createCurveParticleScalar,
  createParticleGradient,
} from "../../engine/particles";
import { sampleParticleModuleColor } from "../modules/advancedEvaluators";
import { collectPixiVfxUnsupportedFeatures } from "../pixi/support";
import { compileVfxEffect } from "../../export/compiler";
import { VfxLightSelector } from "../lights/selection";
import { evaluateVfxLight, type VfxLightCandidate } from "../lights/candidates";
import { ThreeVfxRenderer } from "./renderer";
import { ThreeVfxLightManager } from "./vfxLights";
const candidate = (id: string, intensity = 1): VfxLightCandidate => ({
  id,
  intensity,
  radius: 3,
  color: [1, 0.2, 0],
  position: [0, 0, 0],
});
const effect = (mode = "particles", space = "local") =>
  normalizeParticleEffect({
    id: "lights",
    emitters: [
      {
        id: "sparks",
        maxParticles: 30,
        duration: 2,
        spawn: {
          rate: 20,
          shape: "point",
          position: [1, 0, 0],
          simulationSpace: space,
        },
        initializeParticle: { lifetime: { mode: "constant", value: 1 } },
        lightEmission: { version: 1, mode, maxLights: 5 },
      },
    ],
  });

describe("shared particle lights", () => {
  it("keeps legacy tint opt-in separate and round-trips through normal export", () => {
    const legacy = normalizeParticleEffect({
      emitters: [{ modules: { lights: true } }],
    });
    expect(legacy.emitters[0]!.lightEmission).toBeUndefined();
    expect(legacy.emitters[0]!.modules.lights).toBe(true);
    const authored = effect();
    expect(
      normalizeParticleEffect(JSON.parse(JSON.stringify(authored))),
    ).toEqual(authored);
    expect(
      compileVfxEffect(authored).effect.emitters[0]!.lightEmission,
    ).toMatchObject({ version: 1, mode: "particles", maxLights: 5 });
    expect(
      normalizeParticleEffect({
        emitters: [{ lightEmission: { version: 99, mode: "particles" } }],
      }).emitters[0]!.lightEmission,
    ).toBeUndefined();
  });
  it("samples emitter loop age after delay and transforms its origin", () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const renderer = new ThreeVfxRenderer({ scene, camera });
    const authored = effect("emitter");
    const emitter = authored.emitters[0]!;
    emitter.timeline.start = 0.5;
    emitter.duration = 1;
    emitter.lightEmission!.color = createParticleGradient(
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    );
    emitter.lightEmission!.intensity = createCurveParticleScalar(2, 10, 0, 100);
    const instance = renderer.createEffect(authored, {
      position: [5, 0, 0],
      rotation: [0, 0, Math.PI / 2],
      scale: [2, 2, 2],
    });
    expect(instance.getLightCandidates()).toHaveLength(0);
    renderer.update(0.4);
    expect(instance.getLightCandidates()).toHaveLength(0);
    renderer.update(0.2);
    const first = instance.getLightCandidates()[0]!;
    expect(first.position[0]).toBeCloseTo(5);
    expect(first.position[1]).toBeCloseTo(2);
    expect(first.intensity).toBeCloseTo(2.8);
    renderer.update(1);
    expect(instance.getLightCandidates()[0]!.intensity).toBeCloseTo(2.8);
    instance.pause();
    instance.seek(0.6);
    expect(instance.getLightCandidates()[0]!.intensity).toBeCloseTo(2.8);
    renderer.destroy();
    const offsetRenderer = new ThreeVfxRenderer({ scene, camera });
    const offsetInstance = offsetRenderer.createEffect(authored, {
      timeSeconds: 10,
    });
    expect(offsetInstance.getLightCandidates()).toHaveLength(0);
    offsetRenderer.update(0.6);
    expect(offsetInstance.getLightCandidates()[0]!.intensity).toBeCloseTo(2.8);
    offsetRenderer.destroy();
  });
  it("keeps the legacy color approximation identical when new emission is enabled", () => {
    const legacy = effect();
    const emitter = legacy.emitters[0]!;
    delete emitter.lightEmission;
    emitter.modules.lights = true;
    const baseline = sampleParticleModuleColor(
      emitter,
      0.3,
      1,
      0.5,
      undefined,
      0.2,
    );
    emitter.lightEmission = normalizeParticleLightEmission({
      version: 1,
      mode: "particles",
    });
    expect(
      sampleParticleModuleColor(emitter, 0.3, 1, 0.5, undefined, 0.2),
    ).toEqual(baseline);
    expect(
      collectPixiVfxUnsupportedFeatures(legacy).some(
        (f) => f.featureKey === "lightEmission",
      ),
    ).toBe(true);
  });
  it("restores illumination when a paused host changes its budget from zero", () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const renderer = new ThreeVfxRenderer({ scene, camera });
    const instance = renderer.createEffect(effect());
    const manager = new ThreeVfxLightManager(scene, 0);
    manager.add(instance);
    renderer.update(0.2);
    instance.pause();
    manager.update(0, camera);
    manager.setBudget(2);
    manager.update(0, camera);
    expect(manager.stats.active).toBe(2);
    expect(
      scene.children
        .filter((o) => o instanceof PointLight)
        .every((o) => (o as PointLight).intensity > 0),
    ).toBe(true);
    renderer.unmount();
    manager.update(0, camera);
    expect(manager.stats.active).toBe(0);
    manager.dispose();
    renderer.destroy();
  });
  it("rejects non-finite and non-positive candidate radii", () => {
    const settings = normalizeParticleLightEmission({
      version: 1,
      mode: "emitter",
    });
    for (const radius of [0, -1, Infinity, NaN]) {
      settings.radius.value = radius;
      expect(evaluateVfxLight(settings, "a", [0, 0, 0], 0, 0, 0.5)).toBeNull();
    }
  });
  it("preserves particle identity through swap compaction and capacity changes", () => {
    const state = new ParticleEmitterRuntimeState(3);
    state.activeCount = 3;
    for (let i = 0; i < 3; i++) {
      state.assignParticleId(i);
    }
    // Use the actual stride from the allocated data.
    const stride = state.instanceData.length / 3;
    for (let i = 0; i < 3; i++)
      state.instanceData[i * stride + 7] = i === 0 ? 0 : 10;
    const last = state.particleIds[2];
    state.compact(1);
    expect(state.particleIds[0]).toBe(last);
    expect(state.cloneWithCapacity(4).particleIds[0]).toBe(last);
  });
  it("holds near-tied winners and fades replacements within the cap", () => {
    const selector = new VfxLightSelector(0.2);
    selector.update([candidate("a"), candidate("b")], 2, 1, [0, 0, 0]);
    selector.update(
      [candidate("a"), candidate("b"), candidate("c", 1.1)],
      2,
      0.02,
      [0, 0, 0],
    );
    expect(selector.slots.map((s) => s.candidate.id)).toEqual(["a", "b"]);
    selector.update(
      [candidate("a"), candidate("b"), candidate("c", 10)],
      2,
      0.05,
      [0, 0, 0],
    );
    expect(
      selector.slots.some((s) => s.retiring && s.gain > 0 && s.gain < 1),
    ).toBe(true);
    for (let i = 0; i < 20; i++) {
      selector.update(
        [candidate("c", 10), candidate("d", 10)],
        2,
        0.02,
        [0, 0, 0],
      );
      expect(selector.slots.length).toBeLessThanOrEqual(2);
    }
    expect(selector.slots.map((s) => s.candidate.id).sort()).toEqual([
      "c",
      "d",
    ]);
    selector.update([], 0, 0, [0, 0, 0]);
    expect(selector.slots).toHaveLength(0);
  });
  for (const space of ["local", "world"])
    it(`matches rendered particle transforms in ${space} space`, () => {
      const scene = new Scene();
      const camera = new PerspectiveCamera();
      const renderer = new ThreeVfxRenderer({ scene, camera });
      const instance = renderer.createEffect(effect("particles", space), {
        position: [3, 2, 1],
        rotation: [0, 0, 0.7],
        scale: [2, 2, 2],
      });
      renderer.update(0.1);
      const first = instance.getLightCandidates()[0]!;
      const debug = instance.getParticleDebugTransforms()[0]!;
      const rendered = new Vector3();
      // Debug position is simulation-world; root removes translation before applying its transform.
      rendered
        .fromArray(debug.position)
        .sub(new Vector3(3, 2, 1))
        .applyMatrix4(instance.root.matrixWorld);
      expect(first.position).toEqual(rendered.toArray());
      const id = first.id;
      renderer.update(0.01);
      expect(instance.getLightCandidates().some((c) => c.id === id)).toBe(true);
      renderer.destroy();
    });
  it("shares one cap across renderers and cleans hidden, seeked and removed instances without touching scene lights", () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const gameLight = new PointLight(0xffffff, 7);
    scene.add(gameLight);
    const manager = new ThreeVfxLightManager(scene, 2);
    expect(ThreeVfxLightManager.forScene(scene)).toBe(manager);
    const a = new ThreeVfxRenderer({ scene, camera });
    const b = new ThreeVfxRenderer({ scene, camera });
    const first = a.createEffect(effect());
    const second = b.createEffect(effect());
    manager.add(first);
    manager.add(second);
    a.update(0.2);
    b.update(0.2);
    manager.update(0.2, camera);
    expect(manager.stats.active).toBe(2);
    expect(manager.stats.candidates).toBeGreaterThan(2);
    expect(
      new Set(
        [...first.getLightCandidates(), ...second.getLightCandidates()].map(
          (c) => c.id,
        ),
      ).size,
    ).toBe(manager.stats.candidates);
    first.pause();
    const frozen = structuredClone(first.getLightCandidates());
    a.update(1);
    expect(first.getLightCandidates()).toEqual(frozen);
    first.setVisible(false);
    b.removeEffect(second);
    manager.update(0.1, camera);
    expect(manager.stats.active).toBe(0);
    first.setVisible(true);
    first.restart();
    a.update(0.2);
    manager.update(0.2, camera);
    expect(manager.stats.active).toBeGreaterThan(0);
    first.seek(0);
    manager.update(0, camera);
    expect(manager.stats.active).toBe(0);
    manager.setBudget(0);
    expect(gameLight.intensity).toBe(7);
    expect(gameLight.parent).toBe(scene);
    manager.dispose();
    a.destroy();
    b.destroy();
    expect(scene.children.filter((o) => o instanceof PointLight)).toEqual([
      gameLight,
    ]);
  });
});
