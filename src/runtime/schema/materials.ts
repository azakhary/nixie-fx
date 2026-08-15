import type { Vec4 } from "../../engine/math";
import {
  clampNumber,
  isRecord,
  normalizeVec4,
  numberOr,
  safeString,
} from "../../engine/particleModuleSettingUtils";
import {
  normalizeMaterialInstance,
  normalizeMaterialTextureRef,
  serializeMaterialInstance,
  SPRITE_MASTER_SHADER_ID,
  type MaterialInstance,
  type MaterialParamValue,
  type MaterialTextureRef,
} from "../../engine/materialInstance";

// Instance shapes live in the engine layer (the emitter carries them); re-export
// so all material code can import a single `materials` module.
export {
  normalizeMaterialInstance,
  normalizeMaterialTextureRef,
  serializeMaterialInstance,
  SPRITE_MASTER_SHADER_ID,
};
export type { MaterialInstance, MaterialParamValue, MaterialTextureRef };

/** Alias kept for the schema's param-default vocabulary. */
export type MaterialParamDefault = MaterialParamValue;

/**
 * Material / Shader Editor — runtime + serialization schema (techspec §3.1).
 *
 * A `ShaderGraph` is the reusable definition (Unreal "Material"); a
 * `MaterialInstance` is `{ shaderId, paramOverrides }` (Unreal "Material
 * Instance"). The graph compiler (`editor/materials/graphModel.ts`) resolves a
 * graph+instance into the cheapest runtime tier; this module owns ONLY the data
 * shapes, their `normalize*` round-trip, and the built-in "Sprite Master"
 * definition whose params == today's fixed-function controls.
 *
 * Conventions mirror `particleModuleSettings.ts`: `normalizeFoo(value, fallback)`
 * with `isRecord` guards, default-true booleans via `!== false`, persist
 * helpers that omit defaults. All vector/color params fold to UBO uniforms
 * (Tier 1) or constant-fold at bake (Tier 0) — they add no per-particle cost.
 */

// ---------------------------------------------------------------------------
// Parameter + output vocabulary
// ---------------------------------------------------------------------------

export type MaterialParamType =
  | "float"
  | "vec2"
  | "vec3"
  | "color" // == vec4
  | "texture"
  | "bool";

export const MATERIAL_PARAM_TYPES: readonly MaterialParamType[] = [
  "float",
  "vec2",
  "vec3",
  "color",
  "texture",
  "bool",
];

/** `global` == Unreal CollectionParameter (a shared UBO across materials). */
export type MaterialParamScope = "per-material" | "global";

/**
 * Blend states the renderer can realize (renderer key axis). `normal`/`add`
 * leave the emitter's render blend authoritative (legacy contract);
 * `masked`/`opaque` are material-authoritative and override it (I12-G).
 */
export type MaterialBlend = "normal" | "add" | "masked" | "opaque";

export const MATERIAL_BLENDS: readonly MaterialBlend[] = [
  "normal",
  "add",
  "masked",
  "opaque",
];

/** Which faces the material renders in the 3D backend. Default is two-sided. */
export type MaterialRenderFace = "double" | "front" | "back";

export const MATERIAL_RENDER_FACES: readonly MaterialRenderFace[] = [
  "double",
  "front",
  "back",
];

export const DEFAULT_MATERIAL_RENDER_FACE: MaterialRenderFace = "double";

export const MATERIAL_MAIN_TEX_PARAM_NAME = "MainTex";

export type MaterialParamBuiltinRole = "mainTex";

/** Unlit-honored output sinks only (techspec §2). */
export type MaterialOutputSlot =
  "baseColor" | "emissive" | "opacity" | "opacityMask";

export const MATERIAL_OUTPUT_SLOTS: readonly MaterialOutputSlot[] = [
  "baseColor",
  "emissive",
  "opacity",
  "opacityMask",
];

export type DynamicChannelLabels = [string, string, string, string];

export const DEFAULT_DYNAMIC_CHANNEL_LABELS: DynamicChannelLabels = [
  "Param1",
  "Param2",
  "Param3",
  "Param4",
];

