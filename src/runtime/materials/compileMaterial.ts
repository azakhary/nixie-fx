import type { Vec4 } from "../../engine/math";
import { numberOr } from "../../engine/particleModuleSettingUtils";
import type {
  MaterialEdge,
  MaterialInstance,
  MaterialNode,
  MaterialNodeType,
  MaterialParam,
  MaterialPerParticleFeed,
  ShaderGraph,
} from "../schema/materials";
import {
  isSpriteMasterGraph,
  resolveMaterialParamValue,
  serializeShaderGraph,
  SPRITE_MASTER_SHADER_ID,
} from "../schema/materials";
import { serializeMaterialInstance } from "../../engine/materialInstance";
import { BAKEABLE_NODE_TYPES } from "./bake";
import type {
  MaterialArtifact,
  MaterialFixedDescriptor,
  MaterialTier,
  MaterialUvPan,
  MaterialUvRotate,
} from "./artifact";

/**
 * Material graph compiler (techspec §6.1, §6.2) — `analyzeGraphTier` resolves the
 * cheapest renderable tier; `compileMaterial` produces the `MaterialArtifact`
 * the renderer consumes.
 *
 * Pure module (engine + schema only); no Pixi/DOM. The Tier-0 per-texel BAKE
 * itself lives in `bake.ts`; here we only DECIDE the tier and emit the artifact
 * (including the deterministic `bakeHash` the renderer keys its derived-texture
 * cache on).
 */

// ---------------------------------------------------------------------------
// Deferred-node allowlist (techspec §4.2, §6.2)
// ---------------------------------------------------------------------------

/**
 * Deferred / `[NA]` node types that, when reachable from an honored output,
 * force Tier 3 (data-only, greyed in preview). None of these exist in the
 * current `MaterialNodeType` union — Tier 3 therefore triggers ONLY via this
 * explicit, documented allowlist (techspec §6.2: "tier3 triggers only via a
 * deferred-node allowlist you define + document"). We match on the node's
 * declared `type` string so a forward-compat graph carrying a future deferred
 * node still routes to Tier 3 rather than being silently mis-tiered.
 *
 * Source: techspec §4.2 (the `[NA]`/`[EXPENSIVE]` tail) + §1.3 deferrals.
 */
export const DEFERRED_NODE_TYPES: ReadonlySet<string> = new Set<string>([
  // Scene/back-buffer/depth reads (techspec §4.2 RED-LINE)
  "sceneColor",
  "sceneDepth",
  "pixelDepth",
  "depthFade",
  // Screen-space derivatives
  "ddx",
  "ddy",
  "ddxy",
  // NOTE (iteration 5b): `noise`, `vectorNoise` and `particleMacroUV` are no
  // longer deferred — they bake to a generated texture (Tier 0) by default and
  // only escalate to Tier 2 when fed a dynamic input or an explicit runtime flag.
  // View-dependent / 3D-domain
  "parallax",
  "parallaxOcclusion",
  "triplanar",
  "fresnelTrue",
  // Destination/back-buffer reads
  "refraction",
  "modulate",
  "alphaHoldout",
  // PBR / lighting / 3D (always [NA])
  "metallic",
  "roughness",
  "specular",
  "anisotropy",
  "tangent",
  "normal",
  "normalFromHeight",
  "worldPositionOffset",
  "tessellation",
  "displacement",
  // Author-supplied shader code — never allowed (techspec §1.2, Q9)
  "custom",
]);

// ---------------------------------------------------------------------------
// Node classification (techspec §6.2 algorithm)
// ---------------------------------------------------------------------------

/** Node types that read a per-particle engine signal or a per-particle feed. */
const PER_PARTICLE_NODE_TYPES: ReadonlySet<MaterialNodeType> =
  new Set<MaterialNodeType>([
    "particleColor",
    "particleRelativeTime",
    "particleSpeed",
    "particleRandom",
    "particleSize",
    "particleDirection",
    "particlePosition",
    // ParticleMacroUV derives emitter-wide UVs from per-particle position, so it
    // is a per-particle signal (never a static Tier-0 bake).
    "particleMacroUV",
  ]);

const PARTICLE_CONTAINER_TIER2_NODE_TYPES: ReadonlySet<MaterialNodeType> =
  new Set<MaterialNodeType>([
    "particleColor",
    "particleRelativeTime",
    "particleRandom",
  ]);

