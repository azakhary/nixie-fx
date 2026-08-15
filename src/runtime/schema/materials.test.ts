import { describe, expect, it } from "vitest";
import {
  coerceParamValue,
  createMaterialInstance,
  createSpriteMasterGraph,
  isSpriteMasterGraph,
  materialBlendOverridesEmitter,
  normalizeMaterialInstance,
  normalizeMaterialParam,
  normalizeShaderGraph,
  resolveEffectiveMainTexPath,
  resolveEffectiveParticleBlend,
  resolveMaterialParamValue,
  serializeMaterialInstance,
  serializeShaderGraph,
  SPRITE_MASTER_SHADER_ID,
  type MaterialInstance,
  type ShaderGraph,
} from "./materials";

describe("normalizeShaderGraph", () => {
  it("fills defaults for an empty input", () => {
    const graph = normalizeShaderGraph({});
    expect(graph.id).toBe("material");
    expect(graph.blend).toBe("normal");
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.params).toEqual([]);
  });

  it("drops unknown node types (forward-compat)", () => {
    const graph = normalizeShaderGraph({
      nodes: [
        {
          id: "a",
          type: "multiply",
          inputs: {},
          params: {},
          position: { x: 0, y: 0 },
        },
        {
          id: "b",
          type: "totally-bogus",
          inputs: {},
          params: {},
          position: { x: 0, y: 0 },
        },
      ],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("drops nodes without an id", () => {
    const graph = normalizeShaderGraph({
      nodes: [
        { type: "multiply", inputs: {}, params: {}, position: { x: 0, y: 0 } },
      ],
    });
    expect(graph.nodes).toEqual([]);
  });

  it("drops edges missing endpoints", () => {
    const graph = normalizeShaderGraph({
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          sourceHandle: "out",
          targetHandle: "in",
        },
        { id: "e2", source: "a" },
      ],
    });
    expect(graph.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("clamps opacityMaskClipValue to 0..1", () => {
    expect(
      normalizeShaderGraph({ opacityMaskClipValue: 5 }).opacityMaskClipValue,
    ).toBe(1);
    expect(
      normalizeShaderGraph({ opacityMaskClipValue: -2 }).opacityMaskClipValue,
    ).toBe(0);
  });

  it("leaves render faces unset when never authored", () => {
    expect(normalizeShaderGraph({}).side).toBeUndefined();
    expect(serializeShaderGraph(normalizeShaderGraph({})).side).toBeUndefined();
    expect(normalizeShaderGraph({ side: "bogus" }).side).toBeUndefined();
  });

  it("round-trips an explicit 'double' render face instead of stripping it as a default", () => {
    expect(normalizeShaderGraph({ side: "double" }).side).toBe("double");
    expect(
      serializeShaderGraph(normalizeShaderGraph({ side: "double" })).side,
    ).toBe("double");
    expect(normalizeShaderGraph({ side: "front" }).side).toBe("front");
    expect(
      serializeShaderGraph(normalizeShaderGraph({ side: "back" })).side,
    ).toBe("back");
  });

  it("preserves iteration-5b node params and legacy 'out' source handles", () => {
    const graph = normalizeShaderGraph({
      id: "M_Noise",
      nodes: [
        {
          id: "n",
          type: "noise",
          inputs: {},
          params: {
            function: "voronoi",
            scale: 12,
            levels: 5,
            tiling: true,
            seed: 7,
            bakeSize: 256,
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "dp",
          type: "dynamicParameter",
          inputs: {},
          params: { paramNames: ["Heat", "Wind", "P3", "P4"] },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "n",
          sourceHandle: "out",
          target: "o",
          targetHandle: "opacity",
        },
        {
          id: "e2",
          source: "dp",
          sourceHandle: "Param2",
          target: "o",
          targetHandle: "emissive",
        },
      ],
    });
    // New node types survive normalization with their params intact.
    expect(graph.nodes.map((n) => n.type)).toEqual([
      "noise",
      "dynamicParameter",
    ]);
    expect(graph.nodes[0].params.function).toBe("voronoi");
    expect(graph.nodes[1].params.paramNames).toEqual([
      "Heat",
      "Wind",
      "P3",
      "P4",
    ]);
    expect(graph.dynamicChannelLabels).toEqual(["Heat", "Wind", "P3", "P4"]);
    // Legacy and explicit channel source handles round-trip verbatim.
    expect(graph.edges[0].sourceHandle).toBe("out");
    expect(graph.edges[1].sourceHandle).toBe("Param2");
  });

  it("prefers material-level DynamicParameter channel labels", () => {
    const graph = normalizeShaderGraph({
      id: "M_Dyn",
      dynamicChannelLabels: ["Intensity", "Age", "Spin", "Mask"],
      nodes: [
        {
          id: "dp1",
          type: "dynamicParameter",
          inputs: {},
          params: { paramNames: ["OldA", "OldB", "OldC", "OldD"] },
          position: { x: 0, y: 0 },
        },
        {
          id: "dp2",
          type: "dynamicParameter",
          inputs: {},
          params: { paramNames: ["OtherA", "OtherB", "OtherC", "OtherD"] },
          position: { x: 0, y: 0 },
        },
      ],
    });

    expect(graph.dynamicChannelLabels).toEqual([
      "Intensity",
      "Age",
      "Spin",
      "Mask",
    ]);
    expect(serializeShaderGraph(graph).dynamicChannelLabels).toEqual([
      "Intensity",
      "Age",
      "Spin",
      "Mask",
    ]);
  });

  it("round-trips the masked and opaque blend modes (I12-G)", () => {
    for (const blend of ["masked", "opaque"] as const) {
      const graph = normalizeShaderGraph({ id: "M", blend });
      expect(graph.blend).toBe(blend);
      const serialized = serializeShaderGraph(graph);
      expect(serialized.blend).toBe(blend);
      expect(normalizeShaderGraph(serialized).blend).toBe(blend);
    }
  });

  it("collapses unknown blend strings to 'normal' (legacy round-trip)", () => {
    expect(normalizeShaderGraph({ id: "M", blend: "modulate" }).blend).toBe(
      "normal",
    );
    expect(normalizeShaderGraph({ id: "M", blend: 3 }).blend).toBe("normal");
    expect(normalizeShaderGraph({ id: "M" }).blend).toBe("normal");
    expect(normalizeShaderGraph({ id: "M", blend: "add" }).blend).toBe("add");
  });

  it("round-trips idempotently", () => {
    const once = normalizeShaderGraph({
      id: "M_Fire",
      name: "Fire",
      blend: "add",
      nodes: [
        {
          id: "t",
          type: "time",
          inputs: {},
          params: {},
          position: { x: 1, y: 2 },
        },
      ],
      params: [{ name: "Speed", type: "float", group: "Anim", default: 0.5 }],
      outputs: { emissive: "e1" },
    });
    const twice = normalizeShaderGraph(once);
    expect(twice).toEqual(once);
  });
});

describe("resolveEffectiveParticleBlend", () => {
  it("keeps the emitter authoritative for normal/add and no material", () => {
    expect(resolveEffectiveParticleBlend("alpha", null)).toBe("alpha");
    expect(resolveEffectiveParticleBlend("additive", undefined)).toBe(
      "additive",
    );
    expect(resolveEffectiveParticleBlend("alpha", "normal")).toBe("alpha");
    expect(resolveEffectiveParticleBlend("additive", "normal")).toBe(
      "additive",
    );
    expect(resolveEffectiveParticleBlend("alpha", "add")).toBe("alpha");
  });

  it("masked/opaque materials override the emitter blend", () => {
    expect(resolveEffectiveParticleBlend("alpha", "masked")).toBe("masked");
    expect(resolveEffectiveParticleBlend("additive", "masked")).toBe("masked");
    expect(resolveEffectiveParticleBlend("alpha", "opaque")).toBe("opaque");
    expect(resolveEffectiveParticleBlend("additive", "opaque")).toBe("opaque");
    expect(materialBlendOverridesEmitter("masked")).toBe(true);
    expect(materialBlendOverridesEmitter("opaque")).toBe(true);
    expect(materialBlendOverridesEmitter("normal")).toBe(false);
    expect(materialBlendOverridesEmitter("add")).toBe(false);
    expect(materialBlendOverridesEmitter(null)).toBe(false);
  });

  it("passes an emitter premultiplied blend through when the material is not a cutout", () => {
    expect(resolveEffectiveParticleBlend("premultiplied", null)).toBe(
      "premultiplied",
    );
    expect(resolveEffectiveParticleBlend("premultiplied", undefined)).toBe(
      "premultiplied",
    );
    expect(resolveEffectiveParticleBlend("premultiplied", "normal")).toBe(
      "premultiplied",
    );
    expect(resolveEffectiveParticleBlend("premultiplied", "add")).toBe(
      "premultiplied",
    );
  });

  it("still lets a masked/opaque material override a premultiplied emitter", () => {
    expect(resolveEffectiveParticleBlend("premultiplied", "masked")).toBe(
      "masked",
    );
    expect(resolveEffectiveParticleBlend("premultiplied", "opaque")).toBe(
      "opaque",
    );
    // D3 pin: premultiplied is an ordinary emitter blend, never
    // material-authoritative, so it never trips the transparent=false trap.
    expect(materialBlendOverridesEmitter("premultiplied")).toBe(false);
  });
});

describe("normalizeMaterialParam", () => {
  it("coerces default to the param type and keeps slider/clamp for floats", () => {
    const p = normalizeMaterialParam({
      name: "Glow",
      type: "float",
      default: "not-a-number",
      sliderMin: 0,
      sliderMax: 2,
    });
    expect(p.default).toBe(0);
    expect(p.sliderMin).toBe(0);
    expect(p.sliderMax).toBe(2);
  });

  it("clamps color defaults to 0..1", () => {
    const p = normalizeMaterialParam({
      name: "C",
      type: "color",
      default: [2, -1, 0.5, 9],
    });
    expect(p.default).toEqual([1, 0, 0.5, 1]);
  });

  it("only honors perParticle on float params", () => {
    expect(
      normalizeMaterialParam({ name: "x", type: "float", perParticle: true })
        .perParticle,
    ).toBe(true);
    expect(
      normalizeMaterialParam({ name: "x", type: "color", perParticle: true })
        .perParticle,
    ).toBeUndefined();
  });
});

describe("coerceParamValue", () => {
  it("coerces per type with fallbacks", () => {
    expect(coerceParamValue("float", "x", 3)).toBe(3);
    expect(coerceParamValue("bool", "x", true)).toBe(true);
    expect(coerceParamValue("texture", 5, "fallback.png")).toBe("fallback.png");
    expect(coerceParamValue("color", [2, 2, 2, 2], [1, 1, 1, 1])).toEqual([
      1, 1, 1, 1,
    ]);
  });
});

describe("normalizeMaterialInstance", () => {
  it("keeps only typed overrides and defaults shaderId to sprite-master", () => {
    const inst = normalizeMaterialInstance({
      id: "mi1",
      paramOverrides: {
        a: 1,
        b: "tex.png",
        c: [1, 0, 0, 1],
        bad: { nope: true },
      },
    });
    expect(inst.shaderId).toBe(SPRITE_MASTER_SHADER_ID);
    expect(inst.paramOverrides).toEqual({
      a: 1,
      b: "tex.png",
      c: [1, 0, 0, 1],
    });
  });

  it("normalizes a mainTex ref or null", () => {
    expect(
      normalizeMaterialInstance({ mainTex: { path: "fx/fire.png" } }).mainTex,
    ).toEqual({
      type: "texture",
      id: "fx/fire.png",
      path: "fx/fire.png",
    });
    expect(
      normalizeMaterialInstance({ mainTex: { id: "x" } }).mainTex,
    ).toBeNull();
  });
});

describe("resolveMaterialParamValue", () => {
  const graph = createSpriteMasterGraph();
  const instance = createMaterialInstance(graph, "mi");

  it("returns the default when not overridden", () => {
    expect(resolveMaterialParamValue(graph, instance, "Opacity")).toBe(1);
  });

  it("applies and coerces an override", () => {
    const overridden: MaterialInstance = {
      ...instance,
      paramOverrides: { Opacity: 0.25, Tint: [1, 0, 0, 1] },
    };
    expect(resolveMaterialParamValue(graph, overridden, "Opacity")).toBe(0.25);
    expect(resolveMaterialParamValue(graph, overridden, "Tint")).toEqual([
      1, 0, 0, 1,
    ]);
  });

  it("returns undefined for unknown params", () => {
    expect(resolveMaterialParamValue(graph, instance, "Nope")).toBeUndefined();
  });

  it("uses instance mainTex as the effective MainTex param value", () => {
    const overridden: MaterialInstance = {
      ...instance,
      mainTex: { type: "texture", id: "B", path: "fx/B.png" },
    };

    expect(resolveMaterialParamValue(graph, overridden, "MainTex")).toBe(
      "fx/B.png",
    );
    expect(resolveEffectiveMainTexPath(graph, overridden)).toBe("fx/B.png");
  });

  it("falls back to the graph MainTex default when no instance texture is set", () => {
    const graphWithDefault = normalizeShaderGraph({
      id: "M_DefaultTex",
      params: [
        {
          name: "MainTex",
          type: "texture",
          group: "Texture",
          default: "fx/A.png",
        },
      ],
    });

    expect(resolveEffectiveMainTexPath(graphWithDefault, instance)).toBe(
      "fx/A.png",
    );
  });
});

// I13-D fix round 1, finding 13: this is a RESOLVER-CONTRACT test, NOT the D
// eviction pin. It proves resolveMaterialParamValue returns whichever graph's
// default it is handed once the override is cleared (fresh graph -> new default,
// stale graph -> old default) — the invariant held verbatim on base 4a4bd7a; the
// resolver was never the I13-D defect. The actual D fix (evicting MaterialField's
// graph cache on PROJECT_MATERIALS_CHANGED so the *fresh* graph is the one handed
// here) is pinned by MaterialField.test.tsx "createMaterialsChangedHandler".
// Kept here so the resolver contract this fix relies on can't silently drift.
describe("resolveMaterialParamValue — resolver contract for reset (I13-D resolver-level, not the eviction pin)", () => {
  it("resolves whichever graph's default it is handed once the override is cleared", () => {
    const staleGraph = normalizeShaderGraph({
      id: "M_Stale",
      params: [
        { name: "Opacity", type: "float", group: "Surface", default: 0.2 },
      ],
    });
    const freshGraph = normalizeShaderGraph({
      id: "M_Fresh",
      params: [
        { name: "Opacity", type: "float", group: "Surface", default: 0.8 },
      ],
    });
    const instance: MaterialInstance = {
      id: "mi",
      shaderId: "M",
      paramOverrides: { Opacity: 0.5 },
      mainTex: null,
    };

    // Model the reset button's clear (delete the override key). The editor helper
    // clearInstanceParamOverride lives under src/editor and cannot be imported
    // into a runtime-layer test (runtimeBoundary guard forbids @/editor imports);
    // an inline delete is byte-equivalent to its clone + delete paramOverrides.
    const cleared: MaterialInstance = { ...instance, paramOverrides: {} };

    // After the override is cleared, the resolved value tracks whichever graph
    // is passed — so a freshened graph (post-D eviction) yields the NEW default,
    // and a stale cached graph yields the OLD default (the bug I13-D fixes).
    expect(resolveMaterialParamValue(freshGraph, cleared, "Opacity")).toBe(0.8);
    expect(resolveMaterialParamValue(staleGraph, cleared, "Opacity")).toBe(0.2);
  });

  it("coerces a lingering old-type override after a param type change", () => {
    const graph = normalizeShaderGraph({
      id: "M_TypeChange",
      params: [{ name: "P", type: "float", group: "G", default: 1 }],
    });
    const instance: MaterialInstance = {
      id: "mi",
      shaderId: "M",
      paramOverrides: { P: "0.3" },
      mainTex: null,
    };

    // A stale string override against a now-float param must coerce (no throw).
    expect(typeof resolveMaterialParamValue(graph, instance, "P")).toBe(
      "number",
    );
  });
});

describe("Sprite Master builtin", () => {
  it("exposes the fixed-function controls as params", () => {
    const graph = createSpriteMasterGraph();
    expect(isSpriteMasterGraph(graph)).toBe(true);
    expect(graph.params.map((p) => p.name).sort()).toEqual([
      "Emissive",
      "MainTex",
      "Opacity",
      "Tint",
    ]);
    expect(graph.builtin).toBe("sprite-master");
  });
});

describe("serialize persist-when-non-default", () => {
  it("omits default fields", () => {
    const graph: ShaderGraph = normalizeShaderGraph({
      id: "M",
      params: [{ name: "P", type: "float", group: "G", default: 1 }],
    });
    const serialized = serializeShaderGraph(graph);
    expect(serialized.opacityMaskClipValue).toBeUndefined();
    const param = (serialized.params as Record<string, unknown>[])[0];
    expect(param.scope).toBeUndefined(); // per-material is the default
    expect(param.perParticle).toBeUndefined();
  });

  it("sorts override keys deterministically and omits empty overrides", () => {
    const empty = serializeMaterialInstance({
      id: "mi",
      shaderId: "M",
      paramOverrides: {},
    });
    expect(empty.paramOverrides).toBeUndefined();

    const withOverrides = serializeMaterialInstance({
      id: "mi",
      shaderId: "M",
      paramOverrides: { z: 1, a: 2, m: 3 },
    });
    expect(Object.keys(withOverrides.paramOverrides as object)).toEqual([
      "a",
      "m",
      "z",
    ]);
  });
});