/**
 * How a `perParticle: true` param is physically delivered. Set by the compiler,
 * never authored. There is NO 6th `ParticleContainer` attribute (techspec §0),
 * so a per-particle param is one of:
 *  - `spawn-color`  constant-at-spawn baked into the 8-bit color → Tier 0/1, free
 *  - `smuggle-8bit` animated 0..1 into a spare color/uvs channel IF unused → Tier 1
 *  - `mesh-attr`    animated float range → Tier-2 custom-Mesh fp16 attribute ONLY
 */
export type MaterialPerParticleFeed =
  "spawn-color" | "smuggle-8bit" | "mesh-attr";

export interface MaterialParam {
  /** Unique within the shader; the Custom-Data re-key target (§5). */
  name: string;
  type: MaterialParamType;
  /** Unreal "Group" for inspector sectioning. */
  group: string;
  /** texture default = asset path; color default = Vec4. */
  default: MaterialParamDefault;
  /** UIMin (float only). */
  sliderMin?: number;
  /** UIMax (float only). */
  sliderMax?: number;
  /** Hard ClampMin/Max. */
  clampMin?: number;
  clampMax?: number;
  /** Defaults to "per-material". */
  scope: MaterialParamScope;
  /** When true the param is fed by DynamicParameter (§5). float only. */
  perParticle?: boolean;
  /** How a `perParticle` param is delivered (compiler-assigned). */
  perParticleFeed?: MaterialPerParticleFeed;
  /** Built-in semantic role; currently marks the implicit material MainTex. */
  builtinRole?: MaterialParamBuiltinRole;
}

// ---------------------------------------------------------------------------
// Graph nodes / edges
// ---------------------------------------------------------------------------

export type MaterialNodeType =
  | "param"
  | "constant"
  | "time"
  | "textureSample"
  | "particleSubUV"
  | "uv"
  | "tilingOffset"
  | "rotateUV"
  | "panner"
  | "multiply"
  | "add"
  | "subtract"
  | "divide"
  | "lerp"
  | "oneMinus"
  | "clamp"
  | "step"
  | "smoothstep"
  | "power"
  | "min"
  | "max"
  | "remap"
  | "split"
  | "combine"
  | "swizzle"
  | "desaturate"
  | "fresnel" // 2D radial UV falloff (NOT real Fresnel — §4)
  | "sphereMask"
  // --- iteration 5b P0: cheap math glue (Unreal Math Expressions) ---
  | "abs"
  | "frac"
  | "floor"
  | "ceil"
  | "round"
  | "sign"
  | "sqrt"
  | "length"
  | "normalize"
  | "dot"
  | "sine"
  | "cosine"
  | "if"
  // --- iteration 5b P0: baked noise + masks + particle UV (Unreal Utility) ---
  | "noise" // baked grayscale FBM/Voronoi (Tier 0 by default)
  | "vectorNoise" // baked vector field (Tier 0 by default)
  | "particleMacroUV" // emitter-wide continuous UVs
  | "antialiasedTextureMask" // soft channel threshold mask
  | "sphericalParticleOpacity" // procedural round-sprite opacity
  | "gradientRamp" // BAKE → 1x256 LUT
  | "dynamicParameter" // per-particle float4 feed (§5)
  | "particleColor"
  | "particleRelativeTime"
  | "particleSpeed"
  | "particleRandom"
  | "particleSize"
  | "particleDirection"
  | "particlePosition"
  | "subgraph" // author-time reuse, inlined
  | "output"; // the Main node

export const MATERIAL_NODE_TYPES: readonly MaterialNodeType[] = [
  "param",
  "constant",
  "time",
  "textureSample",
  "particleSubUV",
  "uv",
  "tilingOffset",
  "rotateUV",
  "panner",
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
  "noise",
  "vectorNoise",
  "particleMacroUV",
  "antialiasedTextureMask",
  "sphericalParticleOpacity",
  "gradientRamp",
  "dynamicParameter",
  "particleColor",
  "particleRelativeTime",
  "particleSpeed",
  "particleRandom",
  "particleSize",
  "particleDirection",
  "particlePosition",
  "subgraph",
  "output",
];

const MATERIAL_NODE_TYPE_SET = new Set<string>(MATERIAL_NODE_TYPES);

export interface MaterialNodePosition {
  x: number;
  y: number;
}

export interface MaterialNode {
  id: string;
  type: MaterialNodeType;
  /** pin name -> edge id (or null/unwired). */
  inputs: Record<string, string | null>;
  /** node-local authored values (constant value, ramp stops, ...). */
  params: Record<string, unknown>;
  /** ReactFlow node position (editor-only). */
  position: MaterialNodePosition;
}

