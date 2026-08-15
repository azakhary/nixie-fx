import { describe, expect, it } from "vitest";
import { derivedTextureCacheKey } from "../assets/derivedTextures";
import type {
  MaterialEdge,
  MaterialNode,
  MaterialParam,
  ShaderGraph,
} from "../schema/materials";
import {
  createMaterialInstance,
  createSpriteMasterGraph,
  normalizeShaderGraph,
} from "../schema/materials";
import {
  analyzeOpacityIsConstantOne,
  analyzeParticleColorChannelUsage,
  analyzeGraphTier,
  assignPerParticleFeed,
  compileMaterial,
  DEFERRED_NODE_TYPES,
  materialDigest,
} from "./compileMaterial";
import { buildGradientLut, makeTexelEvaluator, sampleGradient } from "./bake";
import type { GradientStop } from "./bake";
import { linearToSrgb } from "../../engine/particles";

// ---------------------------------------------------------------------------
// Graph fixture builders
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

// ---------------------------------------------------------------------------
// Tier selection (techspec §6.2, §12)
// ---------------------------------------------------------------------------

describe("analyzeGraphTier", () => {
  it("treats an empty graph and the Sprite Master builtin as Tier 1", () => {
    expect(analyzeGraphTier(graph({})).tier).toBe("tier1-fixed");
    expect(analyzeGraphTier(createSpriteMasterGraph()).tier).toBe(
      "tier1-fixed",
    );
  });

  it("static texture × tint → Tier 0 (bake)", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("tint", "constant", {}, { value: [1, 0.5, 0.2, 1] }),
        node("mul", "multiply", { a: "e1", b: "e2" }),
      ],
      edges: [edge("e1", "tex", "mul", "a"), edge("e2", "tint", "mul", "b")],
      outputs: { baseColor: "e3" },
    });
    // wire the multiply output into baseColor
    g.edges.push(edge("e3", "mul", "out-node", "baseColor"));
    g.outputs.baseColor = "e3";
    expect(analyzeGraphTier(g).tier).toBe("tier0-bake");
  });

  it("a static desaturate (constant fraction) still bakes → Tier 0", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("grey", "desaturate", { in: "e1" }, { fraction: 1 }),
      ],
      edges: [
        edge("e1", "tex", "grey", "in"),
        edge("e2", "grey", "out", "baseColor"),
      ],
      outputs: { baseColor: "e2" },
    });
    expect(analyzeGraphTier(g).tier).toBe("tier0-bake");
  });

  it("a static fresnel (no dynamic input) bakes → Tier 0", () => {
    const g = graph({
      nodes: [node("fres", "fresnel", {}, { power: 2 })],
      edges: [edge("e1", "fres", "out", "emissive")],
      outputs: { emissive: "e1" },
    });
    expect(analyzeGraphTier(g).tier).toBe("tier0-bake");
  });

  it("a static sphereMask bakes → Tier 0", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("mask", "sphereMask", {}, { radius: 0.3 }),
      ],
      edges: [
        edge("e1", "tex", "out", "baseColor"),
        edge("e2", "mask", "out", "opacity"),
      ],
      outputs: { baseColor: "e1", opacity: "e2" },
    });
    expect(analyzeGraphTier(g).tier).toBe("tier0-bake");
  });

  it("per-life gradient ramp (ParticleRelativeTime) → Tier 2 (M6-A: honors the wired network)", () => {
    const g = graph({
      nodes: [
        node("age", "particleRelativeTime"),
        node(
          "ramp",
          "gradientRamp",
          { t: "e1" },
          {
            stops: [
              { position: 0, color: [1, 1, 1, 1] },
              { position: 1, color: [1, 0, 0, 0] },
            ],
          },
        ),
      ],
      edges: [
        edge("e1", "age", "ramp", "t"),
        edge("e2", "ramp", "out", "baseColor"),
      ],
      outputs: { baseColor: "e2" },
    });
    // M6-A: baseColor is driven by a per-particle gradientRamp, NOT the bare
    // "Tint" magic param, so it is not Tier-1 faithful — the old fallback
    // collapsed it to tier1-fixed{tint:[1,1,1,1]} (a no-op that ignored the
    // ramp). It now escalates to a real Tier-2 shader so the ramp drives the
    // particle. (Per-particle + non-bakeable time signal ⇒ Tier 2, not Tier 0.)
    expect(analyzeGraphTier(g).tier).toBe("tier2-shader");
  });

  it("animated Panner feeding ONLY the texture UV pin → Tier 1 (vertex stage)", () => {
    const g = graph({
      nodes: [
        node("uv", "uv"),
        node("time", "time"),
        node("pan", "panner", { uv: "e1", time: "e2" }, { speed: [0.1, 0] }),
        node("tex", "textureSample", { uv: "e3" }),
      ],
      edges: [
        edge("e1", "uv", "pan", "uv"),
        edge("e2", "time", "pan", "time"),
        edge("e3", "pan", "tex", "uv"),
        edge("e4", "tex", "out", "baseColor"),
      ],
      outputs: { baseColor: "e4" },
    });
    const analysis = analyzeGraphTier(g);
    expect(analysis.tier).toBe("tier1-fixed");
    expect(analysis.vertexUvNodeIds).toContain("pan");
  });

  it("per-particle dissolve threshold + per-particle tint → Tier 2", () => {
    const g = graph({
      params: [
        {
          name: "Dissolve",
          type: "float",
          group: "FX",
          default: 0.5,
          sliderMin: 0,
          sliderMax: 1,
          scope: "per-material",
          perParticle: true,
        } as MaterialParam,
      ],
      nodes: [
        node("tex", "textureSample"),
        node("dyn", "dynamicParameter"),
        node("thresh", "step", { in: "e1" }, { edge: 0.5 }),
      ],
      edges: [
        edge("e1", "dyn", "thresh", "in"),
        edge("e2", "thresh", "out", "opacityMask"),
        edge("e3", "tex", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3", opacityMask: "e2" },
    });
    expect(analyzeGraphTier(g).tier).toBe("tier2-shader");
  });

  it("a deferred node (sceneColor) reachable from an output → Tier 3", () => {
    const g = graph({
      nodes: [
        node("scene", "sceneColor" as MaterialNode["type"]),
        node("tex", "textureSample"),
        node("mul", "multiply", { a: "e1", b: "e2" }),
      ],
      edges: [
        edge("e1", "tex", "mul", "a"),
        edge("e2", "scene", "mul", "b"),
        edge("e3", "mul", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3" },
    });
    // sceneColor is dropped by normalizeShaderGraph (unknown type); inject raw.
    const raw: ShaderGraph = {
      ...g,
      nodes: [
        node("scene", "sceneColor" as MaterialNode["type"]),
        node("tex", "textureSample"),
        node("mul", "multiply", { a: "e1", b: "e2" }),
      ],
      edges: [
        edge("e1", "tex", "mul", "a"),
        edge("e2", "scene", "mul", "b"),
        edge("e3", "mul", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3" },
    };
    const analysis = analyzeGraphTier(raw);
    expect(analysis.tier).toBe("tier3-defer");
    expect(analysis.deferredNodeIds).toContain("scene");
  });

  it("only counts deferred nodes reachable from honored outputs", () => {
    const g: ShaderGraph = {
      ...graph({}),
      nodes: [
        node("tex", "textureSample"),
        // a dangling deferred node not wired into any output
        node("scene", "sceneColor" as MaterialNode["type"]),
      ],
      edges: [edge("e1", "tex", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    };
    expect(analyzeGraphTier(g).tier).toBe("tier0-bake");
  });

  it("documents the deferred-node allowlist (custom, sceneColor...)", () => {
    expect(DEFERRED_NODE_TYPES.has("custom")).toBe(true);
    expect(DEFERRED_NODE_TYPES.has("sceneColor")).toBe(true);
    expect(DEFERRED_NODE_TYPES.has("multiply")).toBe(false);
    // iteration 5b: noise / vectorNoise / particleMacroUV bake (or escalate to
    // Tier 2), so they are no longer in the deferred allowlist.
    expect(DEFERRED_NODE_TYPES.has("noise")).toBe(false);
    expect(DEFERRED_NODE_TYPES.has("particleMacroUV")).toBe(false);
  });

  it("a static noise graph bakes → Tier 0", () => {
    const g = graph({
      nodes: [node("n", "noise", {}, { function: "perlinGradient", scale: 8 })],
      edges: [edge("e1", "n", "out", "opacity")],
      outputs: { opacity: "e1" },
    });
    expect(analyzeGraphTier(g).tier).toBe("tier0-bake");
  });

  it("runtime procedural noise (params.runtime) escalates → Tier 2", () => {
    const g = graph({
      nodes: [node("n", "noise", {}, { runtime: true })],
      edges: [edge("e1", "n", "out", "opacity")],
      outputs: { opacity: "e1" },
    });
    expect(analyzeGraphTier(g).tier).toBe("tier2-shader");
  });

  it("a static antialiasedTextureMask / sphericalParticleOpacity bake → Tier 0", () => {
    const mask = graph({
      nodes: [
        node("tex", "textureSample"),
        node("m", "antialiasedTextureMask", {}, { channel: "a" }),
      ],
      edges: [
        edge("e1", "tex", "out", "baseColor"),
        edge("e2", "m", "out", "opacityMask"),
      ],
      outputs: { baseColor: "e1", opacityMask: "e2" },
    });
    expect(analyzeGraphTier(mask).tier).toBe("tier0-bake");

    const glow = graph({
      nodes: [node("s", "sphericalParticleOpacity", {}, { radius: 0.4 })],
      edges: [edge("e1", "s", "out", "opacity")],
      outputs: { opacity: "e1" },
    });
    expect(analyzeGraphTier(glow).tier).toBe("tier0-bake");
  });

  // -------------------------------------------------------------------------
  // M6-A: isTier1Faithful routing — the headline "materials don't change the
  // particle" fix. A graph that drives an output through NODES (not the bare
  // canonical magic param) must NOT collapse to a no-op tier1-fixed; it must
  // bake (Tier 0) or escalate (Tier 2) so the wiring is honored.
  // -------------------------------------------------------------------------

  it("M6-A: a bare 'Tint' color param → baseColor is faithful; static ⇒ Tier 0 bake (honors the tint, not a no-op)", () => {
    const g = graph({
      params: [
        {
          name: "Tint",
          type: "color",
          group: "Color",
          default: [0.2, 0.4, 0.6, 1],
          scope: "per-material",
        } as MaterialParam,
      ],
      nodes: [node("p", "param", {}, { name: "Tint" })],
      edges: [edge("e1", "p", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    // The Tint param node IS Tier-1 faithful, but the graph is fully static &
    // bakeable, so the EXISTING tier0 return (kept unchanged) wins — and the
    // bake honors the tint. (Color params are float-only-perParticle-ineligible,
    // so a bare Tint never reaches the faithful Tier-1 fallback by itself; the
    // faithful Tier-1 path is exercised by the vertex-UV texture case below.)
    expect(analyzeGraphTier(g).tier).toBe("tier0-bake");
  });

  it("M6-A: a bare textureSample → baseColor with an animated panner (vertex-UV) IS faithful → Tier 1", () => {
    const g = graph({
      nodes: [
        node("uv", "uv"),
        node("time", "time"),
        node("pan", "panner", { uv: "e1", time: "e2" }, { speed: [0.1, 0] }),
        node("tex", "textureSample", { uv: "e3" }),
      ],
      edges: [
        edge("e1", "uv", "pan", "uv"),
        edge("e2", "time", "pan", "time"),
        edge("e3", "pan", "tex", "uv"),
        edge("e4", "tex", "out", "baseColor"),
      ],
      outputs: { baseColor: "e4" },
    });
    // baseColor ← bare textureSample (the texture-only path resolveFixed
    // reproduces byte-identically) + vertex-UV panner ⇒ faithful, NOT preempted
    // by tier0 (vertexUvNodeIds is non-empty) ⇒ Tier-1 fixed.
    const analysis = analyzeGraphTier(g);
    expect(analysis.tier).toBe("tier1-fixed");
    expect(analysis.vertexUvNodeIds).toContain("pan");
  });

  it("M6-A: a non-white Constant color → baseColor (no Tint param) is NOT faithful → bakes (Tier 0), not a no-op Tier 1", () => {
    const g = graph({
      nodes: [node("c", "constant", {}, { value: [0.2, 0.4, 0.6, 1] })],
      edges: [edge("e1", "c", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    // A Constant is not the bare "Tint" magic param, so resolveFixed cannot
    // carry it. It is fully static & bakeable → Tier 0 (the bake honors the
    // color), NOT the old no-op tier1-fixed{tint:[1,1,1,1]}.
    expect(analyzeGraphTier(g).tier).toBe("tier0-bake");
  });

  it("M6-A: particleColor → baseColor is NOT faithful → escalates to Tier 2", () => {
    const g = graph({
      nodes: [node("pc", "particleColor")],
      edges: [edge("e1", "pc", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    // Per-particle + not the bare Tint param ⇒ a real Tier-2 shader (reads
    // vColor), never the old tier1-fixed no-op.
    expect(analyzeGraphTier(g).tier).toBe("tier2-shader");
  });
});

describe("analyzeParticleColorChannelUsage", () => {
  it("ignores orphaned Particle Color nodes", () => {
    const g = graph({
      nodes: [node("pc", "particleColor")],
      outputs: {},
    });

    expect(analyzeParticleColorChannelUsage(g)).toEqual({
      rgb: false,
      alpha: false,
    });
  });

  it("tracks direct RGB and alpha usage independently", () => {
    const rgb = graph({
      nodes: [node("pc", "particleColor")],
      edges: [edge("e1", "pc", "out", "baseColor", "RGB")],
      outputs: { baseColor: "e1" },
    });
    const alpha = graph({
      nodes: [node("pc", "particleColor")],
      edges: [edge("e1", "pc", "out", "opacity", "A")],
      outputs: { opacity: "e1" },
    });

    expect(analyzeParticleColorChannelUsage(rgb)).toEqual({
      rgb: true,
      alpha: false,
    });
    expect(analyzeParticleColorChannelUsage(alpha)).toEqual({
      rgb: false,
      alpha: true,
    });
  });

  it("tracks chained Particle Color alpha usage to honored outputs", () => {
    const g = graph({
      nodes: [
        node("pc", "particleColor"),
        node("half", "constant", {}, { value: 0.5 }),
        node("mul", "multiply", { a: "e1", b: "e2" }),
      ],
      edges: [
        edge("e1", "pc", "mul", "a", "A"),
        edge("e2", "half", "mul", "b"),
        edge("e3", "mul", "out", "opacityMask"),
      ],
      outputs: { opacityMask: "e3" },
    });

    expect(analyzeParticleColorChannelUsage(g)).toEqual({
      rgb: false,
      alpha: true,
    });
  });

  it("keeps vColor live for reachable legacy vColor consumers", () => {
    const dynamic = graph({
      nodes: [node("dyn", "dynamicParameter")],
      edges: [edge("e1", "dyn", "out", "opacity", "Param1")],
      outputs: { opacity: "e1" },
    });
    const relativeTime = graph({
      nodes: [node("age", "particleRelativeTime")],
      edges: [edge("e1", "age", "out", "opacity")],
      outputs: { opacity: "e1" },
    });
    const random = graph({
      nodes: [node("rnd", "particleRandom")],
      edges: [edge("e1", "rnd", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });

    expect(analyzeParticleColorChannelUsage(dynamic)).toEqual({
      rgb: false,
      alpha: false,
    });
    expect(analyzeParticleColorChannelUsage(relativeTime)).toEqual({
      rgb: false,
      alpha: true,
    });
    expect(analyzeParticleColorChannelUsage(random)).toEqual({
      rgb: true,
      alpha: false,
    });
  });

  it("stamps particle color usage flags onto compiled artifacts", () => {
    const none = compileMaterial(
      graph({}),
      createMaterialInstance(graph({}), "i"),
    );
    expect(none.usesParticleColorRGB).toBe(false);
    expect(none.usesParticleColorAlpha).toBe(false);

    const rgb = graph({
      nodes: [node("pc", "particleColor")],
      edges: [edge("e1", "pc", "out", "baseColor", "RGB")],
      outputs: { baseColor: "e1" },
    });
    const rgbArtifact = compileMaterial(rgb, createMaterialInstance(rgb, "i"));
    expect(rgbArtifact.tier).toBe("tier2-shader");
    expect(rgbArtifact.usesParticleColorRGB).toBe(true);
    expect(rgbArtifact.usesParticleColorAlpha).toBe(false);
  });
});

describe("analyzeOpacityIsConstantOne", () => {
  it("unwired opacity → constant 1 (I11 gate decision)", () => {
    expect(analyzeOpacityIsConstantOne(graph({}))).toBe(true);
    const baseOnly = graph({
      nodes: [node("tex", "textureSample")],
      edges: [edge("e1", "tex", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    expect(analyzeOpacityIsConstantOne(baseOnly)).toBe(true);
  });

  it("a literal constant 1 → true; any other constant → false", () => {
    const constant = (value: unknown) =>
      graph({
        nodes: [node("c", "constant", {}, { value })],
        edges: [edge("e1", "c", "out", "opacity")],
        outputs: { opacity: "e1" },
      });
    expect(analyzeOpacityIsConstantOne(constant(1))).toBe(true);
    expect(analyzeOpacityIsConstantOne(constant(0.4))).toBe(false);
    expect(analyzeOpacityIsConstantOne(constant(0))).toBe(false);
    expect(analyzeOpacityIsConstantOne(constant(undefined))).toBe(false);
  });

  it("reads the channel the opacity slot actually consumes", () => {
    const channelConstant = (value: unknown, sourceHandle: string) =>
      graph({
        nodes: [node("c", "constant", {}, { value })],
        edges: [edge("e1", "c", "out", "opacity", sourceHandle)],
        outputs: { opacity: "e1" },
      });
    expect(
      analyzeOpacityIsConstantOne(channelConstant([1, 0, 0, 0.4], "R")),
    ).toBe(true);
    expect(
      analyzeOpacityIsConstantOne(channelConstant([1, 0, 0, 0.4], "A")),
    ).toBe(false);
    // The default handle reads .r of the constant vec.
    expect(
      analyzeOpacityIsConstantOne(channelConstant([0.4, 1, 1, 1], "out")),
    ).toBe(false);
  });

  it("anything live feeding opacity is conservatively non-constant", () => {
    const particleFed = graph({
      nodes: [node("pc", "particleColor")],
      edges: [edge("e1", "pc", "out", "opacity", "A")],
      outputs: { opacity: "e1" },
    });
    expect(analyzeOpacityIsConstantOne(particleFed)).toBe(false);

    const textureFed = graph({
      nodes: [node("tex", "textureSample")],
      edges: [edge("e1", "tex", "out", "opacity", "A")],
      outputs: { opacity: "e1" },
    });
    expect(analyzeOpacityIsConstantOne(textureFed)).toBe(false);

    // A ParabMat-style math chain stays non-constant even with constant leaves.
    const mathChain = graph({
      nodes: [
        node("c1", "constant", {}, { value: 1 }),
        node("c2", "constant", {}, { value: 1 }),
        node("mul", "multiply", { a: "e-a", b: "e-b" }),
      ],
      edges: [
        edge("e-a", "c1", "mul", "a"),
        edge("e-b", "c2", "mul", "b"),
        edge("e1", "mul", "out", "opacity"),
      ],
      outputs: { opacity: "e1" },
    });
    expect(analyzeOpacityIsConstantOne(mathChain)).toBe(false);
  });

  it("stamps the flag onto compiled artifacts", () => {
    const live = graph({
      nodes: [
        node("dyn", "dynamicParameter"),
        node("c", "constant", {}, { value: 0.4 }),
      ],
      edges: [
        edge("e-base", "dyn", "out", "baseColor"),
        edge("e-opacity", "c", "out", "opacity"),
      ],
      outputs: { baseColor: "e-base", opacity: "e-opacity" },
    });
    const liveArtifact = compileMaterial(
      live,
      createMaterialInstance(live, "i"),
    );
    expect(liveArtifact.tier).toBe("tier2-shader");
    expect(liveArtifact.opacityIsConstantOne).toBe(false);

    const unwired = graph({
      nodes: [node("dyn", "dynamicParameter")],
      edges: [edge("e-base", "dyn", "out", "baseColor")],
      outputs: { baseColor: "e-base" },
    });
    const unwiredArtifact = compileMaterial(
      unwired,
      createMaterialInstance(unwired, "i"),
    );
    expect(unwiredArtifact.tier).toBe("tier2-shader");
    expect(unwiredArtifact.opacityIsConstantOne).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compileMaterial artifact shape (techspec §6.1)
// ---------------------------------------------------------------------------

describe("compileMaterial", () => {
  it("Sprite Master compiles to a Tier-1 fixed-function artifact", () => {
    const g = createSpriteMasterGraph();
    const instance = createMaterialInstance(g, "inst");
    instance.paramOverrides.Tint = [0.5, 0.25, 0.1, 1];
    instance.paramOverrides.Emissive = 2;
    instance.paramOverrides.Opacity = 0.75;
    const art = compileMaterial(g, instance);
    expect(art.tier).toBe("tier1-fixed");
    expect(art.shaderId).toBe("sprite-master");
    expect(art.fixed?.tint).toEqual([0.5, 0.25, 0.1, 1]);
    expect(art.fixed?.emissive).toBe(2);
    expect(art.fixed?.opacity).toBe(0.75);
    expect(art.deferredNodeIds).toEqual([]);
  });

  it("propagates the authoritative graph blend into every artifact (I12-G)", () => {
    // Tier 0: static texture graph.
    const tier0 = graph({
      blend: "masked",
      nodes: [node("tex", "textureSample")],
      edges: [edge("e1", "tex", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    const art0 = compileMaterial(tier0, createMaterialInstance(tier0, "i"));
    expect(art0.tier).toBe("tier0-bake");
    expect(art0.blend).toBe("masked");
    expect(art0.fixed?.blend).toBe("masked");

    // Tier 2: live per-particle graph.
    const tier2 = graph({
      blend: "opaque",
      nodes: [node("dyn", "dynamicParameter")],
      edges: [edge("e1", "dyn", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    const art2 = compileMaterial(tier2, createMaterialInstance(tier2, "i"));
    expect(art2.tier).toBe("tier2-shader");
    expect(art2.blend).toBe("opaque");
    expect(art2.fixed?.blend).toBe("opaque");
  });

  it("distinct blends fork the material digest and Tier-2 shaderId", () => {
    const shape = {
      nodes: [node("dyn", "dynamicParameter")],
      edges: [edge("e1", "dyn", "out", "baseColor")],
      outputs: { baseColor: "e1" as string | null },
    };
    const masked = graph({ ...shape, blend: "masked" });
    const opaque = graph({ ...shape, blend: "opaque" });
    expect(
      materialDigest(masked, createMaterialInstance(masked, "i"), 1),
    ).not.toBe(materialDigest(opaque, createMaterialInstance(opaque, "i"), 1));
    expect(
      compileMaterial(masked, createMaterialInstance(masked, "i")).shaderId,
    ).not.toBe(
      compileMaterial(opaque, createMaterialInstance(opaque, "i")).shaderId,
    );
  });

  it("Tier 0 emits a deterministic bakeHash that depends on mainTexUid", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("tint", "constant", {}, { value: [1, 0.5, 0.2, 1] }),
        node("mul", "multiply", { a: "e1", b: "e2" }),
      ],
      edges: [
        edge("e1", "tex", "mul", "a"),
        edge("e2", "tint", "mul", "b"),
        edge("e3", "mul", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3" },
    });
    const instance = createMaterialInstance(g, "inst");
    const a = compileMaterial(g, instance, { mainTexUid: 7 });
    const b = compileMaterial(g, instance, { mainTexUid: 7 });
    const c = compileMaterial(g, instance, { mainTexUid: 8 });
    expect(a.tier).toBe("tier0-bake");
    expect(a.bakeHash).toBeTruthy();
    expect(a.bakeHash).toBe(b.bakeHash); // determinism
    expect(a.bakeHash).not.toBe(c.bakeHash); // mainTexUid changes the hash
  });

  it("bakeHash changes when an instance override changes", () => {
    const g = graph({
      params: [
        {
          name: "Tint",
          type: "color",
          group: "Color",
          default: [1, 1, 1, 1],
          scope: "per-material",
        } as MaterialParam,
      ],
      nodes: [
        node("tex", "textureSample"),
        node("p", "param", {}, { name: "Tint" }),
        node("mul", "multiply", { a: "e1", b: "e2" }),
      ],
      edges: [
        edge("e1", "tex", "mul", "a"),
        edge("e2", "p", "mul", "b"),
        edge("e3", "mul", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3" },
    });
    const i1 = createMaterialInstance(g, "inst");
    const i2 = createMaterialInstance(g, "inst");
    i2.paramOverrides.Tint = [0.2, 0.2, 0.2, 1];
    const h1 = compileMaterial(g, i1, { mainTexUid: 1 }).bakeHash;
    const h2 = compileMaterial(g, i2, { mainTexUid: 1 }).bakeHash;
    expect(h1).not.toBe(h2);
  });

  it("Tier 2 mints a distinct shaderId; Tier 0/1 share 'sprite-master'", () => {
    const tier1 = compileMaterial(
      createSpriteMasterGraph(),
      createMaterialInstance(createSpriteMasterGraph(), "i"),
    );
    expect(tier1.shaderId).toBe("sprite-master");

    const g = graph({
      params: [
        {
          name: "Dissolve",
          type: "float",
          group: "FX",
          default: 0.5,
          sliderMin: 0,
          sliderMax: 1,
          scope: "per-material",
          perParticle: true,
        } as MaterialParam,
      ],
      nodes: [
        node("tex", "textureSample"),
        node("dyn", "dynamicParameter"),
        node("thresh", "step", { in: "e1" }),
      ],
      edges: [
        edge("e1", "dyn", "thresh", "in"),
        edge("e2", "thresh", "out", "opacityMask"),
        edge("e3", "tex", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3", opacityMask: "e2" },
    });
    const tier2 = compileMaterial(g, createMaterialInstance(g, "i"));
    expect(tier2.tier).toBe("tier2-shader");
    expect(tier2.shaderId).not.toBe("sprite-master");
    expect(tier2.shaderId.startsWith("mat-")).toBe(true);
  });

  it("supported Tier 2 per-particle dissolve has no preview-only diagnostic", () => {
    const g = graph({
      params: [
        {
          name: "Dissolve",
          type: "float",
          group: "FX",
          default: 0.5,
          sliderMin: 0,
          sliderMax: 1,
          scope: "per-material",
          perParticle: true,
        } as MaterialParam,
      ],
      nodes: [
        node("tex", "textureSample"),
        node("dyn", "dynamicParameter"),
        node("thresh", "step", { in: "e1" }),
      ],
      edges: [
        edge("e1", "dyn", "thresh", "in"),
        edge("e2", "thresh", "out", "opacityMask"),
        edge("e3", "tex", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3", opacityMask: "e2" },
    });
    const art = compileMaterial(g, createMaterialInstance(g, "i"));
    expect(art.tier).toBe("tier2-shader");
    expect(
      art.diagnostics.some((msg) => msg.includes("NOT on particles")),
    ).toBe(false);
    expect(
      art.diagnostics.some((msg) => msg.includes("custom Mesh path required")),
    ).toBe(false);
  });

  it("wide per-particle DynamicParameter keeps an actionable Mesh-path diagnostic", () => {
    const g = graph({
      params: [
        {
          name: "Dissolve",
          type: "float",
          group: "FX",
          default: 0.5,
          sliderMin: 0,
          sliderMax: 4,
          scope: "per-material",
          perParticle: true,
        } as MaterialParam,
      ],
      nodes: [
        node("tex", "textureSample"),
        node("dyn", "dynamicParameter"),
        node("thresh", "step", { in: "e1" }),
      ],
      edges: [
        edge("e1", "dyn", "thresh", "in"),
        edge("e2", "thresh", "out", "opacityMask"),
        edge("e3", "tex", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3", opacityMask: "e2" },
    });
    const art = compileMaterial(g, createMaterialInstance(g, "i"));
    expect(art.tier).toBe("tier2-shader");
    expect(art.perParticleFeeds.Dissolve).toBe("mesh-attr");
    expect(
      art.diagnostics.some((msg) => msg.includes("custom Mesh path required")),
    ).toBe(true);
  });

  it("Tier 3 produces a diagnostic and lists the deferred node ids", () => {
    const g: ShaderGraph = {
      ...graph({}),
      nodes: [node("scene", "sceneColor" as MaterialNode["type"])],
      edges: [edge("e1", "scene", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    };
    const art = compileMaterial(g, createMaterialInstance(g, "i"));
    expect(art.tier).toBe("tier3-defer");
    expect(art.deferredNodeIds).toContain("scene");
    expect(art.diagnostics.length).toBeGreaterThan(0);
    expect(art.diagnostics[0]).toContain("Tier 3");
  });

  it("captures the vertex-stage Panner offset in fixed.uvPan", () => {
    const g = graph({
      nodes: [
        node("uv", "uv"),
        node("time", "time"),
        node("pan", "panner", { uv: "e1", time: "e2" }, { speed: [0.3, -0.1] }),
        node("tex", "textureSample", { uv: "e3" }),
      ],
      edges: [
        edge("e1", "uv", "pan", "uv"),
        edge("e2", "time", "pan", "time"),
        edge("e3", "pan", "tex", "uv"),
        edge("e4", "tex", "out", "baseColor"),
      ],
      outputs: { baseColor: "e4" },
    });
    const art = compileMaterial(g, createMaterialInstance(g, "i"));
    expect(art.tier).toBe("tier1-fixed");
    expect(art.fixed?.uvPan?.speed).toEqual([0.3, -0.1]);
  });
});

// ---------------------------------------------------------------------------
// Per-particle feed assignment (techspec §5.0 ladder, §5.1)
// ---------------------------------------------------------------------------

describe("assignPerParticleFeed", () => {
  const base: MaterialParam = {
    name: "P",
    type: "float",
    group: "FX",
    default: 0,
    scope: "per-material",
    perParticle: true,
  };

  it("no slider range → spawn-color (constant-at-spawn)", () => {
    expect(assignPerParticleFeed(base)).toBe("spawn-color");
  });

  it("bounded 0..1 animated → smuggle-8bit", () => {
    expect(assignPerParticleFeed({ ...base, sliderMin: 0, sliderMax: 1 })).toBe(
      "smuggle-8bit",
    );
  });

  it("unbounded / wide range → mesh-attr (Tier-2 only)", () => {
    expect(
      assignPerParticleFeed({ ...base, sliderMin: 0, sliderMax: 16 }),
    ).toBe("mesh-attr");
  });

  it("an explicit perParticleFeed is honored verbatim", () => {
    expect(
      assignPerParticleFeed({
        ...base,
        sliderMin: 0,
        sliderMax: 16,
        perParticleFeed: "smuggle-8bit",
      }),
    ).toBe("smuggle-8bit");
  });

  it("compileMaterial records feeds for every per-particle param", () => {
    const g = graph({
      params: [
        { ...base, name: "A", sliderMin: 0, sliderMax: 1 },
        { ...base, name: "B", sliderMin: 0, sliderMax: 16 },
      ],
      nodes: [node("tex", "textureSample")],
      edges: [edge("e1", "tex", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    const art = compileMaterial(g, createMaterialInstance(g, "i"));
    expect(art.perParticleFeeds.A).toBe("smuggle-8bit");
    expect(art.perParticleFeeds.B).toBe("mesh-attr");
  });
});

// ---------------------------------------------------------------------------
// Bake evaluator correctness (techspec §6.1, §4, §12)
// ---------------------------------------------------------------------------

describe("bake evaluator", () => {
  it("multiplies the source texel by a constant tint", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("tint", "constant", {}, { value: [0.5, 1, 0.25, 1] }),
        node("mul", "multiply", { a: "e1", b: "e2" }),
      ],
      edges: [
        edge("e1", "tex", "mul", "a"),
        edge("e2", "tint", "mul", "b"),
        edge("e3", "mul", "out", "baseColor"),
      ],
      outputs: { baseColor: "e3" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    const out = evaluate([0.8, 0.6, 0.4, 1], [0, 0]);
    expect(out[0]).toBeCloseTo(0.4, 5);
    expect(out[1]).toBeCloseTo(0.6, 5);
    expect(out[2]).toBeCloseTo(0.1, 5);
    expect(out[3]).toBeCloseTo(1, 5);
  });

  it("folds canonical material controls into Tier-0 baked output", () => {
    const g = graph({
      params: [
        {
          name: "Tint",
          type: "color",
          group: "Color",
          default: [1, 0, 0, 0.75],
          scope: "per-material",
        },
        {
          name: "Emissive",
          type: "float",
          group: "Color",
          default: 1,
          scope: "per-material",
        },
        {
          name: "Opacity",
          type: "float",
          group: "Color",
          default: 0.5,
          scope: "per-material",
        },
      ] as MaterialParam[],
      nodes: [node("base", "constant", {}, { value: [0.5, 0.5, 0.5, 0.8] })],
      edges: [edge("e1", "base", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    const out = evaluate([1, 1, 1, 1], [0.5, 0.5]);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(0, 5);
    expect(out[3]).toBeCloseTo(0.3, 5);
  });

  it("oneMinus inverts a channel", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("inv", "oneMinus", { in: "e1" }),
      ],
      edges: [
        edge("e1", "tex", "inv", "in"),
        edge("e2", "inv", "out", "baseColor"),
      ],
      outputs: { baseColor: "e2" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    const out = evaluate([0.25, 0.5, 0.75, 1], [0, 0]);
    expect(out[0]).toBeCloseTo(0.75, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(0.25, 5);
  });

  it("opacityMask bakes the clip threshold into alpha", () => {
    const g = graph({
      opacityMaskClipValue: 0.5,
      nodes: [
        node("tex", "textureSample"),
        node("split", "split", { in: "e1" }, { channel: "r" }),
      ],
      edges: [
        edge("e1", "tex", "split", "in"),
        edge("e2", "tex", "out", "baseColor"),
        edge("e3", "split", "out", "opacityMask"),
      ],
      outputs: { baseColor: "e2", opacityMask: "e3" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // r=0.8 ≥ clip → keeps source alpha
    expect(evaluate([0.8, 0, 0, 1], [0, 0])[3]).toBeCloseTo(1, 5);
    // Soft passthrough for non-masked blends: partial alpha survives as-is.
    expect(evaluate([0.8, 0, 0, 0.6], [0, 0])[3]).toBeCloseTo(0.6, 5);
    // r=0.3 < clip → discarded (alpha 0)
    expect(evaluate([0.3, 0, 0, 1], [0, 0])[3]).toBeCloseTo(0, 5);
  });

  it("masked with no wired mask thresholds the computed opacity (I12-G)", () => {
    const g = graph({
      blend: "masked",
      opacityMaskClipValue: 0.5,
      nodes: [
        node("tex", "textureSample"),
        node("split", "split", { in: "e1" }, { channel: "r" }),
      ],
      edges: [
        edge("e1", "tex", "split", "in"),
        edge("e2", "tex", "out", "baseColor"),
        edge("e3", "split", "out", "opacity"),
      ],
      outputs: { baseColor: "e2", opacity: "e3" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // True binary: opacity 0.8 ≥ clip bakes to full coverage (alpha 1)…
    expect(evaluate([0.8, 0, 0, 1], [0, 0])[3]).toBeCloseTo(1, 5);
    // …opacity 0.3 < clip clips to fully transparent (no soft alpha).
    expect(evaluate([0.3, 0, 0, 1], [0, 0])[3]).toBeCloseTo(0, 5);
  });

  it("normal blend keeps soft opacity below the clip value (unchanged)", () => {
    const g = graph({
      opacityMaskClipValue: 0.5,
      nodes: [
        node("tex", "textureSample"),
        node("split", "split", { in: "e1" }, { channel: "r" }),
      ],
      edges: [
        edge("e1", "tex", "split", "in"),
        edge("e2", "tex", "out", "baseColor"),
        edge("e3", "split", "out", "opacity"),
      ],
      outputs: { baseColor: "e2", opacity: "e3" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    expect(evaluate([0.3, 0, 0, 1], [0, 0])[3]).toBeCloseTo(0.3, 5);
  });

  it("masked with a wired mask bakes a true binary alpha", () => {
    const g = graph({
      blend: "masked",
      opacityMaskClipValue: 0.5,
      nodes: [
        node("tex", "textureSample"),
        node("split", "split", { in: "e1" }, { channel: "r" }),
      ],
      edges: [
        edge("e1", "tex", "split", "in"),
        edge("e2", "tex", "out", "baseColor"),
        edge("e3", "split", "out", "opacityMask"),
      ],
      outputs: { baseColor: "e2", opacityMask: "e3" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // Mask 0.8 ≥ clip → full coverage (alpha exactly 1) even though the
    // source alpha is 0.5: the mask gates draw/no-draw, Unreal-style.
    expect(evaluate([0.8, 0, 0, 0.5], [0, 0])[3]).toBeCloseTo(1, 5);
    expect(evaluate([0.8, 0, 0, 1], [0, 0])[3]).toBeCloseTo(1, 5);
    // Mask 0.3 < clip → fully transparent.
    expect(evaluate([0.3, 0, 0, 0.5], [0, 0])[3]).toBeCloseTo(0, 5);
  });

  it("bakes a fresnel radial falloff (bright center, dark edge)", () => {
    const g = graph({
      nodes: [node("fres", "fresnel", {}, { power: 2, center: [0.5, 0.5] })],
      edges: [edge("e1", "fres", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // Fresnel = radial falloff; bright at center UV, dark at the edge UV.
    const center = evaluate([0, 0, 0, 1], [0.5, 0.5]);
    const edgeTexel = evaluate([0, 0, 0, 1], [0, 0.5]);
    expect(center[0]).toBeGreaterThan(0.9);
    expect(edgeTexel[0]).toBeLessThan(0.05);
    expect(center[0]).toBeGreaterThan(edgeTexel[0]);
  });

  it("bakes a sphereMask soft radial mask into alpha via opacity", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node(
          "mask",
          "sphereMask",
          {},
          { center: [0.5, 0.5], radius: 0.3, hardness: 0.5 },
        ),
      ],
      edges: [
        edge("e1", "tex", "out", "baseColor"),
        edge("e2", "mask", "out", "opacity"),
      ],
      outputs: { baseColor: "e1", opacity: "e2" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // Inside the radius alpha ≈ 1, far outside it falls to 0.
    expect(evaluate([1, 1, 1, 1], [0.5, 0.5])[3]).toBeGreaterThan(0.9);
    expect(evaluate([1, 1, 1, 1], [0, 0])[3]).toBeCloseTo(0, 5);
  });

  it("step reads a wired 'edge' input pin over its param (frozen contract)", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("ch", "split", { in: "e1" }, { channel: "r" }),
        // param says 0.9 but the wired edge constant (0.4) must win.
        node("hi", "constant", {}, { value: 0.4 }),
        node("step", "step", { in: "e2", edge: "e3" }, { edge: 0.9 }),
      ],
      edges: [
        edge("e1", "tex", "ch", "in"),
        edge("e2", "ch", "step", "in"),
        edge("e3", "hi", "step", "edge"),
        edge("e4", "step", "out", "opacity"),
      ],
      outputs: { opacity: "e4" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // r=0.5 ≥ wired edge 0.4 → 1 (would be 0 against the 0.9 param).
    expect(evaluate([0.5, 0, 0, 1], [0, 0])[3]).toBeCloseTo(1, 5);
    // r=0.3 < 0.4 → 0.
    expect(evaluate([0.3, 0, 0, 1], [0, 0])[3]).toBeCloseTo(0, 5);
  });

  it("clamp reads wired 'min'/'max' input pins over params", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("lo", "constant", {}, { value: 0.2 }),
        node("hiv", "constant", {}, { value: 0.6 }),
        node(
          "clamp",
          "clamp",
          { in: "e1", min: "e2", max: "e3" },
          { min: 0, max: 1 },
        ),
      ],
      edges: [
        edge("e1", "tex", "clamp", "in"),
        edge("e2", "lo", "clamp", "min"),
        edge("e3", "hiv", "clamp", "max"),
        edge("e4", "clamp", "out", "baseColor"),
      ],
      outputs: { baseColor: "e4" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // 0.9 clamps to wired max 0.6, 0.05 clamps to wired min 0.2.
    expect(evaluate([0.9, 0.05, 0.4, 1], [0, 0])[0]).toBeCloseTo(0.6, 5);
    expect(evaluate([0.9, 0.05, 0.4, 1], [0, 0])[1]).toBeCloseTo(0.2, 5);
    expect(evaluate([0.9, 0.05, 0.4, 1], [0, 0])[2]).toBeCloseTo(0.4, 5);
  });

  it("desaturate at fraction 1 produces a grey luminance", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node("grey", "desaturate", { in: "e1" }, { fraction: 1 }),
      ],
      edges: [
        edge("e1", "tex", "grey", "in"),
        edge("e2", "grey", "out", "baseColor"),
      ],
      outputs: { baseColor: "e2" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    const out = evaluate([1, 0, 0, 1], [0, 0]);
    // 0.2126 luminance for pure red
    expect(out[0]).toBeCloseTo(0.2126, 4);
    expect(out[0]).toBeCloseTo(out[1], 5);
    expect(out[1]).toBeCloseTo(out[2], 5);
  });

  it("a channel source handle (textureSample.R) selects one component", () => {
    // texture.R → opacity. Only the red component should drive alpha.
    const g = graph({
      nodes: [node("tex", "textureSample")],
      edges: [
        edge("e1", "tex", "out", "baseColor"),
        edge("e2", "tex", "out", "opacity", "R"),
      ],
      outputs: { baseColor: "e1", opacity: "e2" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // source = (r=0.7, g=0.2, b=0.1, a=1) → alpha picks r=0.7.
    expect(evaluate([0.7, 0.2, 0.1, 1], [0, 0])[3]).toBeCloseTo(0.7, 5);
  });

  it("legacy 'out' handles still pass the full vector (back-compat)", () => {
    const g = graph({
      nodes: [node("tex", "textureSample")],
      edges: [edge("e1", "tex", "out", "baseColor")], // sourceHandle "out"
      outputs: { baseColor: "e1" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    const out = evaluate([0.4, 0.6, 0.8, 1], [0, 0]);
    expect(out[0]).toBeCloseTo(0.4, 5);
    expect(out[1]).toBeCloseTo(0.6, 5);
    expect(out[2]).toBeCloseTo(0.8, 5);
  });

  it("textureSample reads a node texture sampler when params.tex is set", () => {
    const g = graph({
      nodes: [node("tex", "textureSample", {}, { tex: "alt.png" })],
      edges: [edge("e1", "tex", "out", "baseColor")],
      outputs: { baseColor: "e1" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"), {
      samplerForPath: (path, uv) =>
        path === "alt.png" ? [uv[0], uv[1], 0.75, 1] : null,
    });
    const out = evaluate([0.1, 0.1, 0.1, 1], [0.25, 0.5]);
    expect(out[0]).toBeCloseTo(0.25, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(0.75, 5);
  });

  it("wired MainTex texture params sample the bake source instead of the graph default", () => {
    const g = graph({
      params: [
        {
          name: "MainTex",
          type: "texture",
          group: "Texture",
          default: "default.png",
          scope: "per-material",
        } as MaterialParam,
      ],
      nodes: [
        node("p", "param", {}, { name: "MainTex" }),
        node("tex", "textureSample", { tex: "e1" }, { tex: "wrong.png" }),
      ],
      edges: [
        edge("e1", "p", "tex", "tex"),
        edge("e2", "tex", "out", "baseColor"),
      ],
      outputs: { baseColor: "e2" },
    });
    const instance = createMaterialInstance(g, "i");
    instance.mainTex = {
      type: "texture",
      id: "override",
      path: "override.png",
    };
    const evaluate = makeTexelEvaluator(g, instance, {
      samplerForPath: (path) =>
        path === "default.png" ||
        path === "wrong.png" ||
        path === "override.png"
          ? [0.9, 0.1, 0.1, 1]
          : null,
    });
    const out = evaluate([0.2, 0.4, 0.6, 1], [0.25, 0.5]);
    expect(out.slice(0, 3)).toEqual([0.2, 0.4, 0.6]);
  });

  it("wired texture params win over textureSample params.tex", () => {
    const g = graph({
      params: [
        {
          name: "MaskTex",
          type: "texture",
          group: "Textures",
          default: "mask.png",
          scope: "per-material",
        } as MaterialParam,
      ],
      nodes: [
        node("p", "param", {}, { name: "MaskTex" }),
        node(
          "mask",
          "antialiasedTextureMask",
          { tex: "e1" },
          {
            tex: "wrong.png",
            channel: "r",
            threshold: 0.5,
            softness: 0.001,
          },
        ),
      ],
      edges: [
        edge("e1", "p", "mask", "tex"),
        edge("e2", "mask", "out", "opacity"),
      ],
      outputs: { opacity: "e2" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"), {
      samplerForPath: (path) =>
        path === "mask.png"
          ? [0.9, 0, 0, 1]
          : path === "wrong.png"
            ? [0.1, 0, 0, 1]
            : null,
    });
    expect(evaluate([1, 1, 1, 1], [0, 0])[3]).toBeGreaterThan(0.9);
  });

  it("bakes antialiasedTextureMask into a soft alpha threshold", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node(
          "m",
          "antialiasedTextureMask",
          {},
          { channel: "a", threshold: 0.5, softness: 0.04 },
        ),
      ],
      edges: [
        edge("e1", "tex", "out", "baseColor"),
        edge("e2", "m", "out", "opacity"),
      ],
      outputs: { baseColor: "e1", opacity: "e2" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    // alpha channel well above threshold → ~1; well below → ~0.
    expect(evaluate([0, 0, 0, 0.9], [0.5, 0.5])[3]).toBeGreaterThan(0.9);
    expect(evaluate([0, 0, 0, 0.1], [0.5, 0.5])[3]).toBeLessThan(0.1);
  });

  it("bakes sphericalParticleOpacity radial alpha (bright center, dark edge)", () => {
    const g = graph({
      nodes: [
        node("tex", "textureSample"),
        node(
          "s",
          "sphericalParticleOpacity",
          {},
          { density: 1, center: [0.5, 0.5, 0, 0], radius: 0.5 },
        ),
      ],
      edges: [
        edge("e1", "tex", "out", "baseColor"),
        edge("e2", "s", "out", "opacity"),
      ],
      outputs: { baseColor: "e1", opacity: "e2" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    expect(evaluate([1, 1, 1, 1], [0.5, 0.5])[3]).toBeGreaterThan(0.9);
    expect(evaluate([1, 1, 1, 1], [0, 0])[3]).toBeCloseTo(0, 5);
  });

  it("static noise bakes deterministically (byte-identical across evaluators)", () => {
    const make = (): ReturnType<typeof makeTexelEvaluator> => {
      const g = graph({
        nodes: [
          node(
            "n",
            "noise",
            {},
            { function: "perlinGradient", scale: 8, seed: 3 },
          ),
        ],
        edges: [edge("e1", "n", "out", "opacity")],
        outputs: { opacity: "e1" },
      });
      return makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    };
    const a = make();
    const b = make();
    // Sample a grid of UVs — both evaluators must agree exactly, and the field
    // must actually vary (not a constant).
    const seen = new Set<number>();
    for (let i = 0; i <= 8; i++) {
      const uv: [number, number] = [i / 8, (i * 0.37) % 1];
      const va = a([0, 0, 0, 1], uv)[3];
      const vb = b([0, 0, 0, 1], uv)[3];
      expect(va).toBe(vb);
      seen.add(Math.round(va * 1000));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("sphericalParticleOpacity defaults center to the sprite middle (preview parity)", () => {
    // A center-LESS node must bake centered at (0.5,0.5) to match previewEval —
    // bright in the middle, ~0 at the corner (regression for the bake/preview
    // center-default divergence).
    const g = graph({
      nodes: [node("s", "sphericalParticleOpacity", {}, { radius: 0.5 })],
      edges: [edge("e1", "s", "out", "opacity")],
      outputs: { opacity: "e1" },
    });
    const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
    expect(evaluate([1, 1, 1, 1], [0.5, 0.5])[3]).toBeGreaterThan(0.9);
    expect(evaluate([1, 1, 1, 1], [0, 0])[3]).toBeCloseTo(0, 5);
  });

  it("cheap math glue evaluates component-wise (abs/frac/floor)", () => {
    const unary = (type: MaterialNode["type"], source: number): number => {
      const g = graph({
        nodes: [node("tex", "textureSample"), node("op", type, { in: "e1" })],
        edges: [
          edge("e1", "tex", "op", "in"),
          edge("e2", "op", "out", "opacity"),
        ],
        outputs: { opacity: "e2" },
      });
      const evaluate = makeTexelEvaluator(g, createMaterialInstance(g, "i"));
      return evaluate([source, 0, 0, 1], [0, 0])[3];
    };
    expect(unary("abs", 0.6)).toBeCloseTo(0.6, 5);
    expect(unary("frac", 0.6)).toBeCloseTo(0.6, 5);
    expect(unary("floor", 0.6)).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// Gradient LUT (techspec §4 GradientRamp → 1×256 LUT)
// ---------------------------------------------------------------------------

describe("gradient LUT", () => {
  const stops: GradientStop[] = [
    { position: 0, color: [0, 0, 0, 1] },
    { position: 1, color: [1, 1, 1, 1] },
  ];

  it("builds a 1×256 RGBA LUT (256*4 bytes)", () => {
    const lut = buildGradientLut(stops);
    expect(lut.length).toBe(256 * 4);
    // first texel is black, last is white
    expect(lut[0]).toBe(0);
    expect(lut[255 * 4]).toBe(255);
  });

  it("interpolates RGB in linear light between sRGB stops", () => {
    const mid = sampleGradient(stops, 0.5);
    expect(mid[0]).toBeCloseTo(linearToSrgb(0.5), 5);
    expect(mid[3]).toBeCloseTo(1, 5);
  });

  it("clamps at the ends", () => {
    expect(sampleGradient(stops, -1)).toEqual([0, 0, 0, 1]);
    expect(sampleGradient(stops, 2)).toEqual([1, 1, 1, 1]);
  });

  it("an empty gradient is a neutral white multiply", () => {
    const lut = buildGradientLut([]);
    expect(lut[0]).toBe(255);
    expect(lut[3]).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// Cache-key backward compatibility (techspec §6.5, §12)
// ---------------------------------------------------------------------------

describe("derivedTextureCacheKey + materialBakeHash", () => {
  it("is byte-identical to the legacy 3-arg key when bakeHash is undefined", () => {
    expect(derivedTextureCacheKey(7, "luminance", false)).toBe("7|luminance|0");
    expect(derivedTextureCacheKey(7, "luminance", true)).toBe("7|luminance|1");
    // explicit undefined behaves the same
    expect(derivedTextureCacheKey(7, "luminance", false, undefined)).toBe(
      "7|luminance|0",
    );
  });

  it("appends the material bake hash so a bake never collides with legacy", () => {
    const legacy = derivedTextureCacheKey(7, "textureAlpha", false);
    const baked = derivedTextureCacheKey(7, "textureAlpha", false, "deadbeef");
    expect(baked).toBe("7|textureAlpha|0|deadbeef");
    expect(baked).not.toBe(legacy);
  });

  it("different bake hashes produce different keys", () => {
    expect(derivedTextureCacheKey(1, "red", false, "aaa")).not.toBe(
      derivedTextureCacheKey(1, "red", false, "bbb"),
    );
  });
});

// ---------------------------------------------------------------------------
// materialDigest determinism
// ---------------------------------------------------------------------------

describe("materialDigest", () => {
  it("is stable across calls and sensitive to inputs", () => {
    const g = createSpriteMasterGraph();
    const i = createMaterialInstance(g, "inst");
    expect(materialDigest(g, i, 1)).toBe(materialDigest(g, i, 1));
    expect(materialDigest(g, i, 1)).not.toBe(materialDigest(g, i, 2));
  });
});
