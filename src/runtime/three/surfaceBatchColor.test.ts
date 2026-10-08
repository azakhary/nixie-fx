import { describe, expect, it } from "vitest";
import {
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Texture,
} from "three";
import { normalizeParticleEffect } from "../../engine/particles";
import {
  createMaterialInstance,
  normalizeShaderGraph,
} from "../schema/materials";
import { createThreeEmitterMaterial } from "./materialAdapter";
import { compileSurfacePrograms, surfaceProgram } from "./surfaceBatchMaterial";

describe("batched versioned graph color", () => {
  it.each(["normal", "premultiplied"])(
    "preserves straight particle RGB and %s output",
    (blend) => {
      const graph = normalizeShaderGraph({
        id: "modern",
        colorVersion: 1,
        blend,
        nodes: [{ id: "input", type: "particleColor", params: {} }],
        edges: [
          {
            id: "base",
            source: "input",
            sourceHandle: "RGBA",
            target: "output",
            targetHandle: "baseColor",
          },
        ],
        outputs: { baseColor: "base" },
      });
      const instance = createMaterialInstance(graph, "test");
      instance.mainTex = { type: "texture", id: "color", path: "color.png" };
      const texture = new Texture();
      const effect = normalizeParticleEffect({
        emitters: [
          {
            render: {
              material: instance,
              blend: blend === "premultiplied" ? "premultiplied" : "alpha",
            },
          },
        ],
      });
      const resolution = createThreeEmitterMaterial(effect.emitters[0]!, {
        effect,
        camera: new PerspectiveCamera(),
        textureProvider: { getTexture: () => texture },
        materialGraphProvider: () => graph,
      });
      const material = resolution.material as ShaderMaterial;
      const mesh = new Mesh(new PlaneGeometry(), material);
      const program = surfaceProgram(mesh);
      expect(program).not.toBeNull();
      expect(program!.straightParticleColor).toBe(true);
      const compiled = compileSurfacePrograms([program!], program!.textures);
      expect(compiled).toContain("materialSrgbToLinear(vNfxColor)");
      expect(compiled).not.toContain("vNfxColor.rgb*vNfxColor.a");
      expect(compiled).toContain("linearToOutputTexel(value)");
      expect(compiled).not.toMatch(/#define NFX_THREE_OUTPUT|#ifdef/);
      expect(compiled.includes("value.rgb *= value.a;")).toBe(
        blend === "premultiplied",
      );
      // Combining legacy and versioned graphs must namespace their helpers.
      expect(compiled).toContain("nfx0_materialEncodeOutput");
      mesh.geometry.dispose();
      material.dispose();
      for (const texture of resolution.ownedTextures) texture.dispose();
      texture.dispose();
    },
  );
});
