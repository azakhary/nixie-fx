import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Scene, InstancedMesh, BoxGeometry } from "three";
import { normalizeParticleEffect } from "../../../engine/particles";
import { normalizeShaderGraph } from "../../schema/materials";
import { ThreeVfxRenderer } from "../renderer";
import { createThreeNodeAdapter } from "./adapter";

function graph(type = "constant") {
  return normalizeShaderGraph({
    id: "surface",
    colorVersion: 1,
    blend: "normal",
    nodes: [
      {
        id: "source",
        type,
        params: { value: [0.3, 0.5, 0.7, 1], kind: "color" },
        inputs: {},
      },
    ],
    edges: [
      {
        id: "base",
        source: "source",
        sourceHandle: "out",
        target: "out",
        targetHandle: "baseColor",
      },
    ],
    outputs: { baseColor: "base" },
  });
}
function effect(mesh = false) {
  return normalizeParticleEffect({
    emitters: [
      {
        id: "emitter",
        mode: mesh ? "mesh" : "billboard",
        mesh: { renderMode: "meshAsset", asset: { path: "box.json" } },
        maxParticles: 20,
        spawn: { rate: 10 },
        render: { material: { shaderId: "surface", params: {} } },
      },
    ],
  });
}
for (const mesh of [false, true])
  it(`instances ${mesh ? "mesh" : "billboard"} custom surfaces with shared deterministic CPU preparation`, () => {
    const scene = new Scene(),
      camera = new PerspectiveCamera(),
      g = graph();
    const source = effect(mesh),
      geometry = new BoxGeometry();
    const options = {
      scene,
      camera,
      meshProvider: { getMeshGeometry: () => geometry },
      materialGraphProvider: () => g,
    };
    const legacy = new ThreeVfxRenderer(options),
      nodes = new ThreeVfxRenderer({
        ...options,
        renderAdapter: createThreeNodeAdapter(),
      });
    const a = legacy.createEffect(source, { seed: 123 }),
      b = nodes.createEffect(source, { seed: 123 });
    for (let i = 0; i < 30; i++) {
      legacy.update(1 / 60);
      nodes.update(1 / 60);
    }
    expect(b.stats.activeParticles).toBeGreaterThan(0);
    expect(b.getParticleDebugTransforms()).toEqual(
      a.getParticleDebugTransforms(),
    );
    let instance: InstancedMesh | undefined;
    b.root.traverse((o) => {
      if (o instanceof InstancedMesh) instance = o;
    });
    expect(instance?.count).toBe(b.stats.visibleParticles);
    expect(instance?.geometry.getAttribute("nfxColor").count).toBe(20);
    expect(b.stats.instancedDrawCalls).toBe(1);
    expect(b.stats.legacyParticleDrawCalls).toBe(0);
    legacy.destroy();
    nodes.destroy();
    geometry.dispose();
  });
describe("actionable compatibility failures", () => {
  it("identifies the material and unsupported authored input rather than substituting", () => {
    const renderer = new ThreeVfxRenderer({
      camera: new PerspectiveCamera(),
      renderAdapter: createThreeNodeAdapter(),
      materialGraphProvider: () => graph("particlePosition"),
    });
    expect(() => renderer.createEffect(effect())).toThrow(
      /Material "surface", node "source".*Dynamic Parameter/,
    );
    renderer.destroy();
  });
  it("rejects a missing graph", () => {
    const renderer = new ThreeVfxRenderer({
      camera: new PerspectiveCamera(),
      renderAdapter: createThreeNodeAdapter(),
    });
    expect(() => renderer.createEffect(effect())).toThrow(
      /emitter.render.material.*unavailable/,
    );
    renderer.destroy();
  });
});
