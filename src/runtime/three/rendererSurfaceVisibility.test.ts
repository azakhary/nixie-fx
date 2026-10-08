import { Mesh, PerspectiveCamera, Scene, ShaderMaterial, Vector4 } from "three";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import {
  createMaterialInstance,
  createSpriteMasterGraph,
} from "../schema/materials";
import { ThreeVfxRenderer } from "./renderer";

function carrierEffect() {
  return normalizeParticleEffect({
    emitters: [
      {
        id: "carrier",
        maxParticles: 4,
        duration: 1,
        loop: false,
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
        },
        modules: { velocity: true, color: false },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          velocity: { mode: "vector", min: [2, 0, 0], max: [2, 0, 0] },
          color: { color: [1, 0.2, 0, 1] },
        },
        forces: {
          gravityValue: { mode: "constant", value: 0 },
          dragValue: { mode: "constant", value: 0 },
        },
      },
    ],
  });
}

function updateSeveralFrames(renderer: ThreeVfxRenderer) {
  for (let frame = 0; frame < 5; frame++) renderer.update(1 / 60);
}

describe("Three particle surface visibility", () => {
  it("keeps an alpha-zero carrier alive and its independent trail colored without surface draws", () => {
    const graph = createSpriteMasterGraph();
    const hidden = createMaterialInstance(graph, "hidden");
    hidden.paramOverrides.Tint = [1, 0, 0, 0];
    const trailMaterial = createMaterialInstance(graph, "trail");
    trailMaterial.paramOverrides.Tint = [0, 1, 1, 1];
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: new PerspectiveCamera(),
      materialGraphProvider: () => graph,
    });
    const definition = carrierEffect();
    const emitter = definition.emitters[0]!;
    emitter.render.material = hidden;
    emitter.modules.trails = true;
    emitter.advanced.trails.material = trailMaterial;
    emitter.advanced.trails.inheritColor = false;
    emitter.advanced.trails.minVertexDistance = 0.001;
    const instance = renderer.createEffect(definition);
    updateSeveralFrames(renderer);

    expect(instance.stats.activeParticles).toBe(1);
    expect(instance.stats.visibleParticles).toBe(0);
    expect(instance.stats.legacyParticleDrawCalls).toBe(0);
    expect(instance.stats.drawCalls).toBe(1);
    const visibleMeshes = instance.root.children.filter(
      (child): child is Mesh => child instanceof Mesh && child.visible,
    );
    expect(visibleMeshes).toHaveLength(1);
    const colors = visibleMeshes[0]!.geometry.getAttribute("color");
    expect(colors.count).toBeGreaterThan(2);
    expect(colors.getY(0)).toBeGreaterThan(0);
    expect(colors.getZ(0)).toBeGreaterThan(0);
    expect(colors.getW(0)).toBeGreaterThan(0);
    renderer.destroy();
  });

  it.each(["unlit", "lit"] as const)(
    "removes a %s surface after its host alpha reaches zero",
    (shading) => {
      const renderer = new ThreeVfxRenderer({
        scene: new Scene(),
        camera: new PerspectiveCamera(),
      });
      const definition = carrierEffect();
      definition.emitters[0]!.render.shading = shading;
      const instance = renderer.createEffect(definition);
      updateSeveralFrames(renderer);
      expect(instance.stats.drawCalls).toBe(1);
      instance.setEmitterRuntimeParameters("carrier", {
        colorTint: [1, 1, 1, 0],
      });
      renderer.update(1 / 60);
      expect(instance.stats.activeParticles).toBe(1);
      expect(instance.stats.visibleParticles).toBe(0);
      expect(instance.stats.drawCalls).toBe(0);
      expect(
        instance.root.children.filter(
          (child) => child.visible && child instanceof Mesh,
        ),
      ).toHaveLength(0);
      renderer.destroy();
    },
  );

  it("does not cull custom shaders that ignore particle alpha", () => {
    const material = new ShaderMaterial({
      uniforms: { uParticleColor: { value: new Vector4(1, 1, 1, 1) } },
      vertexShader:
        "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "void main() { gl_FragColor = vec4(1.0); }",
    });
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: new PerspectiveCamera(),
      materialProvider: { getParticleMaterial: () => material },
    });
    const instance = renderer.createEffect(carrierEffect());
    instance.setEmitterRuntimeParameters("carrier", {
      colorTint: [1, 1, 1, 0],
    });
    updateSeveralFrames(renderer);
    expect(instance.stats.activeParticles).toBe(1);
    expect(instance.stats.visibleParticles).toBe(1);
    expect(instance.stats.drawCalls).toBe(1);
    renderer.destroy();
    material.dispose();
  });

  it("does not cull material-authoritative opaque surfaces at zero particle alpha", () => {
    const graph = createSpriteMasterGraph();
    graph.blend = "opaque";
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: new PerspectiveCamera(),
      materialGraphProvider: () => graph,
    });
    const definition = carrierEffect();
    definition.emitters[0]!.render.material = createMaterialInstance(
      graph,
      "opaque",
    );
    const instance = renderer.createEffect(definition);
    instance.setEmitterRuntimeParameters("carrier", {
      colorTint: [1, 1, 1, 0],
    });
    updateSeveralFrames(renderer);
    expect(instance.stats.drawCalls).toBe(1);
    renderer.destroy();
  });
});
