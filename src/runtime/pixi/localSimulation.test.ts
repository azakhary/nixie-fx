import { Container, Texture } from "pixi.js";
import { PerspectiveCamera, Scene } from "three";
import { describe, expect, it } from "vitest";
import {
  normalizeParticleEffect,
  createConstantParticleScalar,
  ParticleEffectRunner,
  sampleParticleMotion,
} from "../../engine/particles";
import { PixiVfxEffectInstance } from "./renderer";
import { createPixiVfx2dProjection } from "./projection";
import { ThreeVfxRenderer } from "../three/renderer";

function effect(space: "local" | "world") {
  return normalizeParticleEffect({
    id: "space",
    emitters: [
      {
        id: "emitter",
        duration: 0.1,
        loop: false,
        modules: { velocity: false },
        spawn: {
          shape: "point",
          simulationSpace: space,
          position: [1, 2, 0],
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 10 },
          size: { mode: "constant", value: 10 },
          velocity: { mode: "vector", min: [2, 0, 0], max: [2, 0, 0] },
        },
      },
    ],
  });
}

function pixi(definition = effect("local")) {
  return new PixiVfxEffectInstance({
    effect: definition,
    fallbackTextures: {
      circle: Texture.WHITE,
      square: Texture.WHITE,
      triangleShard: Texture.WHITE,
      quadShard: Texture.WHITE,
      grassShard: Texture.WHITE,
    },
    projection: createPixiVfx2dProjection({ pixelsPerUnit: 1, yAxis: "down" }),
  });
}

describe("local simulation transform parity", () => {
  it.each(["local", "world"] as const)(
    "moves, rotates and scales live %s particles without respawning",
    (space) => {
      const definition = effect(space);
      const instance = pixi(definition);
      const camera = new PerspectiveCamera();
      camera.position.z = 20;
      const three = new ThreeVfxRenderer({
        scene: new Scene(),
        camera,
        captureDebugTransforms: true,
      });
      const threeInstance = three.createEffect(definition);
      instance.update(0.01, 0.01);
      three.update(0.01);
      instance.update(0.99, 1);
      three.update(0.99);
      const before = instance.getParticleDebugQuads()[0]!;
      expect(before.x).toBeCloseTo(2.98);
      definition.emitters[0]!.spawn.position = [5, 6, 0];
      definition.emitters[0]!.spawn.rotation = [0, 0, 90];
      definition.emitters[0]!.spawn.scale = [2, 3, 1];
      instance.updateDefinition(definition);
      threeInstance.updateDefinition(definition);
      instance.update(0, 1);
      three.update(0);
      const after = instance.getParticleDebugQuads()[0]!;
      const afterThree = threeInstance.getParticleDebugTransforms()[0]!;
      expect(after.x).toBeCloseTo(space === "local" ? 5 : before.x);
      expect(after.y).toBeCloseTo(space === "local" ? 9.96 : before.y);
      expect(afterThree.position[0]).toBeCloseTo(after.x);
      expect(afterThree.position[1]).toBeCloseTo(after.y);
      expect(instance.stats.activeParticles).toBe(1);
      if (space === "local") {
        expect(after.width).toBeCloseTo(before.width * 2);
        expect(after.rotation - before.rotation).toBeCloseTo(Math.PI / 2);
      }
      instance.destroy();
      three.destroy();
    },
  );

  it("keeps true local state, follows a stopped emitter and recovers from zero scale", () => {
    const definition = effect("local");
    const runner = new ParticleEffectRunner(definition);
    runner.reset(definition, [10, 0, 0], 0);
    runner.update(0.01, 0.01);
    runner.update(1, 1.01); // Emission has ended; the tail still follows transforms.
    const state = runner.states[0]!;
    expect(state.instanceData[0]).toBe(0);
    const emitter = definition.emitters[0]!;
    emitter.spawn.rotation = [0, 0, 90];
    emitter.spawn.scale = [0, 0, 0];
    expect(
      sampleParticleMotion(emitter, state, 0, 1, 0.1, [20, 0, 0]).position,
    ).toEqual([21, 2, 0]);
    emitter.spawn.scale = [2, 3, 1];
    const sample = sampleParticleMotion(emitter, state, 0, 1, 0.1, [20, 0, 0]);
    expect(sample.position[0]).toBeCloseTo(21);
    expect(sample.position[1]).toBeCloseTo(6);
    expect(sample.velocity[0]).toBeCloseTo(0);
    expect(sample.velocity[1]).toBeCloseTo(4);
    expect(state.instanceData[0]).toBe(0);
  });

  it("captures simulation space at birth so switching does not reinterpret living particles", () => {
    const definition = effect("local");
    const instance = pixi(definition);
    instance.update(0.01, 0.01);
    instance.update(0.5, 0.51);
    const before = instance.getParticleDebugQuads()[0]!;
    definition.emitters[0]!.spawn.simulationSpace = "world";
    instance.updateDefinition(definition);
    instance.update(0, 0.51);
    expect(instance.getParticleDebugQuads()[0]).toEqual(before);
    definition.emitters[0]!.spawn.position = [5, 2, 0];
    instance.updateDefinition(definition);
    instance.update(0, 0.51);
    expect(instance.getParticleDebugQuads()[0]!.x).toBeCloseTo(before.x + 4);
    instance.destroy();
  });

  it("rotates local gravity while respecting explicit world velocity", () => {
    const definition = effect("local");
    const emitter = definition.emitters[0]!;
    emitter.modules.velocity = true;
    emitter.forces.gravityValue = createConstantParticleScalar(1, -100, 100);
    emitter.forces.dragValue = createConstantParticleScalar(0, -100, 100);
    emitter.modules.velocityOverLifetime = true;
    emitter.advanced.velocityOverLifetime.space = "world";
    emitter.advanced.velocityOverLifetime.linear.x =
      createConstantParticleScalar(3, -100, 100);
    emitter.spawn.rotation = [0, 0, 90];
    emitter.spawn.scale = [2, 3, 1];
    const runner = new ParticleEffectRunner(definition);
    runner.reset(definition, [0, 0, 0], 0);
    runner.update(0.01, 0.01);
    const sample = sampleParticleMotion(
      emitter,
      runner.states[0]!,
      0,
      1,
      0.1,
      [0, 0, 0],
    );
    // Local (2,-1) -> rotated/scaled (3,4), plus emitter (1,2)
    // and explicitly world-space velocity (3,0).
    expect(sample.position[0]).toBeCloseTo(7);
    expect(sample.position[1]).toBeCloseTo(6);
  });

  it("inherits a nested Pixi parent transform exactly once", () => {
    const instance = pixi();
    const parent = new Container();
    const grandparent = new Container();
    grandparent.addChild(parent);
    parent.addChild(instance.root);
    parent.position.set(10, 20);
    parent.rotation = Math.PI / 2;
    parent.scale.set(2, 3);
    grandparent.position.set(100, 200);
    grandparent.scale.set(2);
    instance.update(0.01, 0.01);
    const quad = instance.getParticleDebugQuads()[0]!;
    const global = instance.root.toGlobal({ x: quad.x, y: quad.y });
    expect(global.x).toBeCloseTo(108);
    expect(global.y).toBeCloseTo(244);
    instance.destroy();
    grandparent.destroy({ children: true });
  });
});
