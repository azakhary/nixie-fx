import {
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import {
  createConstantParticleScalar,
  normalizeParticleEffect,
  normalizeParticleScalarValue,
} from "../engine/particles";
import type { ParticleSample } from "./three/rendererState";
import type { ThreeTrailView } from "./three/trailGeometry";
import {
  beginThreeUnityTrails,
  drawThreeUnityTrailView,
  updateThreeUnityTrail,
} from "./three/unityTrailGeometry";
import { UnityTrailHistory, UnityTrailSet } from "./unityTrail";

function unityEmitter(trails: Record<string, unknown> = {}) {
  return normalizeParticleEffect({
    emitters: [
      {
        modules: { trails: true },
        advanced: {
          trails: {
            model: "unity",
            lifetime: createConstantParticleScalar(0.5, 0, 1),
            width: createConstantParticleScalar(1, 0, 4),
            minVertexDistance: 0.15,
            ...trails,
          },
        },
      },
    ],
  }).emitters[0]!;
}

describe("Unity trail history", () => {
  it("commits by distance from the last committed point, not from the moving head", () => {
    const history = new UnityTrailHistory();
    history.pointLifetime = 10;
    // 0.1 per frame < minVertexDistance 0.15: the legacy drift would never commit.
    for (let frame = 0; frame <= 6; frame++) {
      history.head.set([frame * 0.1, 0, 0]);
      history.commit(frame / 60, 0.15);
    }
    // Commits at x = 0, 0.2, 0.4, 0.6.
    expect(history.pointCount).toBe(4);
    const centers = new Float32Array(32);
    expect(history.sampleCenters(6 / 60, centers)).toBe(5);
    expect(
      Array.from(centers.subarray(0, 15))
        .filter((_, i) => i % 3 === 0)
        .map((x) => Math.round(x * 10) / 10),
    ).toEqual([0.6, 0.6, 0.4, 0.2, 0]);
  });

  it("clips the oldest segment continuously at the point lifetime", () => {
    const history = new UnityTrailHistory();
    history.pointLifetime = 1;
    history.head.set([0, 0, 0]);
    history.commit(0, 0.1);
    history.head.set([1, 0, 0]);
    history.commit(1, 0.1);
    history.head.set([1.5, 0, 0]);
    const centers = new Float32Array(32);
    // cutoff = 0.5: halfway between the t=0 point (x=0) and the t=1 point (x=1).
    expect(history.sampleCenters(1.5, centers)).toBe(3);
    expect(centers[3]).toBeCloseTo(1, 6);
    expect(centers[6]).toBeCloseTo(0.5, 6);
  });

  it("scales point lifetime by particle lifetime and keeps or drops dead trails", () => {
    const keep = unityEmitter({ dieWithParticles: false });
    const set = new UnityTrailSet();
    set.begin(1);
    set.touch(
      keep.advanced.trails,
      7,
      0,
      0,
      0,
      0,
      3,
      0.2,
      0,
      0.1,
      0.04,
      1,
      1,
      1,
      1,
    );
    expect(set.trails.get(7)!.pointLifetime).toBeCloseTo(1.5, 6);
    expect(set.trails.get(7)!.width).toBeCloseTo(0.04, 6);
    set.end(keep.advanced.trails, 0);
    set.begin(1);
    set.end(keep.advanced.trails, 0.1);
    expect(set.trails.get(7)?.alive).toBe(false);
    expect(set.trails.get(7)?.normalizedAge).toBe(1);
    const die = unityEmitter({ dieWithParticles: true });
    set.begin(1);
    set.touch(
      die.advanced.trails,
      8,
      0,
      0,
      0,
      0.2,
      3,
      0.2,
      0,
      0.1,
      0.04,
      1,
      1,
      1,
      1,
    );
    set.end(die.advanced.trails, 0.2);
    set.begin(1);
    set.end(die.advanced.trails, 0.3);
    expect(set.trails.has(8)).toBe(false);
    set.begin(2);
    expect(set.trails.size).toBe(0);
  });
});

function sample(x: number, normalizedAge: number): ParticleSample {
  return {
    particleId: 1,
    generation: 1,
    lifetime: 2,
    visible: true,
    position: [x, 0, 0],
    velocity: [1, 0, 0],
    speed: 1,
    normalizedAge,
    loopAge: 0,
    start: 0,
    seed: 0.1,
    width: 0.1,
    height: 0.1,
    depthScale: 1,
    depth: 0,
    rotation: [0, 0, 0],
    color: new Color(1, 1, 1),
    shaderColor: [1, 1, 1],
    lightColor: [1, 1, 1, 1],
    trailColor: [1, 1, 1, 1],
    alpha: 1,
    alignmentAxis: new Vector3(0, 1, 0),
    normal: new Vector3(0, 0, 1),
    emissiveStrength: 0,
    textureFrameIndex: 0,
  };
}

describe("Three Unity trail geometry", () => {
  it("samples width and alpha by head-to-tail distance and particle age, without implicit fades", () => {
    const emitter = unityEmitter({
      widthOverTrail: normalizeParticleScalarValue(
        {
          mode: "curve",
          curve: [
            { x: 0, y: 0, slope: 0 },
            { x: 0.5, y: 1, slope: 0 },
            { x: 1, y: 0, slope: 0 },
          ],
        },
        1,
        0,
        1,
      ),
    });
    const geometry = new BufferGeometry();
    const material = new MeshBasicMaterial();
    const view: ThreeTrailView = {
      trailMesh: new Mesh(geometry, material),
      trailGeometry: geometry,
      trailMaterial: material,
      trailResolution: null,
      trailTextureFrames: null,
      trailEmitterPosition: [0, 0, 0],
      trailHistories: new Map(),
    };
    const camera = new OrthographicCamera();
    camera.position.set(0, 0, 10);
    for (let frame = 0; frame <= 10; frame++) {
      beginThreeUnityTrails(view, 1);
      updateThreeUnityTrail(
        view,
        emitter,
        sample(frame * 0.2, frame / 40),
        frame / 60,
      );
      drawThreeUnityTrailView(view, emitter, camera, frame / 60, [0, 0, 0]);
    }
    const position = geometry.getAttribute("position");
    const color = geometry.getAttribute("color");
    const uv = geometry.getAttribute("uv");
    expect(view.trailMesh.visible).toBe(true);
    // Head (t=0) and tail (t=1) are zero width; alpha is full (white gradients).
    expect(Math.abs(position.getY(0) - position.getY(1))).toBeCloseTo(0, 6);
    expect(color.getW(0)).toBeCloseTo(1, 6);
    expect(uv.getX(0)).toBe(0);
    const pairs = geometry.drawRange.count / 6 + 1;
    expect(uv.getX((pairs - 1) * 2)).toBeCloseTo(1, 6);
    // Middle of the ribbon reaches the authored width (size 0.1 × width 1).
    let widest = 0;
    for (let i = 0; i < pairs; i++)
      widest = Math.max(
        widest,
        Math.abs(position.getY(i * 2) - position.getY(i * 2 + 1)),
      );
    expect(widest).toBeGreaterThan(0.09);
    expect(widest).toBeLessThanOrEqual(0.1 + 1e-6);
  });
});
