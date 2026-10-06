import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, ShaderMaterial } from "three";
import { normalizeParticleEffect } from "../../engine/particles";
import {
  createMaterialInstance,
  normalizeShaderGraph,
} from "../schema/materials";
import { compileMaterial } from "./compileMaterial";
import { createMaterialPreviewFragment } from "./materialShaderCompiler";
import {
  createThreeEmitterMaterial,
  createThreeTrailMaterial,
} from "../three/materialAdapter";
import { createTier2ParticleMaterialShader } from "../pixi/materialShader";
vi.mock("pixi.js", () => ({
  Matrix: class {},
  Shader: { from: (options: unknown) => options },
  Texture: { WHITE: { source: {} } },
}));
// Complete source hashes from main plus the editor's #2214 runtime prerequisite.
describe("legacy shader text from main", () => {
  it.each(["normal", "add", "masked", "opaque"])(
    "preserves %s shaders",
    (blend) => {
      const graph = normalizeShaderGraph({
        id: "legacy-colors",
        blend,
        nodes: [
          { id: "particle", type: "particleColor" },
          {
            id: "tex",
            type: "textureSample",
            params: { samplerType: "Color" },
          },
          { id: "product", type: "multiply", inputs: { a: "pc", b: "tex" } },
        ],
        edges: [
          {
            id: "pc",
            source: "particle",
            sourceHandle: "RGB",
            target: "product",
            targetHandle: "a",
          },
          {
            id: "tex",
            source: "tex",
            sourceHandle: "R",
            target: "product",
            targetHandle: "b",
          },
          {
            id: "base",
            source: "product",
            sourceHandle: "Out",
            target: "output",
            targetHandle: "baseColor",
          },
          {
            id: "alpha",
            source: "particle",
            sourceHandle: "A",
            target: "output",
            targetHandle: "opacity",
          },
        ],
        outputs: { baseColor: "base", opacity: "alpha" },
      });
      const instance = createMaterialInstance(graph, "legacy");
      const artifact = compileMaterial(graph, instance);
      const effect = normalizeParticleEffect({
        emitters: [
          {
            render: { material: instance },
            advanced: { trails: { material: instance } },
          },
        ],
      });
      const emitter = effect.emitters[0]!;
      const options = {
        effect,
        camera: new PerspectiveCamera(),
        materialGraphProvider: () => graph,
      };
      const three = createThreeEmitterMaterial(emitter, options)
        .material as ShaderMaterial;
      const trail = createThreeTrailMaterial(emitter, options)!
        .material as ShaderMaterial;
      const pixi = createTier2ParticleMaterialShader({
        graph,
        instance,
        artifact,
      }) as unknown as { gl: { vertex: string; fragment: string } };
      const preview = createMaterialPreviewFragment({
        graph,
        instance,
        artifact,
      })!;
      const hash = (source: string) =>
        createHash("sha256").update(source).digest("hex");
      expect({
        threeVertex: hash(three.vertexShader),
        threeFragment: hash(three.fragmentShader),
        trailVertex: hash(trail.vertexShader),
        trailFragment: hash(trail.fragmentShader),
        pixiVertex: hash(pixi.gl.vertex),
        pixiFragment: hash(pixi.gl.fragment),
        preview: hash(preview.fragment),
      }).toMatchSnapshot();
    },
  );
});
