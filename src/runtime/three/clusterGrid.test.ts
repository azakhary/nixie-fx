import { normalizeParticleEffect } from "../../engine/particles";
import { ThreeVfxRenderer } from "./renderer";
import { describe, expect, it } from "vitest";
import {
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Scene,
} from "three";
import { ThreeLightClusterGrid, THREE_CLUSTER_LIMITS } from "./clusterGrid";
import { ThreeVfxLightManager, type ThreeVfxClusterBackend } from "./vfxLights";
import type { VfxLightCandidate } from "../lights/candidates";
const light = (
  id: string,
  position: [number, number, number] = [0, 0, -5],
  radius = 2,
): VfxLightCandidate => ({
  id,
  position,
  radius,
  intensity: 2,
  color: [1, 0.5, 0.1],
});
const slot = (candidate: VfxLightCandidate) => ({
  candidate,
  gain: 1,
  retiring: false,
});
function backend(): ThreeVfxClusterBackend {
  const grid = new ThreeLightClusterGrid();
  return {
    supported: true,
    reason: "",
    stats: grid.stats,
    clear: () => grid.clear(),
    update: (slots, camera, cap) => grid.update(slots, camera, cap),
  };
}
describe("bounded influence-volume clusters", () => {
  for (const camera of [
    new PerspectiveCamera(60, 1, 0.1, 100),
    new OrthographicCamera(-3, 3, 3, -3, 0.1, 100),
  ]) {
    it(`keeps offscreen sources whose range intersects visible geometry (${camera.type})`, () => {
      const grid = new ThreeLightClusterGrid();
      grid.update([slot(light("offscreen", [4, 0, -5], 3))], camera, 16);
      expect(grid.stats.contributingLights).toBe(1);
      expect(grid.indices.some((v) => v === 1)).toBe(true);
      grid.update([slot(light("outside", [100, 0, -5], 1))], camera, 16);
      expect(grid.stats.culledLights).toBe(1);
      expect(grid.indices.every((v) => v === 0)).toBe(true);
    });
  }
  it("keeps near-plane-crossing spheres and explains stable bounded crowded overflow", () => {
    const grid = new ThreeLightClusterGrid(),
      camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const slots = [
      slot(light("b", [0, 0, 0], 10)),
      slot(light("a", [0, 0, 0], 10)),
      slot(light("c", [0, 0, 0], 10)),
    ];
    const buffers = [grid.indices.buffer, grid.lightData.buffer];
    grid.update(slots, camera, 1);
    expect(grid.stats.overflowAssignments).toBe(
      grid.stats.overflowClusters * 2,
    );
    expect(grid.stats.overflowLights).toBe(2);
    expect(grid.stats.maxOccupancy).toBe(3);
    expect(grid.stats.contributingLights).toBe(1);
    expect(
      [...grid.indices]
        .filter(Boolean)
        .every((v) => slots[v - 1]!.candidate.id === "a"),
    ).toBe(true);
    grid.update(slots.reverse(), camera, 1);
    expect(
      [...grid.indices]
        .filter(Boolean)
        .every((v) => slots[v - 1]!.candidate.id === "a"),
    ).toBe(true);
    expect([grid.indices.buffer, grid.lightData.buffer]).toEqual(buffers);
    grid.clear();
    expect(grid.indices.every((v) => v === 0)).toBe(true);
  });
  it("omits an overflowing light over its whole influence instead of cutting surfaces at cell edges", () => {
    const camera = new OrthographicCamera(-3, 3, 3, -3, 0.1, 100);
    const grid = new ThreeLightClusterGrid();
    const a = slot(light("a", [-1, 0, -5], 1));
    const b = slot(light("b", [0, 0, -5], 1));
    const c = slot(light("c", [2.5, 0, -5], 0.2));
    grid.update([b], camera, 1);
    expect(grid.indices.some(Boolean)).toBe(true);
    grid.update([a, b, c], camera, 1);
    expect(grid.indices.some((index) => index === 2)).toBe(false);
    expect(grid.indices.some((index) => index === 1)).toBe(true);
    expect(grid.indices.some((index) => index === 3)).toBe(true);
    expect(grid.stats.overflowLights).toBe(1);
    expect(grid.stats.contributingLights).toBe(2);
    grid.update([c, b, a], camera, 1);
    expect(grid.indices.some((index) => index === 2)).toBe(false);
    grid.update([a, b, c], camera, 2);
    expect(grid.indices.some((index) => index === 2)).toBe(true);
    expect(grid.stats.overflowLights).toBe(0);
  });
  it("reports invalid cameras without using stale cluster contents", () => {
    const grid = new ThreeLightClusterGrid(),
      camera = new PerspectiveCamera();
    camera.far = Infinity;
    expect(grid.update([slot(light("a"))], camera, 16)).toBe(false);
    expect(grid.indices.every((v) => v === 0)).toBe(true);
  });
});
describe("clustered shared-manager contract", () => {
  it("reserves scene lights, separates invalid ranges and budget overflow, retains game lights", () => {
    const scene = new Scene(),
      camera = new PerspectiveCamera(60, 1, 0.1, 100),
      game = new PointLight(0xff0000, 3);
    scene.add(game);
    const manager = ThreeVfxLightManager.forScene(scene),
      clustered = backend();
    manager.setClusterBackend(clustered);
    manager.setProfile({
      mode: "clustered",
      maxLights: 16,
      totalSceneLights: 4,
      maxLightsPerCluster: 1,
    });
    const producer = {
      lightRevision: 0,
      lightsPaused: false,
      getLightCandidates: () => [
        ...Array.from({ length: 10 }, (_, i) => light(String(i))),
        light("bad", [0, 0, -5], Infinity),
        light("away", [100, 0, -5]),
      ],
    };
    manager.add(producer);
    manager.update(1, camera);
    expect(manager.stats).toMatchObject({
      mode: "clustered",
      active: 3,
      budget: 3,
      sceneLights: 1,
      candidates: 12,
      invalidRanges: 1,
      frustumCulled: 1,
      budgetRejected: 7,
      budgetReduction: 13,
    });
    expect(manager.stats.overflowAssignments).toBeGreaterThan(0);
    expect(scene.children.filter((o) => o instanceof PointLight)).toEqual([
      game,
    ]);
    manager.remove(producer);
    expect(manager.stats.active).toBe(0);
    expect(clustered.stats.contributingLights).toBe(0);
    manager.setBudget(2);
    manager.dispose();
    expect(game.parent).toBe(scene);
    expect(game.intensity).toBe(3);
  });
  it("bounds requested capacities, smoothly fills new slots, and rejects false WebGL support", () => {
    const scene = new Scene(),
      camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const manager = new ThreeVfxLightManager(scene, 0);
    manager.setProfile({
      mode: "clustered",
      maxLights: Infinity,
      totalSceneLights: 99999,
      maxLightsPerCluster: 99999,
    });
    expect(manager.stats).toMatchObject({
      mode: "small",
      requestedMode: "clustered",
      supported: false,
      requestedBudget: 0,
      perClusterCapacity: 64,
      totalSceneCapacity: 512,
    });
    manager.setClusterBackend(backend());
    manager.setProfile({
      mode: "clustered",
      maxLights: 20,
      totalSceneLights: 20,
      maxLightsPerCluster: 16,
    });
    manager.add({
      lightRevision: 0,
      lightsPaused: false,
      getLightCandidates: () =>
        Array.from({ length: 30 }, (_, i) => light(String(i))),
    });
    manager.update(1, camera);
    manager.setProfile({
      mode: "clustered",
      maxLights: 25,
      totalSceneLights: 25,
      maxLightsPerCluster: 16,
    });
    manager.update(0.01, camera);
    expect(manager.stats).toMatchObject({ active: 25, fading: 5 });
    manager.setProfile({
      mode: "clustered",
      maxLights: 2,
      totalSceneLights: 2,
      maxLightsPerCluster: 1,
    });
    manager.update(0.01, camera);
    expect(manager.stats.active).toBeLessThanOrEqual(2);
    expect(manager.stats.active).toBeLessThanOrEqual(
      THREE_CLUSTER_LIMITS.lights,
    );
    manager.dispose();
  });
});