export interface MaterialEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface ShaderGraph {
  /** materialShaderId base. */
  id: string;
  name: string;
  blend: MaterialBlend;
  /**
   * Unreal Opacity Mask Clip Value; default 0.333. Only meaningful when an
   * opacityMask output is wired. Constant => baked threshold (Tier 0);
   * per-particle (DynamicParameter) => Tier-2 discard only.
   */
  opacityMaskClipValue?: number;
  /** Rendered face selection for real 3D meshes/quads. Undefined == double. */
  side?: MaterialRenderFace;
  nodes: MaterialNode[];
  edges: MaterialEdge[];
  /** The Blackboard / Material Instance declared params. */
  params: MaterialParam[];
  /** Material-level labels for DynamicParameter Param1..4 channels. */
  dynamicChannelLabels?: DynamicChannelLabels;
  /** slot -> driving edge id. */
  outputs: Partial<Record<MaterialOutputSlot, string | null>>;
  /** Marks the seeded fixed-function shader. */
  builtin?: "sprite-master";
}

export const DEFAULT_OPACITY_MASK_CLIP_VALUE = 0.333;

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export function defaultValueForParamType(
  type: MaterialParamType,
): MaterialParamDefault {
  switch (type) {
    case "float":
      return 0;
    case "vec2":
      return [0, 0, 0, 0];
    case "vec3":
      return [0, 0, 0, 0];
    case "color":
      return [1, 1, 1, 1];
    case "texture":
      return "";
    case "bool":
      return false;
  }
}

function normalizeParamType(value: unknown): MaterialParamType {
  return MATERIAL_PARAM_TYPES.includes(value as MaterialParamType)
    ? (value as MaterialParamType)
    : "float";
}

function normalizeParamScope(value: unknown): MaterialParamScope {
  return value === "global" ? "global" : "per-material";
}

function normalizePerParticleFeed(
  value: unknown,
): MaterialPerParticleFeed | undefined {
  return value === "spawn-color" ||
    value === "smuggle-8bit" ||
    value === "mesh-attr"
    ? value
    : undefined;
}

function normalizeParamBuiltinRole(
  value: unknown,
  type: MaterialParamType,
  name: string,
): MaterialParamBuiltinRole | undefined {
  if (
    type === "texture" &&
    (value === "mainTex" || name === MATERIAL_MAIN_TEX_PARAM_NAME)
  ) {
    return "mainTex";
  }
  return undefined;
}

/**
 * Coerce an authored/override value to the param's type. Used by both
 * `normalizeMaterialParam` (defaults) and `resolveMaterialParamValue`
 * (instance overrides), so author-time and runtime agree.
 */
export function coerceParamValue(
  type: MaterialParamType,
  value: unknown,
  fallback: MaterialParamDefault,
): MaterialParamDefault {
  switch (type) {
    case "float":
      return numberOr(value, fallback as number);
    case "vec2":
    case "vec3":
    case "color": {
      const fb = (
        Array.isArray(fallback) ? fallback : defaultValueForParamType(type)
      ) as Vec4;
      // color clamps 0..1; vec2/vec3 allow wider tiling/offset ranges.
      const [lo, hi] = type === "color" ? [0, 1] : [-100000, 100000];
      return normalizeVec4(value, fb, lo, hi);
    }
    case "texture":
      return typeof value === "string" ? value : (fallback as string);
    case "bool":
      return typeof value === "boolean" ? value : (fallback as boolean);
  }
}

export function normalizeMaterialParam(
  value: unknown,
  fallbackGroup = "Parameters",
): MaterialParam {
  const source = isRecord(value) ? value : {};
  const type = normalizeParamType(source.type);
  const typeDefault = defaultValueForParamType(type);
  const name = safeString(source.name, "Param");
  const param: MaterialParam = {
    name,
    type,
    group: safeString(source.group, fallbackGroup),
    default: coerceParamValue(type, source.default, typeDefault),
    scope: normalizeParamScope(source.scope),
  };
  if (type === "float") {
    if (typeof source.sliderMin === "number")
      param.sliderMin = source.sliderMin;
    if (typeof source.sliderMax === "number")
      param.sliderMax = source.sliderMax;
  }
  if (typeof source.clampMin === "number") param.clampMin = source.clampMin;
  if (typeof source.clampMax === "number") param.clampMax = source.clampMax;
  // perParticle is float-only (§3.1).
  if (type === "float" && source.perParticle === true) param.perParticle = true;
  const feed = normalizePerParticleFeed(source.perParticleFeed);
  if (feed) param.perParticleFeed = feed;
  const builtinRole = normalizeParamBuiltinRole(source.builtinRole, type, name);
  if (builtinRole) param.builtinRole = builtinRole;
  return param;
}