const CUSTOM_MESH_TIER2_NODE_TYPES: ReadonlySet<MaterialNodeType> =
  new Set<MaterialNodeType>([
    "particleSpeed",
    "particleSize",
    "particleDirection",
    "particlePosition",
    "particleMacroUV",
  ]);

/**
 * Per-pixel FRAGMENT ops that CANNOT bake when driven by a non-static (per-time
 * / per-particle) input — these force Tier 2 (techspec §6.2 `perPixel`). When
 * fed only static inputs they bake (Tier 0). The compiler treats them as
 * "per-pixel" only when a non-bakeable signal reaches them.
 */
const FRAGMENT_OP_NODE_TYPES: ReadonlySet<MaterialNodeType> =
  new Set<MaterialNodeType>([
    "step",
    "smoothstep",
    "power",
    "desaturate",
    "fresnel",
    "sphereMask",
    // iteration 5b P0: per-pixel ops that bake when static, Tier 2 when their
    // position/threshold/density is driven by a dynamic (per-time/particle) input.
    "noise",
    "vectorNoise",
    "antialiasedTextureMask",
    "sphericalParticleOpacity",
  ]);

/**
 * Noise nodes (`noise`/`vectorNoise`) that the author has explicitly switched to
 * a true runtime procedural mode (`params.runtime === true`). These force the
 * per-pixel shader tier even when their inputs are static — the opt-in,
 * budgeted escape hatch from the default bake (README P0; §9 budget warning).
 */
function isRuntimeNoise(node: MaterialNode): boolean {
  return (
    (node.type === "noise" || node.type === "vectorNoise") &&
    node.params.runtime === true
  );
}

/** UV-transform nodes that can ride the VERTEX stage when time-animated. */
const UV_TRANSFORM_NODE_TYPES: ReadonlySet<MaterialNodeType> =
  new Set<MaterialNodeType>(["panner", "rotateUV", "tilingOffset"]);

export interface GraphIndex {
  nodeById: Map<string, MaterialNode>;
  edgeById: Map<string, MaterialEdge>;
  /** edge id → source node id. */
  edgeSource: Map<string, string>;
  /** node id → its driven output slots (for vertex-UV-only detection). */
}

function indexGraph(graph: ShaderGraph): GraphIndex {
  const nodeById = new Map<string, MaterialNode>();
  for (const n of graph.nodes) nodeById.set(n.id, n);
  const edgeById = new Map<string, MaterialEdge>();
  const edgeSource = new Map<string, string>();
  for (const e of graph.edges) {
    edgeById.set(e.id, e);
    edgeSource.set(e.id, e.source);
  }
  return { nodeById, edgeById, edgeSource };
}

/** All node ids reachable upstream from the honored output slots. */
function reachableFromOutputs(
  graph: ShaderGraph,
  index: GraphIndex,
): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [];
  for (const slot of Object.keys(graph.outputs)) {
    const edgeId = graph.outputs[slot as keyof typeof graph.outputs];
    if (!edgeId) continue;
    const sourceNode = index.edgeSource.get(edgeId);
    if (sourceNode) stack.push(sourceNode);
  }
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = index.nodeById.get(id);
    if (!node) continue;
    for (const edgeId of Object.values(node.inputs)) {
      if (!edgeId) continue;
      const upstream = index.edgeSource.get(edgeId);
      if (upstream && !reachable.has(upstream)) stack.push(upstream);
    }
  }
  return reachable;
}

export function analyzeParticleColorChannelUsage(
  graph: ShaderGraph,
  index: GraphIndex = indexGraph(graph),
): { rgb: boolean; alpha: boolean } {
  const particleColorNodeIds = new Set(
    graph.nodes
      .filter((node) => node.type === "particleColor")
      .map((node) => node.id),
  );
  const reachable = reachableFromOutputs(graph, index);
  let rgb = false;
  let alpha = false;

  const considerParticleColorEdge = (
    edgeId: string | null | undefined,
  ): void => {
    if (!edgeId) return;
    const edge = index.edgeById.get(edgeId);
    if (!edge || !particleColorNodeIds.has(edge.source)) return;
    switch (edge.sourceHandle) {
      case "A":
      case "Param4":
        alpha = true;
        break;
      case "R":
      case "G":
      case "B":
      case "RGB":
        rgb = true;
        break;
      default:
        rgb = true;
        alpha = true;
        break;
    }
  };

  for (const edgeId of Object.values(graph.outputs)) {
    considerParticleColorEdge(edgeId);
  }
  for (const nodeId of reachable) {
    const node = index.nodeById.get(nodeId);
    if (!node) continue;
    for (const edgeId of Object.values(node.inputs)) {
      considerParticleColorEdge(edgeId);
    }
    if (node.type === "particleRelativeTime") {
      alpha = true;
    } else if (node.type === "particleRandom") {
      rgb = true;
    }
  }

  return { rgb, alpha };
}

