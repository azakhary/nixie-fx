import { describe, expect, it } from "vitest";

// The module imports `{ Matrix, Shader, Texture }` from pixi.js at the top, but
// the fragment-source compiler (what these tests exercise) never touches Pixi —
// it only builds GLSL strings. Mock pixi.js so the import resolves in jsdom.
import { vi } from "vitest";

vi.mock("pixi.js", () => ({
  Matrix: class {},
  Shader: { from: vi.fn() },
  Texture: { WHITE: { source: {} } },
}));

const {
  createMaterialPreviewFragment,
  createMaterialNodePreviewFragment,
  MATERIAL_MAX_NODE_SAMPLERS,
} = await import("./materialShader");

import { normalizeShaderGraph } from "../schema/materials";
import type {
  MaterialArtifact,
  MaterialFixedDescriptor,
} from "../materials/artifact";
import type {
  MaterialEdge,
  MaterialInstance,
  MaterialNode,
  MaterialParam,
  ShaderGraph,
} from "../schema/materials";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function node(
  id: string,
  type: MaterialNode["type"],
  inputs: Record<string, string | null> = {},
  params: Record<string, unknown> = {},
): MaterialNode {
  return { id, type, inputs, params, position: { x: 0, y: 0 } };
}

function edge(
  id: string,
  source: string,
  target: string,
  targetHandle: string,
  sourceHandle = "out",
): MaterialEdge {
  return { id, source, sourceHandle, target, targetHandle };
}

function graph(partial: Partial<ShaderGraph>): ShaderGraph {
  return normalizeShaderGraph({
    id: "test",
    name: "Test",
    blend: "normal",
    nodes: [],
    edges: [],
    params: [],
    outputs: {},
    ...partial,
  });
}

const FIXED: MaterialFixedDescriptor = {
  tint: [1, 1, 1, 1],
  emissive: 0,
  opacity: 1,
  blend: "normal",
};

function artifact(over: Partial<MaterialArtifact> = {}): MaterialArtifact {
  return {
    tier: "tier2-shader",
    shaderId: "test-shader",
    blend: "normal",
    fixed: FIXED,
    perParticleFeeds: {},
    diagnostics: [],
    deferredNodeIds: [],
    usesParticleColorRGB: false,
    usesParticleColorAlpha: false,
    opacityIsConstantOne: false,
    ...over,
  };
}

const INSTANCE: MaterialInstance = {
  id: "i",
  shaderId: "test",
  paramOverrides: {},
  mainTex: null,
};

/** A graph whose baseColor is a TextureSample with the given params.tex. */
function textureSampleGraph(tex: string): ShaderGraph {
  return graph({
    nodes: [node("tex", "textureSample", {}, { tex }), node("out", "output")],
    edges: [edge("e1", "tex", "out", "baseColor", "RGB")],
    outputs: { baseColor: "e1" },
  });
}

// ---------------------------------------------------------------------------
// M4: GLSL compiler is texture-aware
// ---------------------------------------------------------------------------