function normalizeNodePosition(value: unknown): MaterialNodePosition {
  const source = isRecord(value) ? value : {};
  return {
    x: numberOr(source.x, 0),
    y: numberOr(source.y, 0),
  };
}

function normalizeInputs(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) return {};
  const out: Record<string, string | null> = {};
  for (const [pin, edge] of Object.entries(value)) {
    out[pin] = typeof edge === "string" ? edge : null;
  }
  return out;
}

export function normalizeMaterialNode(value: unknown): MaterialNode | null {
  const source = isRecord(value) ? value : {};
  // Forward-compat: drop unknown node types (§3.3).
  if (!MATERIAL_NODE_TYPE_SET.has(source.type as string)) return null;
  return {
    id: safeString(source.id, ""),
    type: source.type as MaterialNodeType,
    inputs: normalizeInputs(source.inputs),
    params: isRecord(source.params) ? { ...source.params } : {},
    position: normalizeNodePosition(source.position),
  };
}

export function normalizeMaterialEdge(value: unknown): MaterialEdge | null {
  const source = isRecord(value) ? value : {};
  const id = safeString(source.id, "");
  const sourceId = safeString(source.source, "");
  const targetId = safeString(source.target, "");
  if (!id || !sourceId || !targetId) return null;
  return {
    id,
    source: sourceId,
    sourceHandle: safeString(source.sourceHandle, "out"),
    target: targetId,
    targetHandle: safeString(source.targetHandle, "in"),
  };
}

function normalizeBlend(value: unknown): MaterialBlend {
  return MATERIAL_BLENDS.includes(value as MaterialBlend)
    ? (value as MaterialBlend)
    : "normal";
}

/** Material blends that override the emitter's render blend (I12-G). */
export function materialBlendOverridesEmitter(
  blend: MaterialBlend | EffectiveParticleBlend | null | undefined,
): blend is "masked" | "opaque" {
  return blend === "masked" || blend === "opaque";
}

/**
 * The effective GPU blend for a particle draw. `masked`/`opaque` materials own
 * the blend state (Unreal parity); `normal`/`add` keep the emitter's
 * `render.blend` authoritative so legacy effects render byte-identical. Both
 * backends must resolve through here — no ad-hoc per-renderer branches.
 */
export type EffectiveParticleBlend =
  "alpha" | "additive" | "premultiplied" | "masked" | "opaque";

export function resolveEffectiveParticleBlend(
  emitterBlend: "alpha" | "additive" | "premultiplied",
  materialBlend: MaterialBlend | null | undefined,
): EffectiveParticleBlend {
  return materialBlendOverridesEmitter(materialBlend)
    ? materialBlend
    : emitterBlend;
}

export function normalizeMaterialRenderFace(
  value: unknown,
): MaterialRenderFace {
  return MATERIAL_RENDER_FACES.includes(value as MaterialRenderFace)
    ? (value as MaterialRenderFace)
    : DEFAULT_MATERIAL_RENDER_FACE;
}

function normalizeOutputs(
  value: unknown,
): Partial<Record<MaterialOutputSlot, string | null>> {
  const source = isRecord(value) ? value : {};
  const out: Partial<Record<MaterialOutputSlot, string | null>> = {};
  for (const slot of MATERIAL_OUTPUT_SLOTS) {
    const edge = source[slot];
    if (typeof edge === "string") out[slot] = edge;
    else if (edge === null) out[slot] = null;
  }
  return out;
}

export function normalizeDynamicChannelLabels(
  value: unknown,
  fallback: readonly string[] = DEFAULT_DYNAMIC_CHANNEL_LABELS,
): DynamicChannelLabels {
  const arr = Array.isArray(value) ? value : [];
  return DEFAULT_DYNAMIC_CHANNEL_LABELS.map((defaultLabel, index) => {
    const label =
      typeof arr[index] === "string" && arr[index].trim()
        ? (arr[index] as string).trim()
        : typeof fallback[index] === "string" && fallback[index].trim()
          ? fallback[index].trim()
          : defaultLabel;
    return label;
  }) as DynamicChannelLabels;
}