/** Channel index the fragment's opacity slot reads for a given sourceHandle
 * (`slotScalarExpr` takes `.r` after channel select, so "out" reads [0]). */
const OPACITY_HANDLE_CHANNEL: Partial<Record<string, number>> = {
  R: 0,
  Param1: 0,
  G: 1,
  Param2: 1,
  B: 2,
  Param3: 2,
  A: 3,
  Param4: 3,
};

/**
 * True only when the graph's `opacity` output is provably constant 1 at compile
 * time: unwired (the I11-B/I11-I depth-write gate treats the default as opaque)
 * or wired to a bare `constant` node whose selected channel is exactly 1.
 * Anything live (params, textures, math chains, particle signals) is
 * conservatively NON-constant — the fragment shader owns per-pixel opacity
 * there, so the Three renderer must never flip the material into the opaque
 * pass off `sample.alpha` alone (I12-A).
 */
export function analyzeOpacityIsConstantOne(
  graph: ShaderGraph,
  index: GraphIndex = indexGraph(graph),
): boolean {
  const edgeId = graph.outputs.opacity;
  if (!edgeId) return true;
  const edge = index.edgeById.get(edgeId);
  const source = edge ? index.nodeById.get(edge.source) : undefined;
  if (!edge || !source) return true; // dangling wiring renders as unwired
  if (source.type !== "constant") return false;
  const value = source.params.value;
  const channel = OPACITY_HANDLE_CHANNEL[edge.sourceHandle] ?? 0;
  if (typeof value === "number") return value === 1;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value[channel] === 1;
  return false;
}

/**
 * True when this UV-transform node is "animated" — either a `time` node reaches
 * one of its inputs, OR the node is a Panner/Rotator with a non-zero speed (they
 * scroll from the implicit `uTime`, so they animate without a wired Time node).
 * A genuinely static Panner/Rotator (speed 0) bakes to a constant offset.
 */
function isTimeDriven(
  node: MaterialNode,
  index: GraphIndex,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(node.id)) return false;
  visiting.add(node.id);
  // Panner/Rotator animate from the implicit uTime when their speed is non-zero.
  if (node.type === "panner" && vec2IsNonZero(node.params.speed)) return true;
  if (node.type === "rotateUV" && numberOr(node.params.speed, 0) !== 0) {
    return true;
  }
  for (const edgeId of Object.values(node.inputs)) {
    if (!edgeId) continue;
    const upstreamId = index.edgeSource.get(edgeId);
    if (!upstreamId) continue;
    const upstream = index.nodeById.get(upstreamId);
    if (!upstream) continue;
    if (upstream.type === "time") return true;
    if (isTimeDriven(upstream, index, visiting)) return true;
  }
  return false;
}

/**
 * True when `nodeId`'s output flows ONLY into the UV pin(s) of texture samples
 * (techspec §6.2: animated UV that feeds only `vUV` is VERTEX-stage Tier 1, not
 * Tier 2). We walk every consumer of the node's output; each consumer must be a
 * texture sample reached via its "uv" pin, or another UV-transform that itself
 * is UV-only.
 */
function feedsOnlyTextureUv(
  nodeId: string,
  graph: ShaderGraph,
  index: GraphIndex,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(nodeId)) return true;
  visiting.add(nodeId);
  let hasConsumer = false;
  for (const edge of graph.edges) {
    if (edge.source !== nodeId) continue;
    hasConsumer = true;
    const target = index.nodeById.get(edge.target);
    if (!target) return false;
    if (
      (target.type === "textureSample" || target.type === "particleSubUV") &&
      edge.targetHandle === "uv"
    ) {
      continue; // good — feeds a texture UV pin
    }
    if (UV_TRANSFORM_NODE_TYPES.has(target.type)) {
      // chained UV transform — recurse; it must also be UV-only
      if (!feedsOnlyTextureUv(target.id, graph, index, visiting)) return false;
      continue;
    }
    return false; // feeds something else → not UV-only
  }
  return hasConsumer;
}