describe("materialShader compiler — per-node samplers (M4)", () => {
  it("a TextureSample with a non-empty params.tex emits a distinct sampler", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: textureSampleGraph("fx/a.png"),
      instance: INSTANCE,
    });
    expect(compiled).not.toBeNull();
    const { fragment, samplers } = compiled!;
    // The fragment samples a per-node uniform, NOT the MainTex helper.
    expect(fragment).toContain("uTex0");
    expect(fragment).toContain("texture2D(uTex0");
    expect(fragment).toContain("uniform sampler2D uTex0;");
    expect(fragment).not.toContain("materialSampleMain(vUV)");
    // ...and exposes that sampler in the binding list (node id → uniform → path).
    expect(samplers).toEqual([
      { nodeId: "tex", uniform: "uTex0", path: "fx/a.png" },
    ]);
  });

  it("compiles DynamicParameter nodes to the dedicated uniform", () => {
    const g = graph({
      nodes: [node("dyn", "dynamicParameter"), node("out", "output")],
      edges: [edge("e1", "dyn", "out", "opacity", "Param2")],
      outputs: { opacity: "e1" },
    });

    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: g,
      instance: INSTANCE,
    });

    expect(compiled!.fragment).toContain("uniform vec4 uDynamicParams;");
    expect(compiled!.fragment).toContain("uDynamicParams).gggg");
  });

  it("an empty params.tex falls back to materialSampleMain and exposes no sampler", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: textureSampleGraph(""),
      instance: INSTANCE,
    });
    expect(compiled).not.toBeNull();
    const { fragment, samplers } = compiled!;
    expect(samplers).toEqual([]);
    expect(fragment).toContain("materialSampleMain(vUV)");
    expect(fragment).not.toContain("uTex0");
    expect(fragment).not.toContain("uniform sampler2D uTex0;");
  });

  it("antialiasedTextureMask honors its own params.tex via a sampler", () => {
    const g = graph({
      nodes: [
        node("mask", "antialiasedTextureMask", {}, { tex: "fx/mask.png" }),
        node("out", "output"),
      ],
      edges: [edge("e1", "mask", "out", "opacityMask", "Out")],
      outputs: { opacityMask: "e1" },
    });
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: g,
      instance: INSTANCE,
    });
    const { fragment, samplers } = compiled!;
    expect(samplers).toEqual([
      { nodeId: "mask", uniform: "uTex0", path: "fx/mask.png" },
    ]);
    expect(fragment).toContain("texture2D(uTex0");
  });

  it("a wired texture-param wins over the node's own params.tex (M3 phase-1)", () => {
    const param: MaterialParam = {
      name: "Mask",
      type: "texture",
      group: "Textures",
      default: "fx/param.png",
      scope: "per-material",
    };
    const g = graph({
      params: [param],
      nodes: [
        node("p", "param", {}, { name: "Mask" }),
        node("tex", "textureSample", { tex: "e0" }, { tex: "fx/own.png" }),
        node("out", "output"),
      ],
      edges: [
        edge("e0", "p", "tex", "tex", "Out"),
        edge("e1", "tex", "out", "baseColor", "RGB"),
      ],
      outputs: { baseColor: "e1" },
    });
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: g,
      instance: INSTANCE,
    });
    // The wired texture-param's asset wins over params.tex.
    expect(compiled!.samplers).toEqual([
      { nodeId: "tex", uniform: "uTex0", path: "fx/param.png" },
    ]);
  });

  it("a wired MainTex param uses the implicit main sampler instead of uTexN", () => {
    const param: MaterialParam = {
      name: "MainTex",
      type: "texture",
      group: "Texture",
      default: "fx/default.png",
      scope: "per-material",
    };
    const g = graph({
      params: [param],
      nodes: [
        node("p", "param", {}, { name: "MainTex" }),
        node("tex", "textureSample", { tex: "e0" }, { tex: "fx/own.png" }),
        node("out", "output"),
      ],
      edges: [
        edge("e0", "p", "tex", "tex", "Out"),
        edge("e1", "tex", "out", "baseColor", "RGB"),
      ],
      outputs: { baseColor: "e1" },
    });
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: g,
      instance: {
        ...INSTANCE,
        mainTex: { type: "texture", id: "main", path: "fx/override.png" },
      },
    });

    expect(compiled!.samplers).toEqual([]);
    expect(compiled!.fragment).toContain("materialSampleMain(vUV)");
    expect(compiled!.fragment).not.toContain("uniform sampler2D uTex0;");
  });

  it("assigns deterministic sampler names sorted by node id", () => {
    const g = graph({
      nodes: [
        node("zNode", "textureSample", {}, { tex: "fx/z.png" }),
        node("aNode", "textureSample", {}, { tex: "fx/a.png" }),
        node("out", "output"),
      ],
      edges: [edge("e1", "zNode", "out", "baseColor", "RGB")],
      outputs: { baseColor: "e1" },
    });
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: g,
      instance: INSTANCE,
    });
    // Sorted by node id → "aNode" gets uTex0, "zNode" gets uTex1, regardless of
    // graph array order (stable for shader caching).
    expect(compiled!.samplers).toEqual([
      { nodeId: "aNode", uniform: "uTex0", path: "fx/a.png" },
      { nodeId: "zNode", uniform: "uTex1", path: "fx/z.png" },
    ]);
  });

  it("diagnoses + caps per-node samplers beyond the fixed limit", () => {
    const nodes: MaterialNode[] = [];
    for (let i = 0; i < MATERIAL_MAX_NODE_SAMPLERS + 2; i++) {
      // ids "n00", "n01", ... keep the sort order predictable.
      nodes.push(
        node(
          `n${String(i).padStart(2, "0")}`,
          "textureSample",
          {},
          {
            tex: `fx/${i}.png`,
          },
        ),
      );
    }
    nodes.push(node("out", "output"));
    const g = graph({
      nodes,
      edges: [edge("e1", "n00", "out", "baseColor", "RGB")],
      outputs: { baseColor: "e1" },
    });
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: g,
      instance: INSTANCE,
    });
    expect(compiled!.samplers).toHaveLength(MATERIAL_MAX_NODE_SAMPLERS);
    expect(compiled!.diagnostics.some((d) => d.includes("more than"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// BYTE-IDENTICAL guard: no-texture-param graphs compile to unchanged source
// ---------------------------------------------------------------------------

describe("materialShader compiler — byte-identical (no texture params)", () => {
  // Golden fragment for the empty/implicit-baseColor graph (the documented
  // single-uTexture MainTex fallback). If the compiler regresses for graphs
  // WITHOUT per-node textures, this string mismatches.
  const EMPTY_GRAPH_GOLDEN = `
precision mediump float;

varying vec2 vUV;
varying vec4 vColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform vec4 uFixedTint;
uniform float uFixedEmissive;
uniform float uFixedOpacity;
uniform float uClipValue;
uniform vec2 uSheetTiles;
uniform vec4 uSubUv;
uniform float uSubUvFromAttr;
uniform vec4 uDynamicParams;

float materialLuminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float materialHash(vec2 p, float seed) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + seed * 0.00317);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float materialValueNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = materialHash(i, seed);
  float b = materialHash(i + vec2(1.0, 0.0), seed);
  float c = materialHash(i + vec2(0.0, 1.0), seed);
  float d = materialHash(i + vec2(1.0, 1.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float materialGradientNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a0 = materialHash(i, seed) * 6.2831853;
  float a1 = materialHash(i + vec2(1.0, 0.0), seed) * 6.2831853;
  float a2 = materialHash(i + vec2(0.0, 1.0), seed) * 6.2831853;
  float a3 = materialHash(i + vec2(1.0, 1.0), seed) * 6.2831853;
  float n00 = dot(vec2(cos(a0), sin(a0)), f);
  float n10 = dot(vec2(cos(a1), sin(a1)), f - vec2(1.0, 0.0));
  float n01 = dot(vec2(cos(a2), sin(a2)), f - vec2(0.0, 1.0));
  float n11 = dot(vec2(cos(a3), sin(a3)), f - vec2(1.0, 1.0));
  return clamp(mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 0.7071 + 0.5, 0.0, 1.0);
}

float materialVoronoiNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  float minD = 100000.0;
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 cell = i + vec2(float(ox), float(oy));
      vec2 feature = cell + vec2(
        materialHash(cell, seed),
        materialHash(cell, seed + 37.719)
      );
      vec2 diff = feature - p;
      minD = min(minD, dot(diff, diff));
    }
  }
  return min(1.0, sqrt(minD));
}

float materialScalarNoise(vec2 uv, float scale, float seed, float outputMin, float outputMax, float mode) {
  vec2 p = uv * max(scale, 0.0001);
  float n = mode > 1.5
    ? materialVoronoiNoise(p, seed)
    : (mode > 0.5 ? materialValueNoise(p, seed) : materialGradientNoise(p, seed));
  return mix(outputMin, outputMax, n);
}

vec4 materialSampleMain(vec2 uv) {
  return texture2D(uTexture, uSubUv.xy + fract(uv) * uSubUv.zw);
}

vec4 materialSampleSubUvBlend(vec2 uv) {
  vec4 current = materialSampleMain(uv);
  if (uSubUvFromAttr > 0.5) return current;
  vec2 tiles = max(floor(uSheetTiles + 0.5), vec2(1.0, 1.0));
  float total = max(1.0, tiles.x * tiles.y);
  if (total <= 1.0) return current;
  vec2 scaled = (uSubUv.xy + fract(uv) * uSubUv.zw) * tiles;
  vec2 cell = floor(scaled);
  vec2 local = fract(scaled);
  float frame = mod((tiles.y - 1.0 - cell.y) * tiles.x + cell.x, total);
  float nextFrame = mod(frame + 1.0, total);
  vec2 nextCell = vec2(
    mod(nextFrame, tiles.x),
    tiles.y - 1.0 - floor(nextFrame / tiles.x)
  );
  vec2 nextUv = (nextCell + local) / tiles;
  return mix(current, texture2D(uTexture, nextUv), clamp(vColor.a, 0.0, 1.0));
}

void main(void) {
  vec4 baseColor = materialSampleMain(vUV);
  vec4 emissiveColor = vec4(0.0);
  float opacityValue = clamp((materialSampleMain(vUV).a), 0.0, 1.0);
  float maskValue = (vec4(1.0)).r;
  if (maskValue < uClipValue) discard;
  vec4 outColor = baseColor;
  outColor.rgb = outColor.rgb * uFixedTint.rgb + emissiveColor.rgb;
  outColor.rgb *= (1.0 + max(0.0, uFixedEmissive));
  outColor.a = opacityValue * uFixedTint.a * uFixedOpacity;
  outColor *= vColor;
  gl_FragColor = outColor;
}
`;

  it("the empty graph compiles to the unchanged golden fragment + no samplers", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: graph({}),
      instance: INSTANCE,
    });
    expect(compiled!.samplers).toEqual([]);
    expect(compiled!.fragment).toBe(EMPTY_GRAPH_GOLDEN);
  });

  it("a no-texture-param graph (multiply tint) declares no sampler uniform", () => {
    const g = graph({
      nodes: [
        node("c", "constant", {}, { value: [1, 0.5, 0.25, 1] }),
        node("out", "output"),
      ],
      edges: [edge("e1", "c", "out", "baseColor", "Out")],
      outputs: { baseColor: "e1" },
    });
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: g,
      instance: INSTANCE,
    });
    expect(compiled!.samplers).toEqual([]);
    expect(compiled!.fragment).not.toContain("uniform sampler2D uTex0;");
  });
});

