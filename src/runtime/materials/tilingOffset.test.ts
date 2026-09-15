import { describe, expect, it } from "vitest";
import {
  createMaterialInstance,
  normalizeShaderGraph,
} from "../schema/materials";
import { makeTexelEvaluator } from "./bake";
import { createMaterialNodePreviewFragmentSource } from "./materialShaderCompiler";

function fixture() {
  const graph = normalizeShaderGraph({
    id: "tiling-test",
    name: "Tiling test",
    params: [
      {
        name: "Tile",
        type: "vec2",
        default: [2, 3, 0, 0],
        scope: "per-material",
      },
      {
        name: "Offset",
        type: "vec2",
        default: [0.1, 0.2, 0, 0],
        scope: "per-material",
      },
    ],
    nodes: [
      { id: "tile", type: "param", inputs: {}, params: { name: "Tile" } },
      { id: "offset", type: "param", inputs: {}, params: { name: "Offset" } },
      {
        id: "uv",
        type: "tilingOffset",
        inputs: { tile: "t", offset: "o" },
        params: { tile: [1, 1], offset: [0, 0] },
      },
      {
        id: "tex",
        type: "textureSample",
        inputs: { uv: "u" },
        params: { tex: "grid.png" },
      },
    ],
    edges: [
      {
        id: "t",
        source: "tile",
        sourceHandle: "Out",
        target: "uv",
        targetHandle: "tile",
      },
      {
        id: "o",
        source: "offset",
        sourceHandle: "Out",
        target: "uv",
        targetHandle: "offset",
      },
      {
        id: "u",
        source: "uv",
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
  const instance = createMaterialInstance(graph, "i");
  return { graph, instance };
}

describe("Tiling & Offset", () => {
  it("bakes connected parameters, changes, zero/negative scales, and disconnected defaults", () => {
    const { graph, instance } = fixture();
    const sample = () => {
      let uv: [number, number] | undefined;
      makeTexelEvaluator(graph, instance, {
        samplerForPath: (_path, coordinates) => {
          uv = coordinates;
          return [1, 1, 1, 1];
        },
      })([1, 1, 1, 1], [0.25, 0.25]);
      return uv;
    };
    expect(sample()).toEqual([0.6, 0.95]);
    instance.paramOverrides = { Tile: [4, 4, 0, 0], Offset: [0.5, 0.5, 0, 0] };
    expect(sample()).toEqual([1.5, 1.5]);
    instance.paramOverrides.Tile = [0, -2, 0, 0];
    expect(sample()).toEqual([0.5, 0]);
    graph.nodes[2]!.inputs = {};
    graph.edges = graph.edges.filter((e) => e.target !== "uv");
    expect(sample()).toEqual([0.25, 0.25]);
    graph.nodes[2]!.params = {};
    expect(sample()).toEqual([0.25, 0.25]);
  });
  it("compiles connected values and recompiles changes before restoring defaults", () => {
    const { graph, instance } = fixture();
    const fragment = () =>
      createMaterialNodePreviewFragmentSource({
        graph,
        instance,
        nodeId: "uv",
      });
    expect(fragment()).toContain("vec4(2.00000000, 3.00000000");
    expect(fragment()).toContain("vec4(0.10000000, 0.20000000");
    instance.paramOverrides = {
      Tile: [0, -4, 0, 0],
      Offset: [0.5, 0.75, 0, 0],
    };
    expect(fragment()).toContain("vec4(0.00000000, -4.00000000");
    expect(fragment()).toContain("vec4(0.50000000, 0.75000000");
    expect(fragment()).not.toContain("vec2(0.000001)");
    graph.nodes[2]!.inputs = {};
    graph.edges = graph.edges.filter((e) => e.target !== "uv");
    expect(fragment()).toContain("vec4(1.00000000, 1.00000000");
    expect(fragment()).not.toContain("-4.00000000");
  });
});