/**
 * The canonical "magic" param name `resolveFixed` reads for each output slot
 * (techspec §6.1 Tier-1). A Tier-1 fixed-function descriptor can ONLY represent
 * an output if it is driven by exactly this bare param (Tint/Emissive/Opacity).
 */
const FAITHFUL_OUTPUT_PARAM: Partial<Record<string, string>> = {
  baseColor: "Tint",
  emissive: "Emissive",
  opacity: "Opacity",
};

/**
 * True when a wired output's source node is something `resolveFixed` (Tier-1)
 * faithfully represents WITHOUT throwing the wiring away:
 *  - the canonical magic `param` node for that slot (baseColor←"Tint",
 *    emissive←"Emissive", opacity←"Opacity"); or
 *  - a bare `textureSample` / `particleSubUV` — i.e. the texture-only path the
 *    renderer's fixed-function fold already reproduces byte-identically (the
 *    optional vertex-UV transform on its UV pin is the only allowed indirection).
 *
 * Anything else (a multiply/lerp/gradientRamp/constant/per-particle network)
 * has wiring `resolveFixed` cannot carry, so it is NOT faithful and must be
 * baked (Tier 0) or run as a real shader (Tier 2) instead of collapsing to a
 * no-op tint of [1,1,1,1]. This is the M6-A fix for "materials don't change the
 * particle". (The SpriteMaster builtin is short-circuited to Tier 1 separately
 * via `isSpriteMasterGraph`; its baseColor = Tint × MainTex multiply is NOT a
 * bare param and would correctly fail this predicate.)
 */
function isTier1Faithful(graph: ShaderGraph, index: GraphIndex): boolean {
  for (const slot of Object.keys(graph.outputs)) {
    const edgeId = graph.outputs[slot as keyof typeof graph.outputs];
    if (!edgeId) continue; // unwired output is trivially faithful
    const sourceId = index.edgeSource.get(edgeId);
    if (!sourceId) continue;
    const source = index.nodeById.get(sourceId);
    if (!source) return false;
    // (a) a bare texture sample feeding the slot reproduces the texture-only
    // path the renderer's fixed fold already handles byte-identically.
    if (source.type === "textureSample" || source.type === "particleSubUV") {
      continue;
    }
    // (b) the canonical magic param node for this slot.
    const magic = FAITHFUL_OUTPUT_PARAM[slot];
    if (
      magic &&
      source.type === "param" &&
      typeof source.params.name === "string" &&
      source.params.name === magic
    ) {
      continue;
    }
    return false; // wired through a non-magic network → not faithful
  }
  return true;
}

// ---------------------------------------------------------------------------
// analyzeGraphTier (techspec §6.2)
// ---------------------------------------------------------------------------

export interface TierAnalysis {
  tier: MaterialTier;
  /** Node ids that forced Tier 3 (empty otherwise). */
  deferredNodeIds: string[];
  /** Vertex-stage animated-UV nodes resolved to Tier 1 (Panner/Rotator). */
  vertexUvNodeIds: string[];
  /** Reachable per-particle node ids (drive feed assignment). */
  perParticleNodeIds: string[];
}

/**
 * Resolve the lowest tier that can represent the graph (techspec §6.2).
 *
 * An EMPTY graph or the Sprite Master builtin → Tier 1 (fixed-function).
 * Otherwise:
 *   reachable ∩ deferred         → Tier 3
 *   no per-particle/per-pixel/UV → Tier 0 (bake)
 *   only vertex-UV / per-particle (no per-pixel) → Tier 1
 *   else                         → Tier 2
 */
