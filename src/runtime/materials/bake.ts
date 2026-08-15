import type { Vec4 } from "../../engine/math";
import { clamp, lerp, smoothstep } from "../../engine/math";
import { numberOr } from "../../engine/particleModuleSettingUtils";
import { lerpVec4SrgbRgbInLinear } from "../../engine/particles";
import type {
  MaterialEdge,
  MaterialInstance,
  MaterialNode,
  MaterialNodeType,
  ShaderGraph,
} from "../schema/materials";
import {
  resolveMaterialParamValue,
  resolveMaterialTextureNodeBinding,
} from "../schema/materials";
import {
  sampleScalarNoise,
  sampleVectorNoise,
  scalarNoiseOptionsFromParams,
  vectorNoiseOptionsFromParams,
} from "./noise";

/**
 * Tier-0 BAKE — pure per-texel graph evaluator + gradient LUT builder
 * (techspec §6.1 Tier-0, §4 node catalog).
 *
 * This is the generalization of `deriveAlphaInPlace`: it walks a STATIC graph
 * (no per-particle / per-time inputs reachable from the honored outputs) and
 * evaluates it once per texel, returning an RGBA value. The Pixi side
 * (`pixi/material.ts`) wraps it in a canvas exactly like `createDerivedAlphaTexture`.
 *
 * Everything here is framework-agnostic (operates on `Uint8ClampedArray` /
 * plain numbers, no Pixi/DOM) so it is unit-testable headlessly.
 *
 * --------------------------------------------------------------------------
 * NODE `params` CONVENTIONS (the schema leaves `MaterialNode.params` open; the
 * compiler/bake fix the keys — documented here so the editor writes them):
 *  - `constant`      : params.value = number | Vec4
 *  - `param`         : params.name  = string  (looked up via the MaterialInstance)
 *  - `textureSample` : samples the source texel (the bake's input pixel)
 *  - `gradientRamp`  : params.stops = Array<{ position:number; color:Vec4 }>
 *  - `multiply/add/subtract/divide/min/max` : inputs "a","b"
 *  - `lerp`          : inputs "a","b","t"
 *  - `oneMinus`      : input  "in"
 *  - `clamp`         : input  "in"; params.min,max | inputs "min","max"
 *  - `step`          : input  "in"; params.edge (default 0.5) | input "edge"
 *  - `smoothstep`    : input  "in"; params.edge0,edge1 | inputs "edge0","edge1"
 *  - `power`         : input  "in"; params.exponent (default 1) | input "exp"
 *  - `remap`         : input  "in"; params.inMin,inMax,outMin,outMax | same-name inputs
 *  - `desaturate`    : input  "in"; params.fraction (default 1)
 *  - `fresnel`       : params.center, params.power — radial UV falloff (per-texel)
 *  - `sphereMask`    : params.center, params.radius, params.hardness — soft radial mask
 *
 * THRESHOLD PIN CONTRACT (agreed across agents): when `node.inputs.<pin>` is
 * wired the value comes from the wire, else from `params.<sameKey>` — applied to
 * step.edge, smoothstep.edge0/edge1, clamp.min/max, remap.in/outMin/Max, lerp.t,
 * power.exp.
 *  - `split`         : input  "in"; params.channel = "r"|"g"|"b"|"a"
 *  - `combine`       : inputs "r","g","b","a"
 *  - `swizzle`       : input  "in"; params.pattern = e.g. "rrra"
 *  - `oneMinus/clamp/...` unwired inputs fall back to a documented default.
 * --------------------------------------------------------------------------
 */

/** A bakeable (static, per-texel) node type — the rest force a higher tier. */
export const BAKEABLE_NODE_TYPES: ReadonlySet<MaterialNodeType> =
  new Set<MaterialNodeType>([
    "param",
    "constant",
    "textureSample",
    "particleSubUV",
    "uv",
    "tilingOffset",
    "multiply",
    "add",
    "subtract",
    "divide",
    "lerp",
    "oneMinus",
    "clamp",
    "step",
    "smoothstep",
    "power",
    "min",
    "max",
    "remap",
    "split",
    "combine",
    "swizzle",
    "desaturate",
    "fresnel",
    "sphereMask",
    "gradientRamp",
    // iteration 5b P0: cheap math glue.
    "abs",
    "frac",
    "floor",
    "ceil",
    "round",
    "sign",
    "sqrt",
    "length",
    "normalize",
    "dot",
    "sine",
    "cosine",
    "if",
    // iteration 5b P0: baked noise + masks (Tier 0 when static).
    "noise",
    "vectorNoise",
    "antialiasedTextureMask",
    "sphericalParticleOpacity",
    "particleMacroUV",
    "output",
  ]);

