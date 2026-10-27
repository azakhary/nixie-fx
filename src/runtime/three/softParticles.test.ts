import { describe, expect, it, vi } from "vitest";
import {
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
  type WebGLRenderer,
} from "three";
import {
  normalizeParticleEffect,
  normalizeParticleSoftParticles,
} from "../../engine/particles";
import { ThreeVfxRenderer } from "./renderer";
import { ThreeSoftParticleDepth } from "./softParticles";

function fixture(enabled = true) {
  const depth = new ThreeSoftParticleDepth();
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  const vfx = new ThreeVfxRenderer({ scene, camera, softParticles: depth });
  const effect = normalizeParticleEffect({
    emitters: [
      {
        id: "smoke",
        maxParticles: 4,
        spawn: {
          rate: 0,
          bursts: [{ time: 0, count: 1, cycles: 1, probability: 1 }],
        },
        render: { softParticles: { enabled, near: 0.25, far: 1 } },
      },
    ],
  });
  const instance = vfx.createEffect(effect);
  vfx.update(0.1);
  const opaque = new Mesh(undefined, new MeshBasicMaterial());
  const transparent = new Mesh(
    undefined,
    new MeshBasicMaterial({ transparent: true }),
  );
  scene.add(opaque, transparent);
  const state = {
    target: null as unknown,
    viewport: new Vector4(0, 0, 100, 80),
    color: new Color(0x123456),
    alpha: 0.4,
  };
  const host = {
    autoClear: false,
    shadowMap: { autoUpdate: true },
    getRenderTarget: () => state.target,
    setRenderTarget: (t: unknown) => {
      state.target = t;
    },
    getViewport: (v: Vector4) => v.copy(state.viewport),
    setViewport: (v: Vector4) => state.viewport.copy(v),
    getDrawingBufferSize: (v: Vector2) => v.set(200, 160),
    getPixelRatio: () => 2,
    getClearAlpha: () => state.alpha,
    getClearColor: (c: Color) => c.copy(state.color),
    setClearColor: (c: Color | number, a: number) => {
      state.color.set(c);
      state.alpha = a;
    },
    clear: vi.fn(),
    render: vi.fn(),
  };
  return {
    depth,
    scene,
    camera,
    vfx,
    instance,
    effect,
    opaque,
    transparent,
    state,
    host,
    prepare: () =>
      depth.prepare(host as unknown as WebGLRenderer, scene, camera),
  };
}

describe("soft particles", () => {
  it("normalizes absent and unsafe imported ranges without losing the toggle", () => {
    expect(normalizeParticleSoftParticles(undefined)).toEqual({
      enabled: false,
      near: 0,
      far: 1,
    });
    for (const [near, far] of [
      [-1, 1],
      [1, 1],
      [2, 1],
      [NaN, 1],
      [0, Infinity],
      [0, Number.MIN_VALUE],
    ]) {
      expect(
        normalizeParticleSoftParticles({ enabled: true, near, far }),
      ).toEqual({ enabled: true, near: 0, far: 1 });
    }
    expect(
      normalizeParticleSoftParticles({ enabled: true, near: 2, far: 8 }),
    ).toEqual({ enabled: true, near: 2, far: 8 });
  });
  it("performs no feature pass or shader sampling when disabled", () => {
    const f = fixture(false);
    f.prepare();
    expect(f.host.render).not.toHaveBeenCalled();
    f.instance.root.traverse((o) => {
      if (o instanceof Mesh && o.material instanceof ShaderMaterial)
        expect(o.material.fragmentShader).not.toContain("nfxSceneDepth");
    });
    f.vfx.destroy();
    f.depth.dispose();
  });
  it("captures opaque geometry only, restores host state, skips hidden/disposed effects", () => {
    const f = fixture();
    f.host.render.mockImplementation(() => {
      expect(f.instance.root.visible).toBe(false);
      expect(f.opaque.material.visible).toBe(true);
      expect(f.transparent.material.visible).toBe(false);
    });
    f.prepare();
    expect(f.depth.stats.passes).toBe(1);
    expect(f.depth.uniforms.nfxDepthViewport.value.toArray()).toEqual([
      0, 0, 200, 160,
    ]);
    expect(f.state.target).toBe(null);
    expect(f.state.color.getHex()).toBe(0x123456);
    expect(f.host.autoClear).toBe(false);
    expect(f.transparent.material.visible).toBe(true);
    f.instance.root.visible = false;
    f.prepare();
    expect(f.depth.stats.passes).toBe(0);
    f.instance.root.visible = true;
    f.host.render.mockImplementation(() => {
      throw Error("test GPU failure");
    });
    expect(f.prepare).toThrow("test GPU failure");
    expect(f.instance.root.visible).toBe(true);
    expect(f.transparent.material.visible).toBe(true);
    expect(f.state.target).toBe(null);
    f.vfx.destroy();
    f.prepare();
    expect(f.depth.stats.activeMeshes).toBe(0);
    f.depth.dispose();
  });
  it("rebuilds only the edited emitter and preserves fade after definition updates", () => {
    const f = fixture();
    f.effect.emitters.push({
      ...structuredClone(f.effect.emitters[0]!),
      id: "other",
      render: {
        ...structuredClone(f.effect.emitters[0]!.render),
        softParticles: { enabled: false, near: 0, far: 1 },
      },
    });
    f.instance.updateDefinition(f.effect);
    f.vfx.update(0.1);
    f.prepare();
    expect(f.depth.stats.activeMeshes).toBe(1);
    f.effect.emitters[0]!.render.softParticles.enabled = false;
    f.instance.updateDefinition(f.effect);
    f.vfx.update(0);
    f.prepare();
    expect(f.depth.stats.passes).toBe(0);
    f.vfx.destroy();
    f.depth.dispose();
  });
});
