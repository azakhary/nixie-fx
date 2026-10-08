import { Mesh, PerspectiveCamera, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import { ThreeVfxRenderer } from "./renderer";

function setup(worldSpace = true, velocity = 0) {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
  const effect = renderer.createEffect(
    normalizeParticleEffect({
      id: "attached-trail",
      targetProfile: "three-world-3d",
      emitters: [
        {
          id: "carrier",
          loop: false,
          duration: 4,
          maxParticles: 1,
          modules: { trails: true, velocity: false, noise: false },
          spawn: {
            rate: 0,
            rateValue: { mode: "constant", value: 0 },
            shape: "point",
            simulationSpace: "local",
            bursts: [
              { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
            ],
          },
          initializeParticle: {
            lifetime: { mode: "constant", value: 3 },
            velocity: {
              mode: "vector",
              min: [velocity, 0, 0],
              max: [velocity, 0, 0],
            },
          },
          advanced: {
            trails: {
              worldSpace,
              minVertexDistance: 0.001,
              width: { mode: "constant", value: 0.1 },
              lifetime: { mode: "constant", value: 2 },
            },
          },
        },
      ],
    }),
    { seed: 42 },
  );
  function centers() {
    effect.root.updateMatrixWorld(true);
    const points: Vector3[] = [];
    effect.root.traverse((object) => {
      if (!(object instanceof Mesh) || !object.visible) return;
      const p = object.geometry.getAttribute("position");
      if (!p || object.geometry.getAttribute("color")?.itemSize !== 4) return;
      for (let i = 0; i < p.count; i += 2) {
        points.push(
          new Vector3()
            .fromBufferAttribute(p, i)
            .add(new Vector3().fromBufferAttribute(p, i + 1))
            .multiplyScalar(0.5)
            .applyMatrix4(object.matrixWorld),
        );
      }
    });
    return points;
  }
  return { renderer, effect, centers };
}

describe("attached Three history trails", () => {
  it.each([
    [0, 0, 0],
    [2, -3, 1],
  ])("keeps the path fixed when moving from %j", (x, y, z) => {
    const h = setup();
    const path = [0, 1 / 3, 2 / 3, 1].map(
      (t) => new Vector3(x + 0.75 * t, y, z),
    );
    for (const p of path) {
      h.effect.setTransform({ position: p.toArray() });
      h.renderer.update(1 / 60);
    }
    const actual = h.centers();
    expect(actual).toHaveLength(path.length);
    for (let i = 0; i < actual.length; i++)
      expect(actual[i]!.distanceTo(path[i]!)).toBeLessThan(1e-5);
    h.renderer.destroy();
  });

  it("preserves local-space history following the translated emitter", () => {
    const still = setup(false, 1),
      moving = setup(false, 1);
    for (let i = 0; i < 4; i++) {
      still.renderer.update(1 / 60);
      moving.effect.setTransform({ position: [i * 0.25, 0, 0] });
      moving.renderer.update(1 / 60);
    }
    const expected = still.centers().map((p) => p.add(new Vector3(0.75, 0, 0)));
    const actual = moving.centers();
    expect(actual.length).toBeGreaterThan(1);
    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < actual.length; i++)
      expect(actual[i]!.distanceTo(expected[i]!)).toBeLessThan(1e-5);
    still.renderer.destroy();
    moving.renderer.destroy();
  });

  it("clears the previous path when restarting at a new position", () => {
    const h = setup();
    for (let i = 0; i < 4; i++) {
      h.effect.setTransform({ position: [i * 0.25, 0, 0] });
      h.renderer.update(1 / 60);
    }
    expect(h.centers().length).toBeGreaterThan(1);
    h.effect.setTransform({ position: [5, 0, 0] });
    h.effect.restart();
    h.renderer.update(1 / 60);
    expect(h.centers()).toHaveLength(0);
    h.effect.setTransform({ position: [5.25, 0, 0] });
    h.renderer.update(1 / 60);
    const points = h.centers();
    expect(points).toHaveLength(2);
    expect(points[0]!.x).toBeCloseTo(5);
    expect(points[1]!.x).toBeCloseTo(5.25);
    h.renderer.destroy();
  });
});
