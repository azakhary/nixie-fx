import {
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import {
  PARTICLE_INSTANCE_STRIDE,
  ParticleEmitterRuntimeState,
  createDefaultParticleEffect,
  normalizeParticleEffect,
} from "../../engine/particles";
import { getProceduralBillboardTexture } from "./proceduralBillboardTexture";
import { ThreeVfxRenderer, updateInstancedParticleOrder } from "./renderer";

function camera(): PerspectiveCamera {
  const value = new PerspectiveCamera(45, 1, 0.1, 100);
  value.position.set(0, 0, 10);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld(true);
  return value;
}

function compatibleEffect(
  options: {
    count?: number;
    velocity?: [number, number, number];
    spawnPosition?: [number, number, number];
    lifetime?: number;
  } = {},
) {
  const velocity = options.velocity ?? [0, 0, 0];
  return normalizeParticleEffect({
    id: "compatible-three-effect",
    targetProfile: "three-world-3d",
    emitters: [
      {
        id: "compatible",
        maxParticles: 16,
        duration: 2,
        loop: false,
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            {
              time: 0,
              count: options.count ?? 1,
              cycles: 1,
              interval: 0,
              probability: 1,
            },
          ],
          shape: "point",
          position: options.spawnPosition ?? [0, 0, 0],
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: options.lifetime ?? 2 },
          size: { mode: "constant", value: 1 },
          velocity: { mode: "vector", min: velocity, max: velocity },
          color: {
            color: [1, 1, 1, 1],
            intensity: { mode: "constant", value: 1 },
          },
        },
        forces: {
          gravity: 0,
          gravityValue: { mode: "constant", value: 0 },
          drag: 0,
          dragValue: { mode: "constant", value: 0 },
        },
        render: {
          texture: "textures/particle.png",
          shading: "unlit",
          blend: "alpha",
          sortMode: "none",
          alignAxis: "screen",
          facing: "cameraPlane",
          opacitySource: "textureAlpha",
          opacityInvert: false,
        },
      },
    ],
  });
}

function rendererFor(
  texture: Texture,
  captureDebugTransforms = true,
): ThreeVfxRenderer {
  return new ThreeVfxRenderer({
    scene: new Scene(),
    camera: camera(),
    captureDebugTransforms,
    textureProvider: { getTexture: () => texture },
  });
}