/**
 * Select a node-output channel for an edge's `sourceHandle` (iteration 5b
 * multi-output pins). `R/G/B/A` and `Param1..4` broadcast a single component;
 * `RGB` and the legacy `out`/`Out` handles pass the full vector through (so old
 * `sourceHandle:"out"` edges behave byte-identically to before — §13 migration).
 */
export function selectChannel(value: Vec4, handle: string): Vec4 {
  switch (handle) {
    case "R":
    case "Param1":
      return [value[0], value[0], value[0], value[0]];
    case "G":
    case "Param2":
      return [value[1], value[1], value[1], value[1]];
    case "B":
    case "Param3":
      return [value[2], value[2], value[2], value[2]];
    case "A":
    case "Param4":
      return [value[3], value[3], value[3], value[3]];
    default:
      // RGB / Out / legacy "out" / any single-output handle → full vector.
      return value;
  }
}

/** A gradient stop for `gradientRamp` (position 0..1 → RGBA each 0..1). */
export interface GradientStop {
  position: number;
  color: Vec4;
}

const REC709: Vec4 = [0.2126, 0.7152, 0.0722, 0];

function toVec4(value: number | Vec4 | string | boolean | undefined): Vec4 {
  if (Array.isArray(value)) {
    return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0];
  }
  if (typeof value === "number") return [value, value, value, value];
  if (typeof value === "boolean") {
    const n = value ? 1 : 0;
    return [n, n, n, n];
  }
  return [0, 0, 0, 0];
}

function mulVec4(a: Vec4, b: Vec4): Vec4 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];
}

function addVec4(a: Vec4, b: Vec4): Vec4 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}

function subVec4(a: Vec4, b: Vec4): Vec4 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
}

function divVec4(a: Vec4, b: Vec4): Vec4 {
  return [
    b[0] === 0 ? 0 : a[0] / b[0],
    b[1] === 0 ? 0 : a[1] / b[1],
    b[2] === 0 ? 0 : a[2] / b[2],
    b[3] === 0 ? 0 : a[3] / b[3],
  ];
}

function lerpVec4(a: Vec4, b: Vec4, t: Vec4): Vec4 {
  return [
    lerp(a[0], b[0], t[0]),
    lerp(a[1], b[1], t[1]),
    lerp(a[2], b[2], t[2]),
    lerp(a[3], b[3], t[3]),
  ];
}

/** Fractional part, matching HLSL `frac` (always in [0,1) for negatives too). */
function fracOf(x: number): number {
  return x - Math.floor(x);
}

function channelOf(value: Vec4, channel: string): number {
  switch (channel) {
    case "g":
      return value[1];
    case "b":
      return value[2];
    case "a":
      return value[3];
    default:
      return value[0];
  }
}

/**
 * Build a 1×256 RGBA gradient LUT (techspec §4 GradientRamp → "1×256 LUT").
 * Sampled at runtime by `normalizedAge`/`speed`. Stops are sorted by position;
 * the LUT is the piecewise-linear interpolation across t∈[0,1].
 *
 * @returns a `Uint8ClampedArray` of length 256*4 (RGBA per texel).
 */
export function buildGradientLut(stops: GradientStop[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256 * 4);
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) {
    // No stops → opaque white ramp (a neutral multiply).
    out.fill(255);
    return out;
  }
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const color = sampleGradient(sorted, t);
    const o = i * 4;
    out[o] = color[0] * 255;
    out[o + 1] = color[1] * 255;
    out[o + 2] = color[2] * 255;
    out[o + 3] = color[3] * 255;
  }
  return out;
}