it("keeps real instance pause, seek, visibility and disposal behavior in clustered mode", () => {
  const scene = new Scene(),
    camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const manager = new ThreeVfxLightManager(scene),
    clusters = backend();
  manager.setClusterBackend(clusters);
  manager.setProfile({
    mode: "clustered",
    maxLights: 32,
    totalSceneLights: 32,
    maxLightsPerCluster: 16,
  });
  const host = new ThreeVfxRenderer({ scene, camera });
  const effect = normalizeParticleEffect({
    emitters: [
      {
        id: "sparks",
        maxParticles: 40,
        spawn: { position: [0, 0, -5], rate: 20 },
        lightEmission: {
          version: 1,
          mode: "particles",
          radius: { mode: "constant", value: 2 },
        },
      },
    ],
  });
  const a = host.createEffect(effect),
    b = host.createEffect(effect, { position: [1, 0, 0] });
  manager.add(a);
  manager.add(b);
  host.update(0.2);
  manager.update(0.2, camera);
  expect(manager.stats.active).toBeGreaterThan(0);
  const frozen = structuredClone(a.getLightCandidates());
  a.pause();
  host.update(0.1);
  manager.update(0.1, camera);
  expect(a.getLightCandidates()).toEqual(frozen);
  a.setVisible(false);
  host.removeEffect(b, true);
  manager.update(0, camera);
  expect(manager.stats.active).toBe(0);
  expect(clusters.stats.contributingLights).toBe(0);
  a.setVisible(true);
  a.restart();
  host.update(0.2);
  manager.update(0.2, camera);
  expect(manager.stats.active).toBeGreaterThan(0);
  a.seek(0);
  manager.update(0, camera);
  expect(manager.stats.active).toBe(0);
  manager.dispose();
  host.destroy();
});
