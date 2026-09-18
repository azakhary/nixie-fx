import {
  NoColorSpace,
  PerspectiveCamera,
  RepeatWrapping,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
} from "three";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import {
  createMaterialInstance,
  normalizeShaderGraph,
} from "../schema/materials";
import { createThreeEmitterMaterial } from "./materialAdapter";

function smoothstepGraph(texturePath: string) {
  return normalizeShaderGraph({
    id: "smoothstep-texture",
    name: "Smoothstep texture",
    blend: "normal",
    nodes: [
      {
        id: "tex",
        type: "textureSample",
        inputs: {},
        params: { tex: texturePath },
      },
      {
        id: "smooth",
        type: "smoothstep",
        inputs: { in: "sample" },
        params: { edge0: 0, edge1: 0.1 },
      },
      { id: "particle", type: "particleColor", inputs: {}, params: {} },
      {
        id: "mul",
        type: "multiply",
        inputs: { a: "color", b: "mask" },
        params: {},
      },
    ],
    edges: [
      {
        id: "sample",
        source: "tex",
        sourceHandle: "R",
        target: "smooth",
        targetHandle: "in",
      },
      {
        id: "color",
        source: "particle",
        sourceHandle: "RGB",
        target: "mul",
        targetHandle: "a",
      },
      {
        id: "mask",
        source: "smooth",
        sourceHandle: "Out",
        target: "mul",
        targetHandle: "b",
      },
      {
        id: "base",
        source: "mul",
        sourceHandle: "Out",
        target: "output",
        targetHandle: "baseColor",
      },
      {
        id: "opacity",
        source: "mul",
        sourceHandle: "Out",
        target: "output",
        targetHandle: "opacity",
      },
    ],
    outputs: { baseColor: "base", opacity: "opacity" },
  });
}

describe("Three graph texture sampling", () => {
  it.each(["", "textures/noise.png"])(
    "samples raw channels through Smoothstep (node path: %s)",
    (nodePath) => {
      const source = new Texture({ width: 2, height: 2 });
      source.colorSpace = SRGBColorSpace;
      source.wrapS = RepeatWrapping;
      source.flipY = false;
      const graph = smoothstepGraph(nodePath);
      const instance = createMaterialInstance(graph, "test");
      instance.mainTex = {
        type: "texture",
        id: "noise",
        path: "textures/main.png",
      };
      const effect = normalizeParticleEffect({
        emitters: [{ render: { material: instance } }],
      });
      const resolution = createThreeEmitterMaterial(effect.emitters[0]!, {
        effect,
        camera: new PerspectiveCamera(),
        textureProvider: { getTexture: () => source },
        materialGraphProvider: () => graph,
      });
      expect(resolution.material).toBeInstanceOf(ShaderMaterial);
      const material = resolution.material as ShaderMaterial;
      expect(material.fragmentShader).toContain("smoothstep(");
      const sampled = material.uniforms.uTexture!.value as Texture;
      expect(sampled.colorSpace).toBe(NoColorSpace);
      expect(sampled).not.toBe(source);
      expect(sampled.source).toBe(source.source);
      expect(sampled.wrapS).toBe(RepeatWrapping);
      expect(sampled.flipY).toBe(false);
      if (nodePath) expect(material.uniforms.uTex0?.value).toBe(sampled);
      for (const [name, uniform] of Object.entries(material.uniforms)) {
        if (/^uTex\d+$/.test(name)) expect(uniform.value).toBe(sampled);
      }
      expect(source.colorSpace).toBe(SRGBColorSpace);
      expect(resolution.ownedTextures).toEqual([sampled]);
      let sourceDisposed = false;
      source.addEventListener("dispose", () => {
        sourceDisposed = true;
      });
      resolution.ownedTextures.forEach((texture) => texture.dispose());
      expect(sourceDisposed).toBe(false);
    },
  );

  it("keeps a texture-only emitter's sRGB source unchanged", () => {
    const source = new Texture();
    source.colorSpace = SRGBColorSpace;
    const effect = normalizeParticleEffect({
      emitters: [{ render: { texture: "textures/noise.png" } }],
    });
    const resolution = createThreeEmitterMaterial(effect.emitters[0]!, {
      effect,
      camera: new PerspectiveCamera(),
      textureProvider: { getTexture: () => source },
    });
    expect("map" in resolution.material && resolution.material.map).toBe(
      source,
    );
    expect(source.colorSpace).toBe(SRGBColorSpace);
    expect(resolution.ownedTextures).toEqual([]);
  });
});