function firstDynamicParameterNodeLabels(
  nodes: readonly MaterialNode[],
): DynamicChannelLabels {
  const node = nodes.find((entry) => entry.type === "dynamicParameter");
  return normalizeDynamicChannelLabels(node?.params.paramNames);
}

function dynamicChannelLabelsAreDefault(
  labels: readonly string[] | undefined,
): boolean {
  return DEFAULT_DYNAMIC_CHANNEL_LABELS.every(
    (label, index) => labels?.[index] === label,
  );
}

export function normalizeShaderGraph(value: unknown): ShaderGraph {
  const source = isRecord(value) ? value : {};
  const nodes = Array.isArray(source.nodes)
    ? source.nodes
        .map((n) => normalizeMaterialNode(n))
        .filter((n): n is MaterialNode => n !== null && n.id !== "")
    : [];
  const edges = Array.isArray(source.edges)
    ? source.edges
        .map((e) => normalizeMaterialEdge(e))
        .filter((e): e is MaterialEdge => e !== null)
    : [];
  const params = Array.isArray(source.params)
    ? source.params.map((p) => normalizeMaterialParam(p))
    : [];
  const graph: ShaderGraph = {
    id: safeString(source.id, "material"),
    name: safeString(source.name, "Material"),
    blend: normalizeBlend(source.blend),
    nodes,
    edges,
    params,
    dynamicChannelLabels: normalizeDynamicChannelLabels(
      source.dynamicChannelLabels,
      firstDynamicParameterNodeLabels(nodes),
    ),
    outputs: normalizeOutputs(source.outputs),
  };
  if (typeof source.opacityMaskClipValue === "number") {
    graph.opacityMaskClipValue = clampNumber(source.opacityMaskClipValue, 0, 1);
  }
  if (MATERIAL_RENDER_FACES.includes(source.side as MaterialRenderFace)) {
    graph.side = source.side as MaterialRenderFace;
  }
  if (source.builtin === "sprite-master") graph.builtin = "sprite-master";
  return graph;
}

// ---------------------------------------------------------------------------
// Instance helpers
// ---------------------------------------------------------------------------

/** Look up a param's effective value, applying an instance override if present. */
export function resolveMaterialParamValue(
  graph: ShaderGraph,
  instance: MaterialInstance,
  paramName: string,
): MaterialParamDefault | undefined {
  const param = graph.params.find((p) => p.name === paramName);
  if (!param) return undefined;
  if (isMainTexParam(param) && instance.mainTex?.path) {
    return instance.mainTex.path;
  }
  if (
    Object.prototype.hasOwnProperty.call(instance.paramOverrides, paramName)
  ) {
    return coerceParamValue(
      param.type,
      instance.paramOverrides[paramName],
      param.default,
    );
  }
  return param.default;
}

export function isMainTexParam(param: MaterialParam): boolean {
  return (
    param.type === "texture" &&
    (param.builtinRole === "mainTex" ||
      param.name === MATERIAL_MAIN_TEX_PARAM_NAME)
  );
}

export function resolveEffectiveMainTexPath(
  graph: ShaderGraph | undefined,
  instance: MaterialInstance | null | undefined,
): string {
  if (!instance) return "";
  if (instance.mainTex?.path) return instance.mainTex.path;
  const param = graph?.params.find(isMainTexParam);
  return typeof param?.default === "string" ? param.default : "";
}

export interface MaterialTextureNodeBinding {
  path: string;
  isMainTex: boolean;
}

export function resolveMaterialTextureNodeBinding(
  graph: ShaderGraph,
  instance: MaterialInstance,
  node: MaterialNode,
  nodeById: ReadonlyMap<string, MaterialNode>,
  edgeById: ReadonlyMap<string, MaterialEdge>,
): MaterialTextureNodeBinding {
  const edgeId = node.inputs.tex;
  if (edgeId) {
    const edge = edgeById.get(edgeId);
    const source = edge ? nodeById.get(edge.source) : undefined;
    if (source?.type === "param") {
      const name =
        typeof source.params.name === "string" ? source.params.name : "";
      const param = graph.params.find((entry) => entry.name === name);
      if (param?.type === "texture") {
        const isMainTex = isMainTexParam(param);
        const value = resolveMaterialParamValue(graph, instance, name);
        return {
          path: typeof value === "string" ? value : "",
          isMainTex,
        };
      }
    }
  }
  const tex = node.params.tex;
  return {
    path: typeof tex === "string" ? tex : "",
    isMainTex: false,
  };
}