/** Sample a (pre-sorted) gradient at t∈[0,1], clamping at the ends. */
export function sampleGradient(sorted: GradientStop[], t: number): Vec4 {
  if (sorted.length === 0) return [1, 1, 1, 1];
  const first = sorted[0]!;
  if (t <= first.position) return [...first.color] as Vec4;
  const last = sorted[sorted.length - 1]!;
  if (t >= last.position) return [...last.color] as Vec4;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (t >= a.position && t <= b.position) {
      const span = b.position - a.position;
      const f = span <= 0 ? 0 : (t - a.position) / span;
      return lerpVec4SrgbRgbInLinear(a.color, b.color, f);
    }
  }
  return [...last.color] as Vec4;
}

function normalizeStops(raw: unknown): GradientStop[] {
  if (!Array.isArray(raw)) return [];
  const stops: GradientStop[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      stops.push({
        position: clamp(numberOr(e.position, 0), 0, 1),
        color: toVec4(e.color as Vec4),
      });
    }
  }
  return stops;
}

function asTintVec4(value: number | Vec4 | string | boolean | undefined): Vec4 {
  if (Array.isArray(value)) {
    return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0];
  }
  return [1, 1, 1, 1];
}

function resolveColorParam(
  graph: ShaderGraph,
  instance: MaterialInstance,
  name: string,
  fallback: Vec4,
): Vec4 {
  const param = graph.params.find((p) => p.name === name && p.type === "color");
  if (!param) return fallback;
  return asTintVec4(resolveMaterialParamValue(graph, instance, name));
}

function resolveFloatParam(
  graph: ShaderGraph,
  instance: MaterialInstance,
  name: string,
  fallback: number,
): number {
  const param = graph.params.find((p) => p.name === name);
  if (!param) return fallback;
  const value = resolveMaterialParamValue(graph, instance, name);
  return typeof value === "number" ? value : fallback;
}

/**
 * Context for one bake evaluation: the source texel (RGBA 0..1) plus the
 * graph/instance so `param`/`gradientRamp` nodes resolve. `uv` is provided for
 * completeness though static bakes rarely need it.
 */
export interface BakeTexelContext {
  graph: ShaderGraph;
  instance: MaterialInstance;
  /** The source texture sample at this texel, RGBA each 0..1. */
  source: Vec4;
  /** UV coordinate of this texel, each 0..1. */
  uv: [number, number];
  samplerForPath?: BakeTextureSampler;
}

export type BakeTextureSampler = (
  path: string,
  uv: [number, number],
  node: MaterialNode,
) => Vec4 | null | undefined;

export interface TexelEvaluatorOptions {
  samplerForPath?: BakeTextureSampler;
}

/**
 * Evaluate a single graph node to a Vec4, recursing through its wired inputs.
 * `edgeSource` maps an edge id → the source node id + output handle, so an input
 * pin (which stores an edge id) resolves to the upstream node. Cycles are
 * guarded by `visiting`.
 */
function evalNode(
  node: MaterialNode,
  ctx: BakeTexelContext,
  nodeById: Map<string, MaterialNode>,
  edgeById: Map<string, MaterialEdge>,
  visiting: Set<string>,
): Vec4 {
  if (visiting.has(node.id)) return [0, 0, 0, 0];
  visiting.add(node.id);
  const result = evalNodeInner(node, ctx, nodeById, edgeById, visiting);
  visiting.delete(node.id);
  return result;
}

function evalInput(
  node: MaterialNode,
  pin: string,
  fallback: Vec4,
  ctx: BakeTexelContext,
  nodeById: Map<string, MaterialNode>,
  edgeById: Map<string, MaterialEdge>,
  visiting: Set<string>,
): Vec4 {
  const edgeId = node.inputs[pin];
  if (!edgeId) return fallback;
  const edge = edgeById.get(edgeId);
  if (!edge) return fallback;
  const sourceNode = nodeById.get(edge.source);
  if (!sourceNode) return fallback;
  const value = evalNode(sourceNode, ctx, nodeById, edgeById, visiting);
  return selectChannel(value, edge.sourceHandle);
}

function resolveNodeTextureBinding(
  node: MaterialNode,
  ctx: BakeTexelContext,
  nodeById: Map<string, MaterialNode>,
  edgeById: Map<string, MaterialEdge>,
): ReturnType<typeof resolveMaterialTextureNodeBinding> {
  return resolveMaterialTextureNodeBinding(
    ctx.graph,
    ctx.instance,
    node,
    nodeById,
    edgeById,
  );
}

