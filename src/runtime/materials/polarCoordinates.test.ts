import { describe, expect, it } from "vitest";
import {
  createMaterialInstance,
  normalizeShaderGraph,
  serializeShaderGraph,
  type MaterialNode,
} from "../schema/materials";
import { makeTexelEvaluator } from "./bake";
import { analyzeGraphTier } from "./compileMaterial";
import { createMaterialNodePreviewFragmentSource } from "./materialShaderCompiler";

function graph(params: Record<string, unknown> = {}) {
  return normalizeShaderGraph({
    id: "polar-test",
    name: "Polar test",
    nodes: [
      { id: "polar", type: "polarCoordinates", inputs: {}, params },
      {
        id: "tex",
        type: "textureSample",
        inputs: { uv: "uv-edge" },
        params: { tex: "stripes.png" },
      },
    ],
    edges: [
      {
        id: "uv-edge",
        source: "polar",
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
}

function sample(g: ReturnType<typeof graph>, uv: [number, number]) {
  let sampled: [number, number] | undefined;
  makeTexelEvaluator(g, createMaterialInstance(g, "i"), {
    samplerForPath: (_path, coordinates) => {
      sampled = coordinates;
      return [1, 1, 1, 1];
    },
  })([1, 1, 1, 1], uv);
  return sampled!;
}

describe("Polar Coordinates", () => {
  it.each([
    [0.5, 0.5, 0, 0],
    [0.5, 1, 1, 0],
    [1, 0.5, 1, Math.PI / 2 / 6.28],
    [0, 0.5, 1, -Math.PI / 2 / 6.28],
    [0.5, 0, 1, Math.PI / 6.28],
    [1, 1, Math.SQRT2, Math.PI / 4 / 6.28],
    [0, 0, Math.SQRT2, (-3 * Math.PI) / 4 / 6.28],
  ])("maps (%s, %s) to Unity radius %s and angle %s", (u, v, radius, angle) => {
    const value = sample(graph(), [u, v]);
    expect(value[0]).toBeCloseTo(radius, 10);
    expect(value[1]).toBeCloseTo(angle, 10);
  });

  it.each([0, -2, 0.5, 4])(
    "preserves scale %s without clamping or remapping",
    (scale) => {
      const value = sample(
        graph({ center: [0, 0], radialScale: scale, lengthScale: scale }),
        [-1, 0],
      );
      expect(value[0]).toBeCloseTo(2 * scale, 10);
      expect(value[1]).toBeCloseTo((-Math.PI / 2 / 6.28) * scale, 10);
    },
  );

  it("honors all four wired inputs over defaults and retains them after serialization", () => {
    const g = graph({ center: [20, 20], radialScale: 99, lengthScale: 99 });
    for (const [pin, value] of Object.entries({
      UV: [0.25, 0.75, 0, 0],
      Center: [0.25, 0.25, 0, 0],
      "Radial Scale": -2,
      "Length Scale": 4,
    })) {
      g.nodes.push({
        id: pin,
        type: "constant",
        params: { value },
        inputs: {},
        position: { x: 0, y: 0 },
      } as MaterialNode);
      g.edges.push({
        id: pin,
        source: pin,
        sourceHandle: "Out",
        target: "polar",
        targetHandle: pin,
      });
      g.nodes[0]!.inputs[pin] = pin;
    }
    const restored = normalizeShaderGraph(serializeShaderGraph(g));
    expect(restored.nodes).toEqual(g.nodes);
    expect(restored.edges).toEqual(g.edges);
    expect(sample(restored, [0.9, 0.1])).toEqual([-2, 0]);
    const fragment = createMaterialNodePreviewFragmentSource({
      graph: restored,
      instance: createMaterialInstance(restored, "i"),
      nodeId: "polar",
    });
    expect(fragment).toContain("-2.00000000");
    expect(fragment).toContain("4.00000000");
    expect(fragment).not.toContain("99.00000000");
  });

  it("uses the fragment tier for static MainTex distortion and animated inputs", () => {
    const g = graph();
    g.nodes[1]!.params = {};
    expect(analyzeGraphTier(g).tier).toBe("tier2-shader");
    g.nodes.push({
      id: "time",
      type: "time",
      params: {},
      inputs: {},
      position: { x: 0, y: 0 },
    });
    g.edges.push({
      id: "time",
      source: "time",
      sourceHandle: "Out",
      target: "polar",
      targetHandle: "Length Scale",
    });
    g.nodes[0]!.inputs["Length Scale"] = "time";
    expect(analyzeGraphTier(g).tier).toBe("tier2-shader");
    const fragment = createMaterialNodePreviewFragmentSource({
      graph: g,
      instance: createMaterialInstance(g, "i"),
      nodeId: "polar",
    });
    expect(fragment).toContain("atan(");
    expect(fragment).toContain("/ 6.28");
    expect(fragment).toContain("vec4(uTime)");
    expect(fragment).toContain("== 0.0 ? 0.0");
    expect(fragment).toContain(
      "gl_FragColor = vec4(clamp(value.rgb, 0.0, 1.0), 1.0)",
    );
  });
});