export function analyzeGraphTier(graph: ShaderGraph): TierAnalysis {
  // Empty graph or the builtin Sprite Master is always Tier 1 (§6.2).
  const hasNoOutputs =
    Object.values(graph.outputs).every((e) => !e) || graph.nodes.length === 0;
  if (isSpriteMasterGraph(graph) || hasNoOutputs) {
    return {
      tier: "tier1-fixed",
      deferredNodeIds: [],
      vertexUvNodeIds: [],
      perParticleNodeIds: [],
    };
  }

  const index = indexGraph(graph);
  const reachable = reachableFromOutputs(graph, index);

  // Tier 3: any reachable deferred node.
  const deferredNodeIds: string[] = [];
  for (const id of reachable) {
    const node = index.nodeById.get(id);
    if (node && DEFERRED_NODE_TYPES.has(node.type)) deferredNodeIds.push(id);
  }
  if (deferredNodeIds.length > 0) {
    return {
      tier: "tier3-defer",
      deferredNodeIds,
      vertexUvNodeIds: [],
      perParticleNodeIds: [],
    };
  }

  // Vertex-stage animated UV: animated Panner/Rotator that feeds ONLY texture UV.
  const vertexUvNodeIds: string[] = [];
  for (const id of reachable) {
    const node = index.nodeById.get(id);
    if (!node) continue;
    if (node.type !== "panner" && node.type !== "rotateUV") continue;
    if (!isTimeDriven(node, index)) continue;
    if (feedsOnlyTextureUv(node.id, graph, index))
      vertexUvNodeIds.push(node.id);
  }
  const vertexUvSet = new Set(vertexUvNodeIds);

  // Per-particle: any reachable Particle*/perParticle dynamicParameter node.
  const perParticleNodeIds: string[] = [];
  for (const id of reachable) {
    const node = index.nodeById.get(id);
    if (!node) continue;
    if (PER_PARTICLE_NODE_TYPES.has(node.type)) {
      perParticleNodeIds.push(node.id);
    } else if (node.type === "dynamicParameter") {
      perParticleNodeIds.push(node.id);
    } else if (node.type === "param" && paramIsPerParticle(node, graph)) {
      perParticleNodeIds.push(node.id);
    }
  }
  const perParticle = perParticleNodeIds.length > 0;

  // Per-pixel fragment op that can't bake AND isn't vertex-UV: forces Tier 2.
  // A fragment op is "per-pixel" only when a non-static (per-particle / per-time)
  // signal reaches it; a fully static fragment op bakes (Tier 0).
  let perPixel = false;
  for (const id of reachable) {
    const node = index.nodeById.get(id);
    if (!node) continue;
    // A time-driven UV transform that is NOT a clean vertex-UV feed is per-pixel.
    if (UV_TRANSFORM_NODE_TYPES.has(node.type)) {
      if (isTimeDriven(node, index) && !vertexUvSet.has(node.id)) {
        perPixel = true;
        break;
      }
      continue;
    }
    // dynamicParameter / SubUV-blend / fragment ops fed by dynamic inputs.
    if (node.type === "dynamicParameter") {
      perPixel = true;
      break;
    }
    // Explicit runtime procedural noise opts out of the bake → per-pixel shader.
    if (isRuntimeNoise(node)) {
      perPixel = true;
      break;
    }
    if (
      FRAGMENT_OP_NODE_TYPES.has(node.type) &&
      reachesDynamicInput(node, index)
    ) {
      perPixel = true;
      break;
    }
  }

  // Tier-0 consistency guard (techspec §6.2): only route to Tier-0 when EVERY
  // reachable node is something `bake.ts` can actually evaluate per-texel. A
  // static-but-unbakeable node (e.g. a future fragment op the bake doesn't yet
  // implement) must NOT silently mis-bake — it falls through to the per-pixel
  // shader tier so preview and runtime never disagree.
  let allBakeable = true;
  for (const id of reachable) {
    const node = index.nodeById.get(id);
    if (!node) continue;
    if (!BAKEABLE_NODE_TYPES.has(node.type)) {
      allBakeable = false;
      break;
    }
  }

  if (
    !perParticle &&
    !perPixel &&
    vertexUvNodeIds.length === 0 &&
    allBakeable
  ) {
    return {
      tier: "tier0-bake",
      deferredNodeIds: [],
      vertexUvNodeIds: [],
      perParticleNodeIds: [],
    };
  }
  // M6-A (Decision D2): the old fallback `if (!perPixel) return tier1-fixed`
  // collapsed EVERY non-tier3/0/perPixel graph to Tier-1 fixed-function, where
  // `resolveFixed` only reads the canonical magic params (Tint/Emissive/Opacity)
  // and threw the wired network away — so a node-driven baseColor/emissive/
  // opacity silently became a [1,1,1,1] no-op (byte-identical to the bare
  // texture). Now Tier-1 is reserved for graphs `resolveFixed` can faithfully
  // represent; everything else must HONOR its wiring: bake it when fully static
  // & bakeable (Tier 0), otherwise run the real Tier-2 fragment shader (which
  // evaluates the graph and reads per-particle vColor).
  if (isTier1Faithful(graph, index)) {
    return {
      tier: "tier1-fixed",
      deferredNodeIds: [],
      vertexUvNodeIds,
      perParticleNodeIds,
    };
  }
  if (!perParticle && !perPixel && allBakeable) {
    return {
      tier: "tier0-bake",
      deferredNodeIds: [],
      vertexUvNodeIds: [],
      perParticleNodeIds: [],
    };
  }
  return {
    tier: "tier2-shader",
    deferredNodeIds: [],
    vertexUvNodeIds,
    perParticleNodeIds,
  };
}