function evalNodeInner(
  node: MaterialNode,
  ctx: BakeTexelContext,
  nodeById: Map<string, MaterialNode>,
  edgeById: Map<string, MaterialEdge>,
  visiting: Set<string>,
): Vec4 {
  const inp = (pin: string, fb: Vec4): Vec4 =>
    evalInput(node, pin, fb, ctx, nodeById, edgeById, visiting);
  const uvInput = (): [number, number] => {
    if (node.inputs.uv) {
      const v = inp("uv", [ctx.uv[0], ctx.uv[1], 0, 0]);
      return [v[0], v[1]];
    }
    return [ctx.uv[0], ctx.uv[1]];
  };
  const p = node.params;

  switch (node.type) {
    case "constant":
      return toVec4(p.value as number | Vec4);
    case "param": {
      const name = typeof p.name === "string" ? p.name : "";
      const resolved = resolveMaterialParamValue(ctx.graph, ctx.instance, name);
      return toVec4(resolved as number | Vec4 | string | boolean | undefined);
    }
    case "textureSample":
    case "particleSubUV": {
      const [u, v] = uvInput();
      const tex = resolveNodeTextureBinding(node, ctx, nodeById, edgeById);
      if (tex.path && !tex.isMainTex && ctx.samplerForPath) {
        const sampled = ctx.samplerForPath(tex.path, [u, v], node);
        if (sampled) return sampled;
      }
      return [...ctx.source] as Vec4;
    }
    case "uv":
      return [ctx.uv[0], ctx.uv[1], 0, 0];
    case "tilingOffset": {
      const uv = inp("uv", [ctx.uv[0], ctx.uv[1], 0, 0]);
      const tile = toVec4(p.tile as Vec4);
      const offset = toVec4(p.offset as Vec4);
      return [
        uv[0] * (tile[0] || 1) + offset[0],
        uv[1] * (tile[1] || 1) + offset[1],
        0,
        0,
      ];
    }
    case "multiply":
      return mulVec4(inp("a", [1, 1, 1, 1]), inp("b", [1, 1, 1, 1]));
    case "add":
      return addVec4(inp("a", [0, 0, 0, 0]), inp("b", [0, 0, 0, 0]));
    case "subtract":
      return subVec4(inp("a", [0, 0, 0, 0]), inp("b", [0, 0, 0, 0]));
    case "divide":
      return divVec4(inp("a", [0, 0, 0, 0]), inp("b", [1, 1, 1, 1]));
    case "min": {
      const a = inp("a", [0, 0, 0, 0]);
      const b = inp("b", [0, 0, 0, 0]);
      return [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.min(a[2], b[2]),
        Math.min(a[3], b[3]),
      ];
    }
    case "max": {
      const a = inp("a", [0, 0, 0, 0]);
      const b = inp("b", [0, 0, 0, 0]);
      return [
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
        Math.max(a[2], b[2]),
        Math.max(a[3], b[3]),
      ];
    }
    case "lerp": {
      const a = inp("a", [0, 0, 0, 0]);
      const b = inp("b", [1, 1, 1, 1]);
      const t = node.inputs.t
        ? inp("t", [0, 0, 0, 0])
        : toVec4(numberOr(p.t, 0.5));
      return lerpVec4(a, b, t);
    }
    case "oneMinus": {
      const v = inp("in", [0, 0, 0, 0]);
      return [1 - v[0], 1 - v[1], 1 - v[2], 1 - v[3]];
    }
    case "clamp": {
      const v = inp("in", [0, 0, 0, 0]);
      // Honored pin contract: inputs.min/max override params.min/max (Agent 2).
      const lo = node.inputs.min
        ? inp("min", [0, 0, 0, 0])[0]
        : numberOr(p.min, 0);
      const hi = node.inputs.max
        ? inp("max", [1, 1, 1, 1])[0]
        : numberOr(p.max, 1);
      return [
        clamp(v[0], lo, hi),
        clamp(v[1], lo, hi),
        clamp(v[2], lo, hi),
        clamp(v[3], lo, hi),
      ];
    }
    case "step": {
      const v = inp("in", [0, 0, 0, 0]);
      // Honored pin contract: inputs.edge overrides params.edge (Agent 2).
      const edge = node.inputs.edge
        ? inp("edge", [0.5, 0, 0, 0])[0]
        : numberOr(p.edge, 0.5);
      return [
        v[0] >= edge ? 1 : 0,
        v[1] >= edge ? 1 : 0,
        v[2] >= edge ? 1 : 0,
        v[3] >= edge ? 1 : 0,
      ];
    }
    case "smoothstep": {
      const v = inp("in", [0, 0, 0, 0]);
      // Honored pin contract: inputs.edge0/edge1 override params (Agent 2).
      const e0 = node.inputs.edge0
        ? inp("edge0", [0, 0, 0, 0])[0]
        : numberOr(p.edge0, 0);
      const e1 = node.inputs.edge1
        ? inp("edge1", [1, 1, 1, 1])[0]
        : numberOr(p.edge1, 1);
      return [
        smoothstep(e0, e1, v[0]),
        smoothstep(e0, e1, v[1]),
        smoothstep(e0, e1, v[2]),
        smoothstep(e0, e1, v[3]),
      ];
    }
    case "power": {
      const v = inp("in", [0, 0, 0, 0]);
      const e = node.inputs.exp
        ? inp("exp", [1, 1, 1, 1])
        : toVec4(numberOr(p.exponent, 1));
      return [
        Math.pow(Math.max(0, v[0]), e[0]),
        Math.pow(Math.max(0, v[1]), e[1]),
        Math.pow(Math.max(0, v[2]), e[2]),
        Math.pow(Math.max(0, v[3]), e[3]),
      ];
    }
    case "remap": {
      const v = inp("in", [0, 0, 0, 0]);
      // Honored pin contract: inputs.inMin/inMax/outMin/outMax override params.
      const inMin = node.inputs.inMin
        ? inp("inMin", [0, 0, 0, 0])[0]
        : numberOr(p.inMin, 0);
      const inMax = node.inputs.inMax
        ? inp("inMax", [1, 1, 1, 1])[0]
        : numberOr(p.inMax, 1);
      const outMin = node.inputs.outMin
        ? inp("outMin", [0, 0, 0, 0])[0]
        : numberOr(p.outMin, 0);
      const outMax = node.inputs.outMax
        ? inp("outMax", [1, 1, 1, 1])[0]
        : numberOr(p.outMax, 1);
      const span = inMax - inMin;
      const remap = (x: number): number => {
        const f = span === 0 ? 0 : (x - inMin) / span;
        return outMin + f * (outMax - outMin);
      };
      return [remap(v[0]), remap(v[1]), remap(v[2]), remap(v[3])];
    }
    case "desaturate": {
      const v = inp("in", [0, 0, 0, 0]);
      const frac = clamp(numberOr(p.fraction, 1), 0, 1);
      const grey = v[0] * REC709[0] + v[1] * REC709[1] + v[2] * REC709[2];
      return [
        lerp(v[0], grey, frac),
        lerp(v[1], grey, frac),
        lerp(v[2], grey, frac),
        v[3],
      ];
    }
    case "split": {
      const v = inp("in", [0, 0, 0, 0]);
      const c = channelOf(v, typeof p.channel === "string" ? p.channel : "r");
      return [c, c, c, c];
    }
    case "combine": {
      return [
        inp("r", [0, 0, 0, 0])[0],
        inp("g", [0, 0, 0, 0])[0],
        inp("b", [0, 0, 0, 0])[0],
        node.inputs.a ? inp("a", [1, 0, 0, 0])[0] : 1,
      ];
    }
    case "swizzle": {
      const v = inp("in", [0, 0, 0, 0]);
      const pattern =
        typeof p.pattern === "string" && p.pattern.length >= 4
          ? p.pattern
          : "rgba";
      return [
        channelOf(v, pattern[0]!),
        channelOf(v, pattern[1]!),
        channelOf(v, pattern[2]!),
        channelOf(v, pattern[3]!),
      ];
    }
    case "fresnel": {
      // 2D radial UV falloff (NOT real Fresnel). Ported verbatim from
      // previewEval.ts so the static bake and live preview agree. Uses the
      // texel UV directly (preview ignores the optional `uv` input pin too).
      const center = toVec4(p.center as Vec4);
      const power = numberOr(p.power, 1);
      const d = Math.hypot(ctx.uv[0] - center[0], ctx.uv[1] - center[1]) * 2;
      const f = Math.pow(Math.max(0, 1 - Math.min(1, d)), power);
      return [f, f, f, f];
    }
    case "sphereMask": {
      // Radial soft mask. Ported verbatim from previewEval.ts.
      const center = toVec4(p.center as Vec4);
      const radius = numberOr(p.radius, 0.5);
      const hardness = clamp(numberOr(p.hardness, 0.5), 0, 1);
      const d = Math.hypot(ctx.uv[0] - center[0], ctx.uv[1] - center[1]);
      const edge = radius * (1 - hardness) + 1e-4;
      const m = clamp(1 - (d - (radius - edge)) / edge, 0, 1);
      return [m, m, m, m];
    }
    // --- iteration 5b P0: cheap math glue (component-wise) ----------------
    case "abs": {
      const v = inp("in", [0, 0, 0, 0]);
      return [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]), Math.abs(v[3])];
    }
    case "frac": {
      const v = inp("in", [0, 0, 0, 0]);
      return [fracOf(v[0]), fracOf(v[1]), fracOf(v[2]), fracOf(v[3])];
    }
    case "floor": {
      const v = inp("in", [0, 0, 0, 0]);
      return [
        Math.floor(v[0]),
        Math.floor(v[1]),
        Math.floor(v[2]),
        Math.floor(v[3]),
      ];
    }
    case "ceil": {
      const v = inp("in", [0, 0, 0, 0]);
      return [
        Math.ceil(v[0]),
        Math.ceil(v[1]),
        Math.ceil(v[2]),
        Math.ceil(v[3]),
      ];
    }
    case "round": {
      const v = inp("in", [0, 0, 0, 0]);
      return [
        Math.round(v[0]),
        Math.round(v[1]),
        Math.round(v[2]),
        Math.round(v[3]),
      ];
    }
    case "sign": {
      const v = inp("in", [0, 0, 0, 0]);
      return [
        Math.sign(v[0]),
        Math.sign(v[1]),
        Math.sign(v[2]),
        Math.sign(v[3]),
      ];
    }
    case "sqrt": {
      const v = inp("in", [0, 0, 0, 0]);
      return [
        Math.sqrt(Math.max(0, v[0])),
        Math.sqrt(Math.max(0, v[1])),
        Math.sqrt(Math.max(0, v[2])),
        Math.sqrt(Math.max(0, v[3])),
      ];
    }
    case "length": {
      const v = inp("in", [0, 0, 0, 0]);
      const l = Math.hypot(v[0], v[1], v[2]);
      return [l, l, l, l];
    }
    case "normalize": {
      const v = inp("in", [0, 0, 0, 0]);
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l, v[3]];
    }
    case "dot": {
      const a = inp("a", [0, 0, 0, 0]);
      const b = inp("b", [0, 0, 0, 0]);
      const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      return [d, d, d, d];
    }
    case "sine":
    case "cosine": {
      const v = inp("in", [0, 0, 0, 0]);
      const period = numberOr(p.period, 1) || 1;
      const f = node.type === "sine" ? Math.sin : Math.cos;
      const w = (2 * Math.PI) / period;
      return [f(v[0] * w), f(v[1] * w), f(v[2] * w), f(v[3] * w)];
    }
    case "if": {
      const a = inp("a", [0, 0, 0, 0])[0];
      const b = inp("b", [0, 0, 0, 0])[0];
      const eps = 1e-6;
      if (a > b + eps) return inp("aGreater", [0, 0, 0, 0]);
      if (a < b - eps) return inp("aLess", [0, 0, 0, 0]);
      // A ≈ B: use the equal pin when wired, else fall back to the greater path.
      return node.inputs.aEqual
        ? inp("aEqual", [0, 0, 0, 0])
        : inp("aGreater", [0, 0, 0, 0]);
    }
    // --- iteration 5b P0: baked noise + masks -----------------------------
    case "noise": {
      const pos = inp("Position", [ctx.uv[0], ctx.uv[1], 0, 0]);
      const n = sampleScalarNoise(
        scalarNoiseOptionsFromParams(p),
        pos[0],
        pos[1],
      );
      return [n, n, n, n];
    }
    case "vectorNoise": {
      const pos = inp("Position", [ctx.uv[0], ctx.uv[1], 0, 0]);
      return sampleVectorNoise(vectorNoiseOptionsFromParams(p), pos[0], pos[1]);
    }
    case "antialiasedTextureMask": {
      // Per-texel bake: read the chosen channel of the node texture (wired
      // texture-param or params.tex), falling back to the source texel.
      const channel = typeof p.channel === "string" ? p.channel : "a";
      const [u, v] = uvInput();
      const tex = resolveNodeTextureBinding(node, ctx, nodeById, edgeById);
      const sampled =
        tex.path && !tex.isMainTex && ctx.samplerForPath
          ? ctx.samplerForPath(tex.path, [u, v], node)
          : null;
      const m = channelOf(sampled ?? ctx.source, channel);
      const threshold = node.inputs.Threshold
        ? inp("Threshold", [0.5, 0, 0, 0])[0]
        : numberOr(p.threshold, 0.5);
      const width = Math.max(numberOr(p.softness, 0.04), 1e-4);
      const out = smoothstep(threshold - width, threshold + width, m);
      return [out, out, out, out];
    }
    case "sphericalParticleOpacity": {
      // Default the center to the sprite middle (matches previewEval) so a
      // center-less static graph bakes identically to the live preview.
      const center: Vec4 =
        p.center === undefined ? [0.5, 0.5, 0, 0] : toVec4(p.center as Vec4);
      const radius = Math.max(numberOr(p.radius, 0.5), 1e-4);
      const density = node.inputs.Density
        ? inp("Density", [1, 0, 0, 0])[0]
        : numberOr(p.density, 1);
      const d =
        Math.hypot(ctx.uv[0] - center[0], ctx.uv[1] - center[1]) / radius;
      const o = clamp(Math.pow(Math.max(0, 1 - d), density), 0, 1);
      return [o, o, o, o];
    }
    case "particleMacroUV": {
      // No per-particle position at bake time → fall back to the texel UV.
      const pos = inp("Position", [ctx.uv[0], ctx.uv[1], 0, 0]);
      const center = toVec4(p.center as Vec4);
      const radius = numberOr(p.radius, 512) || 1;
      const tile = toVec4(p.tile as Vec4);
      const offset = toVec4(p.offset as Vec4);
      return [
        ((pos[0] - center[0]) / radius) * (tile[0] || 1) + offset[0],
        ((pos[1] - center[1]) / radius) * (tile[1] || 1) + offset[1],
        0,
        0,
      ];
    }
    case "gradientRamp": {
      const stops = normalizeStops(p.stops);
      const sorted = [...stops].sort((a, b) => a.position - b.position);
      const t = clamp(inp("t", [ctx.source[0], 0, 0, 0])[0], 0, 1);
      return sampleGradient(sorted, t);
    }
    case "output":
      // The Output node is not evaluated as a value source here; the bake
      // walks each honored slot via `bakeOutputSlot`.
      return [0, 0, 0, 0];
    default:
      // A non-bakeable node leaked into a "static" graph — neutral pass-through.
      return [...ctx.source] as Vec4;
  }
}