// ---------------------------------------------------------------------------
// I12-G: masked / opaque blend modes in the fragment encode
// ---------------------------------------------------------------------------

describe("materialShader compiler — masked/opaque blends (I12-G)", () => {
  /** A graph with a wired opacityMask (sphereMask → opacityMask). */
  function wiredMaskGraph(blend: "normal" | "masked" | "opaque"): ShaderGraph {
    return graph({
      blend,
      nodes: [node("mask", "sphereMask"), node("out", "output")],
      edges: [edge("e-mask", "mask", "out", "opacityMask")],
      outputs: { opacityMask: "e-mask" },
    });
  }

  it("opaque emits no discard and forces the output alpha to 1", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact({ blend: "opaque" }),
      graph: graph({ blend: "opaque" }),
      instance: INSTANCE,
    });
    expect(compiled!.fragment).not.toContain("discard");
    expect(compiled!.fragment).not.toContain("opacityValue");
    expect(compiled!.fragment).toContain("outColor.a = 1.0;");
  });

  it("opaque ignores a wired opacityMask entirely", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact({ blend: "opaque" }),
      graph: wiredMaskGraph("opaque"),
      instance: INSTANCE,
    });
    expect(compiled!.fragment).not.toContain("discard");
    expect(compiled!.fragment).toContain("outColor.a = 1.0;");
  });

  it("masked emits the discard against the wired mask", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact({ blend: "masked" }),
      graph: wiredMaskGraph("masked"),
      instance: INSTANCE,
    });
    expect(compiled!.fragment).toContain(
      "if (maskValue < uClipValue) discard;",
    );
    expect(compiled!.fragment).not.toContain(
      "float maskValue = (vec4(1.0)).r;",
    );
  });

  it("masked forces fully-opaque alpha after the discard passes", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact({ blend: "masked" }),
      graph: wiredMaskGraph("masked"),
      instance: INSTANCE,
    });
    // Mirrors the opaque encode: vColor multiply, then alpha pinned to 1.
    expect(compiled!.fragment).toContain(
      "outColor *= vColor;\n  outColor.a = 1.0;",
    );
    expect(compiled!.fragment).not.toContain(
      "outColor.a = opacityValue * uFixedTint.a * uFixedOpacity;",
    );
  });

  it("masked with no wired mask falls back to clipping the computed opacity", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact({ blend: "masked" }),
      graph: graph({ blend: "masked" }),
      instance: INSTANCE,
    });
    expect(compiled!.fragment).toContain("float maskValue = opacityValue;");
    expect(compiled!.fragment).toContain(
      "if (maskValue < uClipValue) discard;",
    );
    expect(compiled!.fragment).toContain(
      "outColor *= vColor;\n  outColor.a = 1.0;",
    );
  });

  it("normal keeps the inert vec4(1.0) mask clause byte-identical", () => {
    const compiled = createMaterialPreviewFragment({
      artifact: artifact(),
      graph: graph({}),
      instance: INSTANCE,
    });
    expect(compiled!.fragment).toContain("float maskValue = (vec4(1.0)).r;");
    expect(compiled!.fragment).toContain(
      "if (maskValue < uClipValue) discard;",
    );
    // Soft alpha encode stays byte-identical: no forced-opaque write.
    expect(compiled!.fragment).toContain(
      "outColor.a = opacityValue * uFixedTint.a * uFixedOpacity;\n  outColor *= vColor;",
    );
    expect(compiled!.fragment).not.toContain("outColor.a = 1.0;");
  });
});

