import { describe, expect, it } from "vitest";
import {
  createMaterialInstance,
  normalizeShaderGraph,
  serializeShaderGraph,
  type ShaderGraph,
} from "../schema/materials";
import { compileMaterial } from "./compileMaterial";
import { createMaterialPreviewFragment } from "./materialShaderCompiler";
import { materialColorToLinear, materialColorToSrgb } from "./color";
function graph(
  type = "particleColor",
  params: Record<string, unknown> = {},
  handle = "RGBA",
): ShaderGraph {
  return normalizeShaderGraph({
    id: "colors",
    colorVersion: 1,
    nodes: [{ id: "input", type, params }],
    edges: [
      {
        id: "base",
        source: "input",
        sourceHandle: handle,
        target: "output",
        targetHandle: "baseColor",
      },
    ],
    outputs: { baseColor: "base" },
  });
}
function fragment(g: ShaderGraph): string {
  const instance = createMaterialInstance(g, "test");
  const artifact = compileMaterial(g, instance);
  expect(artifact.tier).toBe("tier2-shader");
  return createMaterialPreviewFragment({ graph: g, instance, artifact })!
    .fragment;
}
describe("versioned material colors", () => {
  it("round trips the opt-in without upgrading legacy files", () => {
    const modern = graph();
    expect(
      normalizeShaderGraph(serializeShaderGraph(modern)).colorVersion,
    ).toBe(1);
    delete modern.colorVersion;
    expect(
      serializeShaderGraph(normalizeShaderGraph(serializeShaderGraph(modern))),
    ).not.toHaveProperty("colorVersion");
  });
  it("decodes straight particle color and never multiplies it a second time", () => {
    const source = fragment(graph());
    expect(source).toContain("baseColor = (materialSrgbToLinear(vColor))");
    expect(source).not.toContain("outColor *=");
    expect(source).toContain("gl_FragColor = materialEncodeOutput(outColor)");
    expect(source).toContain(
      "#ifdef PREMULTIPLIED_ALPHA\n  value.rgb *= value.a;",
    );
    expect(source).toContain("linearToOutputTexel(value)");
  });
  it("keeps implicit particle modulation when the graph does not read it", () => {
    expect(fragment(graph("textureSample"))).toContain(
      "outColor *= materialSrgbToLinear(vColor);",
    );
  });
  it.each([undefined, "Color", "auto"])(
    "treats %s as Auto and leaves single-channel masks raw",
    (samplerType) => {
      const raw = fragment(graph("textureSample", { samplerType }, "R"));
      expect(raw).toContain("baseColor = ((materialSampleMain(vUV)).rrrr)");
      expect(raw).not.toContain(
        "materialSrgbToLinear(materialSampleMain(vUV))",
      );
      expect(
        fragment(graph("textureSample", { samplerType }, "RGB")),
      ).toContain("materialSrgbToLinear(materialSampleMain(vUV))");
    },
  );
  it("honors explicit sampler choices", () => {
    expect(
      fragment(graph("textureSample", { samplerType: "srgb" }, "R")),
    ).toContain("materialSrgbToLinear(materialSampleMain(vUV))");
    expect(
      fragment(graph("textureSample", { samplerType: "linear" }, "RGBA")),
    ).not.toContain("materialSrgbToLinear(materialSampleMain(vUV))");
  });
  it("decodes color constants, parameters, and gradient stops, but not vectors or scalar math", () => {
    for (const kind of ["color", undefined])
      expect(
        fragment(graph("constant", { kind, value: [0.5, 0.3, 0.2, 0.5] })),
      ).toContain("baseColor = (materialSrgbToLinear(vec4(0.50000000");
    expect(
      fragment(graph("constant", { kind: "vec3", value: [0.5, 0.3, 0.2] })),
    ).toContain("baseColor = (vec4(0.50000000");
    const param = graph("param", { name: "Tint" });
    param.params = [
      {
        name: "Tint",
        type: "color",
        default: [0.5, 0.3, 0.2, 0.5],
        group: "",
        scope: "per-material",
      },
    ];
    expect(fragment(param)).toContain(
      "baseColor = (materialSrgbToLinear(vec4(0.50000000",
    );
    expect(
      fragment(
        graph("gradientRamp", {
          stops: [
            { position: 0, color: [0.5, 0.3, 0.2, 0.5] },
            { position: 1, color: [1, 1, 1, 1] },
          ],
        }),
      ),
    ).toContain("mix(materialSrgbToLinear(vec4(0.50000000");
  });
  it("round trips orange and blue without changing alpha or squaring color", () => {
    for (const color of [
      [1, 142 / 255, 76 / 255, 0.5],
      [89 / 255, 143 / 255, 199 / 255, 0.25],
    ] as [number, number, number, number][]) {
      materialColorToSrgb(materialColorToLinear(color)).forEach((v, i) =>
        expect(v).toBeCloseTo(color[i]!, 7),
      );
    }
  });
});