describe("Three runtime controls and retained billboard path", () => {
  it("draws compatible particles with one retained InstancedMesh draw", () => {
    const renderer = rendererFor(new Texture(), false);
    const instance = renderer.createEffect(compatibleEffect({ count: 6 }));
    renderer.update(1 / 60);

    expect(instance.root.children).toHaveLength(1);
    expect(instance.root.children[0]).toBeInstanceOf(InstancedMesh);
    expect((instance.root.children[0] as InstancedMesh).count).toBe(6);
    expect(instance.stats).toMatchObject({
      visibleParticles: 6,
      drawCalls: 1,
      instancedDrawCalls: 1,
      legacyParticleDrawCalls: 0,
    });
    expect(instance.getParticleDebugTransforms()).toEqual([]);
  });

  it("keeps unsupported billboard variants on the legacy per-particle path", () => {
    const renderer = rendererFor(new Texture());
    const effect = compatibleEffect({ count: 2 });
    // Derived-opacity emitters stay legacy; sort modes no longer demote (F13).
    effect.emitters[0]!.render.opacityInvert = true;
    const instance = renderer.createEffect(effect);
    renderer.update(1 / 60);

    expect(
      instance.root.children.filter((child) => child instanceof Mesh),
    ).toHaveLength(2);
    expect(
      instance.root.children.some((child) => child instanceof InstancedMesh),
    ).toBe(false);
    expect(instance.stats).toMatchObject({
      drawCalls: 2,
      instancedDrawCalls: 0,
      legacyParticleDrawCalls: 2,
    });
  });

  it("keeps the one-draw instanced path for every sort mode (F13)", () => {
    for (const sortMode of [
      "none",
      "oldestFirst",
      "youngestFirst",
      "distanceFarFirst",
      "distanceNearFirst",
    ] as const) {
      const renderer = rendererFor(new Texture(), false);
      const effect = compatibleEffect({ count: 5 });
      effect.emitters[0]!.render.sortMode = sortMode;
      const instance = renderer.createEffect(effect);
      renderer.update(1 / 60);

      expect(
        instance.root.children[0],
        `${sortMode} should stay instanced`,
      ).toBeInstanceOf(InstancedMesh);
      expect(instance.stats).toMatchObject({
        drawCalls: 1,
        instancedDrawCalls: 1,
        legacyParticleDrawCalls: 0,
      });
    }
  });

  it("renders the default CLI effect (textureless billboard, distanceFarFirst) in one instanced draw", () => {
    // The `nixie-fx effect create` defaults: render.texture null,
    // sortMode "distanceFarFirst", blend alpha, unlit billboards. F12 gives
    // the emitter a procedural shape texture and F13 keeps it instanced.
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: camera(),
    });
    const effect = normalizeParticleEffect({
      ...createDefaultParticleEffect("cli-default", "CLI Default"),
      targetProfile: "three-world-3d",
    });
    expect(effect.emitters[0]!.render.texture).toBeNull();
    expect(effect.emitters[0]!.render.sortMode).toBe("distanceFarFirst");

    const instance = renderer.createEffect(effect);
    for (let i = 0; i < 30; i++) renderer.update(1 / 60);

    expect(instance.stats.visibleParticles).toBeGreaterThan(0);
    expect(instance.stats.instancedDrawCalls).toBeGreaterThanOrEqual(1);
    expect(instance.stats.legacyParticleDrawCalls).toBe(0);
    const mesh = instance.root.children.find(
      (child) => child instanceof InstancedMesh,
    ) as InstancedMesh;
    expect(mesh).toBeInstanceOf(InstancedMesh);
    const material = mesh.material as { uniforms?: Record<string, unknown> };
    expect(
      (material.uniforms?.uTexture as { value: unknown } | undefined)?.value,
    ).toBe(
      getProceduralBillboardTexture(
        effect.emitters[0]!.billboard.shape,
        effect.emitters[0]!.billboard.softness,
      ),
    );
  });

  it("writes distance-sorted instances far-to-near for distanceFarFirst", () => {
    // Three staggered bursts moving +z toward the camera (at z=10): older
    // particles sit closer to the camera. distanceFarFirst must write the
    // youngest (farthest) instance first.
    const makeEffect = (sortMode: "distanceFarFirst" | "distanceNearFirst") => {
      const effect = compatibleEffect({
        count: 1,
        velocity: [0, 0, 1],
        lifetime: 3,
      });
      effect.emitters[0]!.render.sortMode = sortMode;
      effect.emitters[0]!.spawn.bursts = [
        { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
        { time: 0.2, count: 1, cycles: 1, interval: 0, probability: 1 },
        { time: 0.4, count: 1, cycles: 1, interval: 0, probability: 1 },
      ];
      return effect;
    };
    const instanceZ = (mesh: InstancedMesh, index: number): number => {
      const matrix = new Matrix4();
      mesh.getMatrixAt(index, matrix);
      return new Vector3().setFromMatrixPosition(matrix).z;
    };

    const farFirstRenderer = rendererFor(new Texture(), false);
    const farFirst = farFirstRenderer.createEffect(
      makeEffect("distanceFarFirst"),
    );
    for (let i = 0; i < 36; i++) farFirstRenderer.update(1 / 60);
    const farMesh = farFirst.root.children[0] as InstancedMesh;
    expect(farMesh.count).toBe(3);
    // Far-to-near: z (distance to the camera at z=10) increases per instance.
    expect(instanceZ(farMesh, 0)).toBeLessThan(instanceZ(farMesh, 1));
    expect(instanceZ(farMesh, 1)).toBeLessThan(instanceZ(farMesh, 2));

    const nearFirstRenderer = rendererFor(new Texture(), false);
    const nearFirst = nearFirstRenderer.createEffect(
      makeEffect("distanceNearFirst"),
    );
    for (let i = 0; i < 36; i++) nearFirstRenderer.update(1 / 60);
    const nearMesh = nearFirst.root.children[0] as InstancedMesh;
    expect(nearMesh.count).toBe(3);
    expect(instanceZ(nearMesh, 0)).toBeGreaterThan(instanceZ(nearMesh, 1));
    expect(instanceZ(nearMesh, 1)).toBeGreaterThan(instanceZ(nearMesh, 2));
  });

  it("applies position, rotation, and scale around the effect anchor", () => {
    const renderer = rendererFor(new Texture());
    const instance = renderer.createEffect(
      compatibleEffect({ spawnPosition: [1, 0, 0] }),
      {
        position: [10, 5, 0],
        rotation: [0, 0, Math.PI / 2],
        scale: [2, 2, 2],
        seed: 9123,
      },
    );
    renderer.update(1 / 60);
    instance.root.updateMatrixWorld(true);

    const mesh = instance.root.children[0] as InstancedMesh;
    const local = new Matrix4();
    mesh.getMatrixAt(0, local);
    const world = new Matrix4().multiplyMatrices(
      instance.root.matrixWorld,
      local,
    );
    const position = new Vector3().setFromMatrixPosition(world);
    expect(position.x).toBeCloseTo(10, 5);
    expect(position.y).toBeCloseTo(7, 5);
    expect(position.z).toBeCloseTo(0, 5);
  });

  it("updates existing particle motion when velocity intensity changes", () => {
    const renderer = rendererFor(new Texture());
    const instance = renderer.createEffect(
      compatibleEffect({ velocity: [4, 0, 0], lifetime: 3 }),
    );
    renderer.update(0.001);
    renderer.update(0.5);
    expect(instance.getParticleDebugTransforms()[0]!.position[0]).toBeCloseTo(
      2,
    );

    instance.setRuntimeParameters({ initialVelocityMultiplier: 0.25 });
    instance.update(0);
    expect(instance.getParticleDebugTransforms()[0]!.position[0]).toBeCloseTo(
      0.5,
    );
  });

  it("exposes completion, render order, and deterministic replay controls", () => {
    const renderer = rendererFor(new Texture());
    const instance = renderer.createEffect(compatibleEffect(), { seed: 42 });
    renderer.update(1 / 60);
    const mesh = instance.root.children[0] as InstancedMesh;
    instance.setRenderOrder(1400);
    expect(mesh.renderOrder).toBe(1400);

    const first = Array.from(mesh.instanceMatrix.array);
    instance.stop();
    instance.play();
    renderer.update(1 / 60);
    expect(Array.from(mesh.instanceMatrix.array)).toEqual(first);

    instance.allowCompletion();
    renderer.update(3);
    expect(instance.isActive).toBe(false);
  });

  it("restores oldest-first order after lifetime compaction swaps slots", () => {
    const state = new ParticleEmitterRuntimeState(3);
    state.activeCount = 3;
    state.instanceData[3] = 0;
    state.instanceData[7] = 0.1;
    state.instanceData[PARTICLE_INSTANCE_STRIDE + 3] = 0.05;
    state.instanceData[PARTICLE_INSTANCE_STRIDE + 7] = 1;
    state.instanceData[PARTICLE_INSTANCE_STRIDE * 2 + 3] = 0.1;
    state.instanceData[PARTICLE_INSTANCE_STRIDE * 2 + 7] = 1;
    state.compact(0.15);
    expect(state.activeCount).toBe(2);
    expect(state.instanceData[3]).toBeCloseTo(0.1);
    expect(state.instanceData[PARTICLE_INSTANCE_STRIDE + 3]).toBeCloseTo(0.05);

    const order = new Uint32Array(3);
    updateInstancedParticleOrder(state, "oldestFirst", order);
    expect(Array.from(order.slice(0, 2))).toEqual([1, 0]);
  });

  it("orders youngestFirst instances by descending spawn time", () => {
    const state = new ParticleEmitterRuntimeState(3);
    state.activeCount = 3;
    state.instanceData[3] = 0.05;
    state.instanceData[7] = 1;
    state.instanceData[PARTICLE_INSTANCE_STRIDE + 3] = 0.2;
    state.instanceData[PARTICLE_INSTANCE_STRIDE + 7] = 1;
    state.instanceData[PARTICLE_INSTANCE_STRIDE * 2 + 3] = 0.1;
    state.instanceData[PARTICLE_INSTANCE_STRIDE * 2 + 7] = 1;

    const order = new Uint32Array(3);
    updateInstancedParticleOrder(state, "youngestFirst", order);
    expect(Array.from(order)).toEqual([1, 2, 0]);
  });
});
