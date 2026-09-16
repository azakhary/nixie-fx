import { describe, expect, it } from "vitest";
import {
  createMaterialInstance,
  normalizeShaderGraph,
} from "../schema/materials";
import { analyzeGraphTier } from "./compileMaterial";
import { createMaterialNodePreviewFragmentSource } from "./materialShaderCompiler";

function fixture() {
  const graph = normalizeShaderGraph({
    id: "pan-test",
    name: "Panner",
    params: [
      {
        name: "Speed",
        type: "vec2",
        default: [0.5, 0.25, 0, 0],
        scope: "per-material",
      },
    ],
    nodes: [
      { id: "speed", type: "param", inputs: {}, params: { name: "Speed" } },
      {
        id: "pan",
        type: "panner",
        inputs: { speed: "s" },
        params: { speed: [0.1, 0, 0, 0] },
      },
      { id: "tex", type: "textureSample", inputs: { uv: "u" }, params: {} },
    ],
    edges: [
      {
        id: "s",
        source: "speed",
        sourceHandle: "Out",
        target: "pan",
        targetHandle: "speed",
      },
      {
        id: "u",
        source: "pan",
        sourceHandle: "Out",
        target: "tex",
        targetHandle: "uv",
      },
      {
        id: "out",
        source: "tex",
        sourceHandle: "RGB",
        target: "output",
        targetHandle: "baseColor",
      },
    ],
    outputs: { baseColor: "out" },
  });
  return { graph, instance: createMaterialInstance(graph, "i") };
}

describe("Panner speed", () => {
  it("compiles parameter speed changes and restores the local fallback on disconnect", () => {
    const { graph, instance } = fixture();
    const fragment = () =>
      createMaterialNodePreviewFragmentSource({
        graph,
        instance,
        nodeId: "pan",
      });
    expect(fragment()).toContain("vec4(0.50000000, 0.25000000");
    expect(fragment()).not.toContain("0.10000000");
    instance.paramOverrides.Speed = [-0.5, 0, 0, 0];
    expect(fragment()).toContain("vec4(-0.50000000, 0.00000000");
    graph.nodes[1]!.inputs.speed = null;
    graph.edges = graph.edges.filter((e) => e.id !== "s");
    expect(fragment()).toContain("vec4(0.10000000, 0.00000000");
  });
  it("keeps connected speeds in the shader even with zero local speed", () => {
    const { graph } = fixture();
    graph.nodes[1]!.params.speed = [0, 0, 0, 0];
    expect(analyzeGraphTier(graph).tier).toBe("tier2-shader");
    expect(analyzeGraphTier(graph).vertexUvNodeIds).toEqual([]);
    graph.nodes[1]!.inputs.speed = null;
    graph.edges = graph.edges.filter((e) => e.id !== "s");
    graph.nodes[1]!.params.speed = [0.1, 0, 0, 0];
    expect(analyzeGraphTier(graph).tier).toBe("tier1-fixed");
  });
  it("accepts another node's expression as speed", () => {
    const { graph, instance } = fixture();
    graph.nodes[0] = { ...graph.nodes[0]!, type: "time", params: {} };
    expect(
      createMaterialNodePreviewFragmentSource({
        graph,
        instance,
        nodeId: "pan",
      }),
    ).toContain("vec4(uTime)");
    expect(analyzeGraphTier(graph).tier).toBe("tier2-shader");
  });
});