export function createMaterialInstance(
  graph: ShaderGraph,
  id: string,
): MaterialInstance {
  return {
    id,
    shaderId: graph.id,
    paramOverrides: {},
    mainTex: null,
  };
}

// ---------------------------------------------------------------------------
// Persist-when-non-default serialization (§3.3)
// ---------------------------------------------------------------------------

/**
 * Serialize a param dropping fields equal to their type default, with a
 * deterministic key order for stable export hashing (§12).
 */
export function serializeMaterialParam(
  param: MaterialParam,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: param.name,
    type: param.type,
    group: param.group,
    default: param.default,
  };
  if (param.scope !== "per-material") out.scope = param.scope;
  if (param.sliderMin !== undefined) out.sliderMin = param.sliderMin;
  if (param.sliderMax !== undefined) out.sliderMax = param.sliderMax;
  if (param.clampMin !== undefined) out.clampMin = param.clampMin;
  if (param.clampMax !== undefined) out.clampMax = param.clampMax;
  if (param.perParticle) out.perParticle = true;
  if (param.perParticleFeed) out.perParticleFeed = param.perParticleFeed;
  if (param.builtinRole) out.builtinRole = param.builtinRole;
  return out;
}

export function serializeShaderGraph(
  graph: ShaderGraph,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: graph.id,
    name: graph.name,
    blend: graph.blend,
    nodes: graph.nodes,
    edges: graph.edges,
    params: graph.params.map(serializeMaterialParam),
    outputs: graph.outputs,
  };
  if (!dynamicChannelLabelsAreDefault(graph.dynamicChannelLabels)) {
    out.dynamicChannelLabels = graph.dynamicChannelLabels;
  }
  if (
    graph.opacityMaskClipValue !== undefined &&
    graph.opacityMaskClipValue !== DEFAULT_OPACITY_MASK_CLIP_VALUE
  ) {
    out.opacityMaskClipValue = graph.opacityMaskClipValue;
  }
  if (graph.side !== undefined) {
    out.side = graph.side;
  }
  if (graph.builtin) out.builtin = graph.builtin;
  return out;
}

// ---------------------------------------------------------------------------
// Built-in "Sprite Master" shader (techspec §G2)
// ---------------------------------------------------------------------------

/**
 * The seeded fixed-function shader. Its params == today's fixed-function
 * controls (tint / emissive / opacity + MainTex), so a texture-only emitter is
 * just an emitter whose implicit material is Sprite Master. Reuses the existing
 * `ParticleContainer` + `sampleParticleModuleColor` color path — zero perf
 * change, no graph required.
 */
export function createSpriteMasterGraph(): ShaderGraph {
  const params: MaterialParam[] = [
    {
      name: "MainTex",
      type: "texture",
      group: "Texture",
      default: "",
      scope: "per-material",
      builtinRole: "mainTex",
    },
    {
      name: "Tint",
      type: "color",
      group: "Color",
      default: [1, 1, 1, 1],
      scope: "per-material",
    },
    {
      name: "Emissive",
      type: "float",
      group: "Color",
      default: 0,
      sliderMin: 0,
      sliderMax: 4,
      clampMin: 0,
      clampMax: 16,
      scope: "per-material",
    },
    {
      name: "Opacity",
      type: "float",
      group: "Color",
      default: 1,
      sliderMin: 0,
      sliderMax: 1,
      clampMin: 0,
      clampMax: 1,
      scope: "per-material",
    },
  ];
  return {
    id: SPRITE_MASTER_SHADER_ID,
    name: "Sprite Master",
    blend: "normal",
    nodes: [],
    edges: [],
    params,
    outputs: {
      baseColor: null,
      emissive: null,
      opacity: null,
    },
    builtin: "sprite-master",
  };
}

export function isSpriteMasterGraph(graph: ShaderGraph): boolean {
  return (
    graph.builtin === "sprite-master" || graph.id === SPRITE_MASTER_SHADER_ID
  );
}
