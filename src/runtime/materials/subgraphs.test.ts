import { describe, expect, it } from "vitest";
import {
  createMaterialInstance,
  normalizeShaderGraph,
  serializeShaderGraph,
  type ShaderGraph,
} from "../schema/materials";
import { expandMaterialSubgraphs } from "./subgraphs";
import { makeTexelEvaluator } from "./bake";
import { compileMaterial } from "./compileMaterial";
import {
  createMaterialNodePreviewFragment,
  createMaterialPreviewFragment,
} from "./materialShaderCompiler";

function definition(): ShaderGraph {
  return normalizeShaderGraph({
    id: "function",
    name: "Strength",
    params: [{ name: "Strength", type: "float", default: 0.25 }],
    nodes: [
      { id: "input", type: "param", params: { name: "Strength" }, inputs: {} },
    ],
    subgraph: {
      outputs: [
        {
          id: "result",
          name: "Result",
          type: "float",
          nodeId: "input",
          handle: "Out",
        },
        {
          id: "mask",
          name: "Mask",
          type: "float",
          nodeId: "input",
          handle: "Out",
        },
      ],
    },
  });
}
function parent(inner = definition()): ShaderGraph {
  return normalizeShaderGraph({
    id: "parent",
    nodes: [
      { id: "call", type: "subgraph", params: { graph: inner }, inputs: {} },
    ],
    edges: [
      {
        id: "result",
        source: "call",
        sourceHandle: "result",
        target: "output",
        targetHandle: "baseColor",
      },
      {
        id: "mask",
        source: "call",
        sourceHandle: "mask",
        target: "output",
        targetHandle: "opacity",
      },
    ],
    outputs: { baseColor: "result", opacity: "mask" },
  });
}
function sample(g: ShaderGraph) {
  return makeTexelEvaluator(g, createMaterialInstance(g, "i"))(
    [1, 1, 1, 1],
    [0, 0],
  );
}
describe("material subgraphs", () => {
  it("round trips interfaces and bakes disconnected defaults through multiple outputs", () => {
    const g = normalizeShaderGraph(serializeShaderGraph(parent()));
    expect(sample(g)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(
      (g.nodes[0].params.graph as ShaderGraph).subgraph?.outputs,
    ).toHaveLength(2);
  });
  it("connected values override defaults in bake and GLSL", () => {
    const g = parent();
    g.nodes.push({
      id: "value",
      type: "constant",
      params: { value: [0.8, 0.8, 0.8, 0.8] },
      inputs: {},
      position: { x: 0, y: 0 },
    });
    g.edges.push({
      id: "override",
      source: "value",
      sourceHandle: "Out",
      target: "call",
      targetHandle: "Strength",
    });
    g.nodes[0].inputs.Strength = "override";
    expect(sample(g)[0]).toBeCloseTo(0.8);
    const i = createMaterialInstance(g, "i");
    expect(
      createMaterialPreviewFragment({
        graph: g,
        instance: i,
        artifact: compileMaterial(g, i),
      })?.fragment,
    ).toContain("0.8");
  });
  it("expands nested functions", () => {
    const nested = parent();
    nested.id = "nested";
    nested.subgraph = {
      outputs: [
        {
          id: "result",
          name: "Result",
          type: "float",
          nodeId: "call",
          handle: "result",
        },
        {
          id: "mask",
          name: "Mask",
          type: "float",
          nodeId: "call",
          handle: "mask",
        },
      ],
    };
    const g = parent(nested);
    expect(sample(g)[0]).toBe(0.25);
    expect(
      expandMaterialSubgraphs(g).nodes.every((n) => n.type !== "subgraph"),
    ).toBe(true);
  });
  it("preserves connections when an exposed input is renamed", () => {
    const fn = definition();
    fn.params[0].name = "Renamed Strength";
    fn.nodes[0].params.name = "Renamed Strength";
    const g = parent(fn);
    g.nodes.push({
      id: "value",
      type: "constant",
      params: { value: [0.8, 0.8, 0.8, 0.8] },
      inputs: {},
      position: { x: 0, y: 0 },
    });
    g.edges.push({
      id: "override",
      source: "value",
      sourceHandle: "Out",
      target: "call",
      targetHandle: "Strength",
    });
    g.nodes[0].inputs.Strength = "override";
    expect(sample(g)[0]).toBe(0.8);
    expect(
      normalizeShaderGraph(serializeShaderGraph(fn)).params[0].inputId,
    ).toBe("Strength");
  });
  it("keeps repeated function calls independent", () => {
    const g = parent();
    const other = definition();
    other.params[0].default = 0.75;
    g.nodes.push({
      id: "second",
      type: "subgraph",
      inputs: {},
      params: { graph: other },
      position: { x: 0, y: 0 },
    });
    g.edges.find((e) => e.id === "mask")!.source = "second";
    expect(sample(g)).toEqual([0.25, 0.25, 0.25, 0.75]);
    const preview = createMaterialNodePreviewFragment({
      graph: g,
      instance: createMaterialInstance(g, "i"),
      nodeId: "second",
      sourceHandle: "result",
    });
    expect(preview?.fragment).toContain("0.75");
  });
  it("resolves texture input defaults and connected texture overrides", () => {
    const fn = definition();
    fn.params = normalizeShaderGraph({
      params: [{ name: "Texture", type: "texture", default: "default.png" }],
    }).params;
    fn.nodes = [
      {
        id: "input",
        type: "param",
        params: { name: "Texture" },
        inputs: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "tex",
        type: "textureSample",
        params: {},
        inputs: { tex: "tex" },
        position: { x: 0, y: 0 },
      },
    ];
    fn.edges = [
      {
        id: "tex",
        source: "input",
        sourceHandle: "Out",
        target: "tex",
        targetHandle: "tex",
      },
    ];
    fn.subgraph!.outputs = fn.subgraph!.outputs.map((p) => ({
      ...p,
      nodeId: "tex",
      handle: p.id === "mask" ? "A" : "RGB",
    }));
    const g = parent(fn);
    const i = createMaterialInstance(g, "i");
    const paths: string[] = [];
    makeTexelEvaluator(g, i, {
      samplerForPath: (path) => {
        paths.push(path);
        return [1, 1, 1, 1];
      },
    })([0, 0, 0, 0], [0, 0]);
    expect(paths).toContain("default.png");
    g.params = normalizeShaderGraph({
      params: [{ name: "Override", type: "texture", default: "override.png" }],
    }).params;
    g.nodes.push({
      id: "override",
      type: "param",
      params: { name: "Override" },
      inputs: {},
      position: { x: 0, y: 0 },
    });
    g.edges.push({
      id: "binding",
      source: "override",
      sourceHandle: "Out",
      target: "call",
      targetHandle: "Texture",
    });
    g.nodes[0].inputs.Texture = "binding";
    const preview = createMaterialPreviewFragment({
      graph: g,
      instance: i,
      artifact: compileMaterial(g, i),
    });
    expect(preview?.samplers.map((s) => s.path)).toContain("override.png");
  });
  it("rejects recursive and missing definitions with a useful error", () => {
    const g = parent();
    g.subgraph = { outputs: [] };
    g.nodes[0].params.graph = g;
    expect(() => expandMaterialSubgraphs(g)).toThrow(
      "Recursive material subgraph",
    );
    g.nodes[0].params.graph = undefined;
    expect(() => expandMaterialSubgraphs(g)).toThrow(
      "Missing subgraph definition",
    );
  });
});
