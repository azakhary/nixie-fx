import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import { normalizeShaderGraph } from "../schema/materials";
import { collectParticleTextureRefs } from "./textureRefs";

describe("collectParticleTextureRefs", () => {
  it("collects material MainTex and secondary material texture paths when a graph is available", () => {
    const effect = normalizeParticleEffect({
      id: "material-textures",
      emitters: [
        {
          id: "e",
          render: {
            texture: "fx/fallback.png",
            material: {
              id: "mi",
              shaderId: "M_Multi",
              mainTex: { type: "texture", id: "main", path: "fx/main.png" },
              paramOverrides: {
                MaskTex: "fx/mask-override.png",
              },
            },
          },
        },
      ],
    });
    const graph = normalizeShaderGraph({
      id: "M_Multi",
      params: [
        {
          name: "MainTex",
          type: "texture",
          group: "Texture",
          default: "fx/default-main.png",
        },
        {
          name: "MaskTex",
          type: "texture",
          group: "Texture",
          default: "fx/mask-default.png",
        },
      ],
      nodes: [
        {
          id: "mainParam",
          type: "param",
          inputs: {},
          params: { name: "MainTex" },
          position: { x: 0, y: 0 },
        },
        {
          id: "maskParam",
          type: "param",
          inputs: {},
          params: { name: "MaskTex" },
          position: { x: 0, y: 0 },
        },
        {
          id: "mainSample",
          type: "textureSample",
          inputs: { tex: "edge-main" },
          params: {},
          position: { x: 0, y: 0 },
        },
        {
          id: "maskSample",
          type: "textureSample",
          inputs: { tex: "edge-mask" },
          params: { tex: "fx/node-ignored.png" },
          position: { x: 0, y: 0 },
        },
        {
          id: "nodeLocal",
          type: "textureSample",
          inputs: {},
          params: { tex: "fx/node-local.png" },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [
        {
          id: "edge-main",
          source: "mainParam",
          sourceHandle: "out",
          target: "mainSample",
          targetHandle: "tex",
        },
        {
          id: "edge-mask",
          source: "maskParam",
          sourceHandle: "out",
          target: "maskSample",
          targetHandle: "tex",
        },
      ],
    });

    expect(
      collectParticleTextureRefs(effect, {
        materialGraphProvider: () => graph,
      }).map((ref) => ref.path),
    ).toEqual([
      "fx/fallback.png",
      "fx/main.png",
      "fx/mask-override.png",
      "fx/node-local.png",
    ]);
  });
});
