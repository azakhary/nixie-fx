import { describe, expect, it } from "vitest";
import {
  createMaterialInstance,
  normalizeShaderGraph,
} from "../schema/materials";
import { makeTexelEvaluator } from "./bake";
import { createMaterialNodePreviewFragmentSource } from "./materialShaderCompiler";

describe("math local inputs", () => {
  it.each([
    ["add", 0.75, 1, 0],
    ["subtract", 0.25, 0.75, 0],
    ["multiply", 0.125, 0.25, 1],
    ["divide", 1, 1, 0],
    ["lerp", 0.4375, 0.8125, 0.5],
  ] as const)(
    "%s bakes and compiles local values with wire precedence",
    (type, local, wired, legacy) => {
      const graph = normalizeShaderGraph({
        id: "math",
        name: "Math",
        nodes: [
          {
            id: "math",
            type,
            inputs: {},
            params: { a: 0.5, b: 0.25, t: 0.25 },
          },
          { id: "value", type: "constant", inputs: {}, params: { value: 1 } },
        ],
        edges: [
          {
            id: "out",
            source: "math",
            sourceHandle: "Out",
            target: "output",
            targetHandle: "baseColor",
          },
        ],
        outputs: { baseColor: "out" },
      });
      const instance = createMaterialInstance(graph, "i");
      const sample = () =>
        makeTexelEvaluator(graph, instance)([1, 1, 1, 1], [0.5, 0.5])[0];
      const shader = () =>
        createMaterialNodePreviewFragmentSource({
          graph,
          instance,
          nodeId: "math",
        });
      const math = graph.nodes[0]!;
      expect(sample()).toBe(local);
      expect(shader()).toContain("vec4(0.50000000)");
      expect(shader()).toContain("vec4(0.25000000)");
      math.inputs.a = "wire";
      graph.edges.push({
        id: "wire",
        source: "value",
        sourceHandle: "Out",
        target: "math",
        targetHandle: "a",
      });
      expect(sample()).toBe(wired);
      expect(shader()).not.toContain("vec4(0.50000000)");
      math.inputs = {};
      graph.edges.pop();
      expect(sample()).toBe(local);
      math.params = {};
      expect(sample()).toBe(legacy);
    },
  );
});
