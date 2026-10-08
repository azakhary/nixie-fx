import {
  BufferGeometry,
  BufferAttribute,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import { createEmitterView, destroyEmitterView } from "./emitterView";
import { updateThreeTrailHistory } from "./particleTrailHistory";
import type { ParticleSample } from "./rendererState";
import {
  clearThreeTrailView,
  drawThreeTrailView,
  type ThreeTrailView,
  type ThreeTrailPoint,
} from "./trailGeometry";

function point(y: number): ThreeTrailPoint {
  return {
    position: new Vector3(0, y, 0),
    timeSeconds: 0,
    lifetimeSeconds: 10,
    distanceFromHead: 0,
    color: [1, 0.5, 0],
    alpha: 1,
    width: 0.2,
    seed: 0.1,
    dynamicParams: null,
  };
}
function fixture() {
  const geometry = new BufferGeometry();
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  const view: ThreeTrailView = {
    trailMesh: mesh,
    trailGeometry: geometry,
    trailMaterial: material,
    trailResolution: null,
    trailTextureFrames: null,
    trailEmitterPosition: [0, 0, 0],
    trailHistories: new Map(),
  };
  const emitter = normalizeParticleEffect({
    emitters: [{ modules: { trails: true } }],
  }).emitters[0]!;
  const camera = new PerspectiveCamera();
  camera.position.z = 10;
  const draw = () => drawThreeTrailView(view, emitter, camera, 0.1, [0, 0, 0]);
  return { view, geometry, material, draw };
}

describe("retained Three trail geometry", () => {
  it("keeps attribute identities and limits draws to live indices when trails shrink and clear", () => {
    const { view, geometry, material, draw } = fixture();
    const points = Array.from({ length: 10 }, (_, i) => point(i));
    view.trailHistories.set("one", { points, lastSeenFrame: 0 });
    draw();
    const position = geometry.getAttribute("position") as BufferAttribute;
    const color = geometry.getAttribute("color");
    const index = geometry.getIndex();
    const firstRange = geometry.drawRange.count;
    expect(firstRange).toBeGreaterThan(6);
    const version = position.version;
    points.length = 3;
    draw();
    expect(geometry.getAttribute("position")).toBe(position);
    expect(geometry.getAttribute("color")).toBe(color);
    expect(geometry.getIndex()).toBe(index);
    expect(position.version).toBeGreaterThan(version);
    expect(geometry.drawRange.count).toBe(6);
    expect(geometry.drawRange.count).toBeLessThan(firstRange);
    expect(geometry.boundingSphere!.center.y).toBeCloseTo(1.5);
    clearThreeTrailView(view);
    expect(geometry.drawRange.count).toBe(0);
    expect(view.trailMesh.visible).toBe(false);
    expect(geometry.getAttribute("position")).toBe(position);
    expect(view.trailPointPool).toHaveLength(3);
    view.trailHistories.set("two", {
      points: [point(0), point(1), point(2)],
      lastSeenFrame: 0,
    });
    draw();
    expect(geometry.getAttribute("position")).toBe(position);
    expect(geometry.drawRange.count).toBe(6);
    geometry.dispose();
    material.dispose();
  });

  it("grows geometrically and releases old GPU bindings only on growth", () => {
    const { view, geometry, material, draw } = fixture();
    const points = [point(0), point(1), point(2)];
    view.trailHistories.set("one", { points, lastSeenFrame: 0 });
    let disposals = 0;
    geometry.addEventListener("dispose", () => disposals++);
    draw();
    const first = geometry.getAttribute("position");
    expect(first.count).toBe(64);
    for (let i = 3; i < 40; i++) points.push(point(i));
    draw();
    const grown = geometry.getAttribute("position");
    expect(grown).not.toBe(first);
    expect(grown.count).toBe(128);
    expect(disposals).toBe(1);
    expect(geometry.drawRange.count).toBe((40 - 2) * 6);
    draw();
    expect(geometry.getAttribute("position")).toBe(grown);
    expect(disposals).toBe(1);
    for (let i = 0; i < geometry.drawRange.count; i++) {
      expect(geometry.getIndex()!.getX(i)).toBeLessThan(78);
    }
    geometry.dispose();
    material.dispose();
  });

  it("updates history points in place and recycles expired point objects", () => {
    const effect = normalizeParticleEffect({
      emitters: [
        {
          id: "trail",
          modules: { trails: true },
          advanced: {
            trails: {
              minVertexDistance: 0.5,
              lifetime: { mode: "constant", value: 0.01 },
            },
          },
        },
      ],
    });
    const emitter = effect.emitters[0]!;
    const view = createEmitterView(
      emitter,
      { effect, camera: new PerspectiveCamera() },
      { effect, renderGeometryOverride: null },
    );
    const sample: ParticleSample = {
      visible: true,
      position: [0, 0, 0],
      velocity: [0, 1, 0],
      speed: 1,
      normalizedAge: 0,
      loopAge: 0,
      start: 0,
      seed: 0.1,
      width: 1,
      height: 1,
      depthScale: 1,
      depth: 0,
      rotation: [0, 0, 0],
      color: new Color(1, 0.5, 0),
      shaderColor: [1, 0.5, 0],
      trailColor: [1, 0.5, 0, 1],
      alpha: 1,
      alignmentAxis: new Vector3(0, 1, 0),
      normal: new Vector3(0, 0, 1),
      emissiveStrength: 0,
      textureFrameIndex: 0,
    };
    updateThreeTrailHistory(view, emitter, sample, 0);
    const history = view.trailHistories.values().next().value!;
    const first = history.points[0]!;
    const position = first.position,
      color = first.color;
    sample.position[1] = 0.1;
    updateThreeTrailHistory(view, emitter, sample, 0.005);
    expect(history.points[0]).toBe(first);
    expect(first.position).toBe(position);
    expect(first.color).toBe(color);
    expect(first.position.y).toBe(0.1);
    sample.position[1] = 1;
    updateThreeTrailHistory(view, emitter, sample, 0.02);
    expect(view.trailPointPool).toContain(first);
    sample.position[1] = 2;
    updateThreeTrailHistory(view, emitter, sample, 0.04);
    expect(history.points[history.points.length - 1]).toBe(first);
    expect(first.position.y).toBe(2);
    destroyEmitterView(view);
  });
});