// ---------------------------------------------------------------------------
// Node preview fragment exposes the same sampler list
// ---------------------------------------------------------------------------

describe("materialShader node preview — per-node samplers", () => {
  it("a TextureSample node preview emits + exposes its own sampler", () => {
    const compiled = createMaterialNodePreviewFragment({
      graph: textureSampleGraph("fx/a.png"),
      instance: INSTANCE,
      nodeId: "tex",
    });
    expect(compiled).not.toBeNull();
    expect(compiled!.samplers).toEqual([
      { nodeId: "tex", uniform: "uTex0", path: "fx/a.png" },
    ]);
    expect(compiled!.fragment).toContain("texture2D(uTex0");
  });

  it("applies the selected output handle in the node preview fragment", () => {
    const compiled = createMaterialNodePreviewFragment({
      graph: graph({
        nodes: [node("dyn", "dynamicParameter")],
      }),
      instance: INSTANCE,
      nodeId: "dyn",
      sourceHandle: "Param2",
    });

    expect(compiled?.fragment).toContain("(uDynamicParams).gggg");
  });

  it("resolves node preview out to the first DynamicParameter pin", () => {
    const compiled = createMaterialNodePreviewFragment({
      graph: graph({
        nodes: [node("dyn", "dynamicParameter")],
      }),
      instance: INSTANCE,
      nodeId: "dyn",
      sourceHandle: "out",
    });

    expect(compiled?.fragment).toContain("(uDynamicParams).rrrr");
  });
});