/** True when a vec/number value (a node's speed param) is non-zero. */
function vec2IsNonZero(value: unknown): boolean {
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value))
    return value.some((n) => typeof n === "number" && n !== 0);
  return false;
}

/** True when a `param` node references a per-particle MaterialParam. */
function paramIsPerParticle(node: MaterialNode, graph: ShaderGraph): boolean {
  const name = typeof node.params.name === "string" ? node.params.name : "";
  const param = graph.params.find((p) => p.name === name);
  return param?.perParticle === true;
}

/** True when a per-particle / per-time signal reaches any input of `node`. */
function reachesDynamicInput(
  node: MaterialNode,
  index: GraphIndex,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(node.id)) return false;
  visiting.add(node.id);
  for (const edgeId of Object.values(node.inputs)) {
    if (!edgeId) continue;
    const upstreamId = index.edgeSource.get(edgeId);
    if (!upstreamId) continue;
    const upstream = index.nodeById.get(upstreamId);
    if (!upstream) continue;
    if (
      upstream.type === "time" ||
      upstream.type === "dynamicParameter" ||
      PER_PARTICLE_NODE_TYPES.has(upstream.type)
    ) {
      return true;
    }
    if (reachesDynamicInput(upstream, index, visiting)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-particle feed assignment (techspec §5.0 ladder, §5.1)
// ---------------------------------------------------------------------------

/**
 * Assign each per-particle param its physical delivery mechanism (techspec §5.0
 * ladder / §5.1 packing budget). The ladder, cheapest-first:
 *
 *  - `spawn-color`  constant-at-spawn (no slider/clamp range that varies over
 *    life, or the param is explicitly non-animated) → folded into the spawn-time
 *    8-bit color. FREE, no stream.
 *  - `smuggle-8bit` animated and bounded to 0..1 (slider/clamp within [0,1]) →
 *    smuggled into a spare 8-bit color/uvs channel. Cheap, no new stream — only
 *    valid when a channel is free (the renderer/validator enforces that; here we
 *    pick the mechanism the param's RANGE allows).
 *  - `mesh-attr`    animated and unbounded (range exceeds 0..1) → Tier-2
 *    custom-Mesh fp16 attribute (the only genuine extra per-particle stream).
 *
 * A param that already declares `perParticleFeed` keeps it (author/compiler
 * override). Otherwise we infer from its bounds.
 */
export function assignPerParticleFeed(
  param: MaterialParam,
): MaterialPerParticleFeed {
  if (param.perParticleFeed) return param.perParticleFeed;
  // A param with no animatable range (slider min === max, or no slider) and no
  // wide clamp is a constant-at-spawn → spawn-color.
  const hasSlider =
    param.sliderMin !== undefined && param.sliderMax !== undefined;
  if (!hasSlider) return "spawn-color";

  const lo = param.clampMin ?? param.sliderMin ?? 0;
  const hi = param.clampMax ?? param.sliderMax ?? 1;
  if (lo === hi) return "spawn-color";
  // Bounded to 0..1 → can smuggle into a spare 8-bit channel.
  if (lo >= 0 && hi <= 1) return "smuggle-8bit";
  // Unbounded / wide range → only a Tier-2 mesh attribute can carry it.
  return "mesh-attr";
}

// ---------------------------------------------------------------------------
// Fixed-function resolution (Tier 1)
// ---------------------------------------------------------------------------

function asVec4(value: number | Vec4 | string | boolean | undefined): Vec4 {
  if (Array.isArray(value)) {
    return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0];
  }
  return [1, 1, 1, 1];
}

/** Resolve a named param's effective value as a number (0 fallback). */
function resolveNumber(
  graph: ShaderGraph,
  instance: MaterialInstance,
  name: string,
  fallback: number,
): number {
  const v = resolveMaterialParamValue(graph, instance, name);
  return typeof v === "number" ? v : fallback;
}

/**
 * Build the fixed-function descriptor for Tier 1 (techspec §6.1 Tier-1). Reads
 * the canonical Sprite-Master param names (Tint / Emissive / Opacity) and any
 * vertex-stage animated UV resolved by the analyzer.
 */
function resolveFixed(
  graph: ShaderGraph,
  instance: MaterialInstance,
  index: GraphIndex,
  vertexUvNodeIds: string[],
): MaterialFixedDescriptor {
  const tintParam = graph.params.find(
    (p) => p.name === "Tint" && p.type === "color",
  );
  const tint: Vec4 = tintParam
    ? asVec4(resolveMaterialParamValue(graph, instance, "Tint"))
    : [1, 1, 1, 1];

  const hasEmissive = graph.params.some((p) => p.name === "Emissive");
  const emissive = hasEmissive
    ? resolveNumber(graph, instance, "Emissive", 0)
    : 0;

  const hasOpacity = graph.params.some((p) => p.name === "Opacity");
  const opacity = hasOpacity ? resolveNumber(graph, instance, "Opacity", 1) : 1;

  const fixed: MaterialFixedDescriptor = {
    tint,
    emissive,
    opacity,
    blend: graph.blend,
  };

  for (const id of vertexUvNodeIds) {
    const node = index.nodeById.get(id);
    if (!node) continue;
    if (node.type === "panner") {
      const speed = node.params.speed;
      const pan: MaterialUvPan = {
        speed: Array.isArray(speed)
          ? [numberOr(speed[0], 0), numberOr(speed[1], 0)]
          : [numberOr(node.params.speedX, 0), numberOr(node.params.speedY, 0)],
      };
      fixed.uvPan = pan;
    } else if (node.type === "rotateUV") {
      const center = node.params.center;
      const rotate: MaterialUvRotate = {
        speed: numberOr(node.params.speed, 0),
        center: Array.isArray(center)
          ? [numberOr(center[0], 0.5), numberOr(center[1], 0.5)]
          : [0.5, 0.5],
      };
      fixed.uvRotate = rotate;
    }
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// Deterministic hashing (bakeHash + Tier-2 shaderId)
// ---------------------------------------------------------------------------

/** FNV-1a over a string → 8-hex-digit digest (mirrors renderer.ts hashStringLocal). */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic digest of `(graph, instance overrides, mainTexUid)` for the
 * Tier-0 bake cache and the Tier-2 variant id (techspec §6.1, §6.5). Uses the
 * deterministic-key-order serializers so the digest is stable across loads.
 */
export function materialDigest(
  graph: ShaderGraph,
  instance: MaterialInstance,
  mainTexUid: string | number | null,
): string {
  const payload = JSON.stringify({
    graph: serializeShaderGraph(graph),
    instance: serializeMaterialInstance(instance),
    mainTex: mainTexUid ?? null,
  });
  return fnv1a(payload);
}

// ---------------------------------------------------------------------------
// compileMaterial (techspec §6.1)
// ---------------------------------------------------------------------------

export interface CompileMaterialOptions {
  /**
   * The resolved MainTex uid (the shared `ParticleContainer.texture.uid`). Feeds
   * the Tier-0 `bakeHash` so a bake is invalidated when the source image changes
   * (techspec §6.5). May be null for a texture-less material.
   */
  mainTexUid?: string | number | null;
}

/**
 * Compile a `(ShaderGraph, MaterialInstance)` into a `MaterialArtifact`
 * (techspec §6.1). The renderer consumes the artifact per its tier:
 *  - Tier 0 → look up a derived texture by `bakeHash`.
 *  - Tier 1 → fold `fixed` into the existing fixed-function color/UV path.
 *  - Tier 2 → bind the program identified by `shaderId` (variant-capped).
 *  - Tier 3 → render nothing custom; surface `deferredNodeIds` as a diagnostic.
 */
export function compileMaterial(
  graph: ShaderGraph,
  instance: MaterialInstance,
  opts: CompileMaterialOptions = {},
): MaterialArtifact {
  const mainTexUid = opts.mainTexUid ?? null;
  const analysis = analyzeGraphTier(graph);
  const index = indexGraph(graph);
  const particleColorUsage = analyzeParticleColorChannelUsage(graph, index);
  const opacityIsConstantOne = analyzeOpacityIsConstantOne(graph, index);
  const diagnostics: string[] = [];

  // Per-particle feed assignment (techspec §5.0 ladder).
  const perParticleFeeds: Record<string, MaterialPerParticleFeed> = {};
  for (const param of graph.params) {
    if (param.perParticle) {
      perParticleFeeds[param.name] = assignPerParticleFeed(param);
    }
  }

  switch (analysis.tier) {
    case "tier3-defer": {
      const names = analysis.deferredNodeIds
        .map((id) => index.nodeById.get(id)?.type ?? id)
        .join(", ");
      diagnostics.push(
        `Tier 3: graph reaches deferred node(s) [${names}] — not rendered in preview, exported data-only (techspec §4.2).`,
      );
      return {
        tier: "tier3-defer",
        shaderId: SPRITE_MASTER_SHADER_ID,
        blend: graph.blend,
        perParticleFeeds,
        diagnostics,
        deferredNodeIds: analysis.deferredNodeIds,
        usesParticleColorRGB: particleColorUsage.rgb,
        usesParticleColorAlpha: particleColorUsage.alpha,
        opacityIsConstantOne,
      };
    }
    case "tier0-bake": {
      return {
        tier: "tier0-bake",
        shaderId: SPRITE_MASTER_SHADER_ID,
        blend: graph.blend,
        bakeHash: materialDigest(graph, instance, mainTexUid),
        // The bake evaluator folds these canonical controls into the texture.
        fixed: resolveFixed(graph, instance, index, []),
        perParticleFeeds,
        diagnostics,
        deferredNodeIds: [],
        usesParticleColorRGB: particleColorUsage.rgb,
        usesParticleColorAlpha: particleColorUsage.alpha,
        opacityIsConstantOne,
      };
    }
    case "tier1-fixed": {
      return {
        tier: "tier1-fixed",
        shaderId: SPRITE_MASTER_SHADER_ID,
        blend: graph.blend,
        fixed: resolveFixed(graph, instance, index, analysis.vertexUvNodeIds),
        perParticleFeeds,
        diagnostics,
        deferredNodeIds: [],
        usesParticleColorRGB: particleColorUsage.rgb,
        usesParticleColorAlpha: particleColorUsage.alpha,
        opacityIsConstantOne,
      };
    }
    case "tier2-shader": {
      // A distinct, deterministic program id counted against the ≤4-6 cap.
      const variantId = `mat-${fnv1a(JSON.stringify(serializeShaderGraph(graph)))}`;
      for (const [name, feed] of Object.entries(perParticleFeeds)) {
        if (feed === "mesh-attr") {
          diagnostics.push(
            `Tier 2 custom Mesh path required: DynamicParameter "${name}" needs an independent per-particle float attribute; ParticleContainer exposes only vertex/position/rotation/uvs/color.`,
          );
        }
      }
      const customMeshNodes = analysis.perParticleNodeIds
        .map((id) => index.nodeById.get(id))
        .filter(
          (node): node is MaterialNode =>
            !!node && CUSTOM_MESH_TIER2_NODE_TYPES.has(node.type),
        );
      for (const node of customMeshNodes) {
        diagnostics.push(
          `Tier 2 custom Mesh path required: ${node.type} needs a per-particle attribute that ParticleContainer does not expose.`,
        );
      }
      const unsupportedSignals = analysis.perParticleNodeIds
        .map((id) => index.nodeById.get(id))
        .filter(
          (node): node is MaterialNode =>
            !!node &&
            PER_PARTICLE_NODE_TYPES.has(node.type) &&
            !PARTICLE_CONTAINER_TIER2_NODE_TYPES.has(node.type) &&
            !CUSTOM_MESH_TIER2_NODE_TYPES.has(node.type),
        );
      for (const node of unsupportedSignals) {
        diagnostics.push(
          `Tier 2 custom Mesh path required: ${node.type} is not available on the ParticleContainer shader path.`,
        );
      }
      return {
        tier: "tier2-shader",
        shaderId: variantId,
        blend: graph.blend,
        fixed: resolveFixed(graph, instance, index, analysis.vertexUvNodeIds),
        perParticleFeeds,
        diagnostics,
        deferredNodeIds: [],
        usesParticleColorRGB: particleColorUsage.rgb,
        usesParticleColorAlpha: particleColorUsage.alpha,
        opacityIsConstantOne,
      };
    }
  }
}