/**
 * A per-texel RGBA evaluator for one source texel. `source` is the input texel
 * (RGBA 0..1); returns the baked RGBA (each 0..1). This composes the honored
 * output slots into a single RGBA the renderer can upload as a derived texture:
 *  - baseColor → RGB  (defaults to the source RGB when unwired)
 *  - opacity / opacityMask → A
 *  - emissive  → folded into RGB intensity (author-time brightness)
 */
export function makeTexelEvaluator(
  graph: ShaderGraph,
  instance: MaterialInstance,
  options: TexelEvaluatorOptions = {},
): (source: Vec4, uv: [number, number]) => Vec4 {
  const nodeById = new Map<string, MaterialNode>();
  for (const n of graph.nodes) nodeById.set(n.id, n);
  const edgeById = new Map<string, MaterialEdge>();
  for (const e of graph.edges) edgeById.set(e.id, e);

  /** Resolve the {node, sourceHandle} driving an honored output slot. */
  const slotSource = (
    slot: keyof typeof graph.outputs,
  ): { node: MaterialNode; handle: string } | null => {
    const edgeId = graph.outputs[slot];
    if (!edgeId) return null;
    const edge = edgeById.get(edgeId);
    if (!edge) return null;
    const node = nodeById.get(edge.source);
    return node ? { node, handle: edge.sourceHandle } : null;
  };

  const baseSrc = slotSource("baseColor");
  const opacitySrc = slotSource("opacity");
  const maskSrc = slotSource("opacityMask");
  const emissiveSrc = slotSource("emissive");
  const fixedTint = resolveColorParam(graph, instance, "Tint", [1, 1, 1, 1]);
  const fixedEmissive = resolveFloatParam(graph, instance, "Emissive", 0);
  const fixedOpacity = resolveFloatParam(graph, instance, "Opacity", 1);

  const evalSlot = (
    src: { node: MaterialNode; handle: string },
    ctx: BakeTexelContext,
    visiting: Set<string>,
  ): Vec4 =>
    selectChannel(
      evalNode(src.node, ctx, nodeById, edgeById, visiting),
      src.handle,
    );

  return (source: Vec4, uv: [number, number]): Vec4 => {
    const ctx: BakeTexelContext = {
      graph,
      instance,
      source,
      uv,
      samplerForPath: options.samplerForPath,
    };
    const visiting = new Set<string>();

    const base = baseSrc
      ? evalSlot(baseSrc, ctx, visiting)
      : ([source[0], source[1], source[2], source[3]] as Vec4);

    let rgb: Vec4 = [base[0], base[1], base[2], 0];

    if (emissiveSrc) {
      const e = evalSlot(emissiveSrc, ctx, visiting);
      // Emissive is an author-time brightness multiplier folded into RGB.
      const intensity = 1 + e[0];
      rgb = [rgb[0] * intensity, rgb[1] * intensity, rgb[2] * intensity, 0];
    }

    let alpha = base[3];
    if (opacitySrc) {
      alpha = evalSlot(opacitySrc, ctx, visiting)[0];
    }
    if (maskSrc) {
      const clip = graph.opacityMaskClipValue ?? 0.333;
      const m = evalSlot(maskSrc, ctx, visiting)[0];
      // Baked alpha threshold (Tier 0): below clip → fully transparent.
      // Masked binarizes surviving texels to full coverage (Unreal Masked
      // semantics: the mask gates draw/no-draw); other blends keep the soft
      // passthrough byte-identical to before (I12-G).
      alpha = m < clip ? 0 : graph.blend === "masked" ? 1 : alpha;
    } else if (graph.blend === "masked") {
      // Masked with no wired mask thresholds the computed opacity itself
      // (true binary 0-or-1, mirroring the Tier-2 discard fallback, I12-G).
      const clip = graph.opacityMaskClipValue ?? 0.333;
      alpha = alpha < clip ? 0 : 1;
    }

    return [
      clamp(rgb[0] * fixedTint[0] * (1 + Math.max(0, fixedEmissive)), 0, 1),
      clamp(rgb[1] * fixedTint[1] * (1 + Math.max(0, fixedEmissive)), 0, 1),
      clamp(rgb[2] * fixedTint[2] * (1 + Math.max(0, fixedEmissive)), 0, 1),
      clamp(alpha * fixedTint[3] * fixedOpacity, 0, 1),
    ];
  };
}

/**
 * Run the per-texel evaluator over a straight-alpha RGBA byte buffer IN PLACE
 * (same shape/contract as `deriveAlphaInPlace`), so the Pixi canvas wrapper can
 * read pixels → bake → write back. Bytes are 0..255; the evaluator works in
 * 0..1 space and the result is written back as bytes.
 */
export function bakeGraphInPlace(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  graph: ShaderGraph,
  instance: MaterialInstance,
  options: TexelEvaluatorOptions = {},
): void {
  const evaluate = makeTexelEvaluator(graph, instance, options);
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const texel = i / 4;
    const x = texel % w;
    const y = Math.floor(texel / w);
    const source: Vec4 = [
      rgba[i]! / 255,
      rgba[i + 1]! / 255,
      rgba[i + 2]! / 255,
      rgba[i + 3]! / 255,
    ];
    const uv: [number, number] = [
      w <= 1 ? 0 : x / (w - 1),
      h <= 1 ? 0 : y / (h - 1),
    ];
    const out = evaluate(source, uv);
    rgba[i] = out[0] * 255;
    rgba[i + 1] = out[1] * 255;
    rgba[i + 2] = out[2] * 255;
    rgba[i + 3] = out[3] * 255;
  }
}
