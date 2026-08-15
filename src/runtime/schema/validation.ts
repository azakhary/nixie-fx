import {
  PARTICLE_HDR_COLOR_INTENSITY_VALUE_LIMIT,
  normalizeParticleEffect,
  type ParticleEffectDefinition,
  type ParticleEmitterDefinition,
} from "../../engine/particles";
import {
  PARTICLE_EMITTER_MODULE_KEYS,
  PARTIAL_PARTICLE_MODULE_KEYS,
  type ParticleEmitterModuleKey,
} from "../../engine/particleModuleSettings";
import {
  validateVfxMeshAssetPath,
  validateVfxTextureAssetPath,
} from "../assets/paths";
import { normalizeShaderGraph, type ShaderGraph } from "./materials";
import type { MaterialInstance } from "../../engine/materialInstance";

export type VfxValidationSeverity = "error" | "warning";

export type VfxValidationIssueCode =
  | "bad-kind"
  | "bad-version"
  | "missing-id"
  | "duplicate-id"
  | "invalid-asset-ref"
  | "unsupported-module"
  | "clamped-value"
  // Material-aware diagnostics (techspec §9, §12).
  | "missing-material"
  | "material-sampler-cap"
  | "material-variant-cap"
  | "material-banned-node"
  | "material-channel-conflict"
  | "material-runtime-noise";

export interface VfxValidationIssue {
  severity: VfxValidationSeverity;
  code: VfxValidationIssueCode;
  path: string;
  message: string;
}

export interface VfxExportBlocker {
  code: VfxValidationIssueCode;
  path: string;
  message: string;
}

export interface VfxValidationResult {
  valid: boolean;
  errors: VfxValidationIssue[];
  warnings: VfxValidationIssue[];
  blockers: VfxExportBlocker[];
}

export interface VfxAuthoringValidationOptions {
  supportedTextureExtensions?: readonly string[];
  /**
   * Resolvable `ShaderGraph` assets keyed by `ShaderGraph.id`, used by the
   * material-aware structural rules (sampler/variant cap, banned nodes,
   * per-particle-channel conflict — techspec §9). When a `render.material`
   * references a `shaderId` that is NOT present here it is treated as an
   * unresolvable material reference (a structural `missing-material` candidate);
   * the built-in Sprite Master (`sprite-master`) needs no graph because it is a
   * fixed-function shader that taps only its `MainTex`.
   */
  materialGraphs?: Readonly<Record<string, unknown>>;
}

const EFFECT_APP = "vfx-editor";
const EFFECT_KIND = "particle-effect";
const EFFECT_VERSION = 1;

// Derived from the engine's single source of truth so module support levels are
// changed in exactly one place (engine/particleModuleSettings.ts).
const PARTIAL_MODULES = new Set<ParticleEmitterModuleKey>(
  PARTIAL_PARTICLE_MODULE_KEYS,
);

const SUPPORTED_TEXTURE_SHEET_ANIMATION_FIELDS = new Set([
  "mode",
  "tiles",
  "startFrame",
  "endFrame",
  "frameOverTime",
  "cycles",
  "randomStartFrame",
]);

const NUMERIC_RULES: readonly NumericRule[] = [
  { suffix: "timeline.frameRate", min: 1, max: 240 },
  { suffix: "timeline.duration", min: 0.05, max: 100000 },
  { suffix: "timeline.loop.start", min: 0, max: 100000 },
  { suffix: "timeline.loop.end", min: 0, max: 100000 },
  { suffix: "timeline.start", min: 0, max: 100000 },
  { suffix: "maxParticles", min: 1, max: 4096 },
  { suffix: "duration", min: 0.05, max: 100000 },
  { suffix: "spawn.rate", min: 0, max: 3000 },
  { suffix: "spawn.rateOverDistance", min: 0, max: 1000 },
  { suffix: "spawn.radius", min: 0, max: 100000 },
  { suffix: "spawn.angle", min: 0, max: 90 },
  { suffix: "spawn.radiusThickness", min: 0, max: 1 },
  { suffix: "spawn.arc", min: 0, max: 360 },
  { suffix: "spawn.arcSpread", min: 0, max: 1 },
  { suffix: "spawn.length", min: 0, max: 48 },
  { suffix: "spawn.randomDirectionAmount", min: 0, max: 1 },
  { suffix: "spawn.sphericalDirectionAmount", min: 0, max: 1 },
  { suffix: "spawn.randomPositionAmount", min: 0, max: 24 },
  { suffix: "forces.gravity", min: -100000, max: 100000 },
  { suffix: "forces.drag", min: 0, max: 100000 },
  { suffix: "render.orderInLayer", min: -1024, max: 1024 },
  { suffix: "billboard.sizeStart", min: 0.001, max: 24 },
  { suffix: "billboard.sizeEnd", min: 0.001, max: 24 },
  { suffix: "billboard.softness", min: 0, max: 1 },
  { suffix: "mesh.sizeStart", min: 0.001, max: 24 },
  { suffix: "mesh.sizeEnd", min: 0.001, max: 24 },
  { suffix: "mesh.thickness", min: 0.02, max: 4 },
  { suffix: "editorMin", min: -100000, max: 100000 },
  { suffix: "editorMax", min: -100000, max: 100000 },
  { suffix: "value", min: -100000, max: 100000 },
  { suffix: "min", min: -100000, max: 100000 },
  { suffix: "max", min: -100000, max: 100000 },
  { suffix: "x", min: -100000, max: 100000 },
  { suffix: "y", min: -100000, max: 100000 },
  { suffix: "z", min: -100000, max: 100000 },
  { suffix: "slope", min: -1000, max: 1000 },
  { suffix: "position", min: 0, max: 1 },
  { suffix: "alpha", min: 0, max: 1 },
  { suffix: "blend", min: 0, max: 1 },
  { suffix: "dampen", min: 0, max: 1 },
  { suffix: "bounce", min: 0, max: 1 },
  { suffix: "probability", min: 0, max: 1 },
  { suffix: "cycles", min: 0, max: 32 },
  { suffix: "frequency", min: 0, max: 32 },
  { suffix: "octaves", min: 1, max: 6 },
  { suffix: "damping", min: 0, max: 1 },
];

interface NumericRule {
  suffix: string;
  min: number;
  max: number;
}

interface ValidationCollector {
  issues: VfxValidationIssue[];
  blockers: VfxExportBlocker[];
  pathsWithNumericIssues: Set<string>;
}

export function validateVfxAuthoringEffect(
  value: unknown,
  options: VfxAuthoringValidationOptions = {},
): VfxValidationResult {
  const collector: ValidationCollector = {
    issues: [],
    blockers: [],
    pathsWithNumericIssues: new Set(),
  };

  if (!isRecord(value)) {
    addIssue(
      collector,
      "error",
      "bad-kind",
      "$",
      "Particle effect must be a JSON object.",
    );
    return createVfxValidationResult(collector.issues, collector.blockers);
  }

  validateRawEffectEnvelope(value, collector);
  validateRequiredId(value.id, "id", "Effect id is required.", collector);
  validateRawNumbers(value, "", collector);

  const normalized = normalizeParticleEffect(value);
  const rawEmitters = Array.isArray(value.emitters) ? value.emitters : [];
  if ("emitters" in value && !Array.isArray(value.emitters)) {
    addIssue(
      collector,
      "error",
      "clamped-value",
      "emitters",
      "Effect emitters must be an array.",
    );
  }
  validateEmitterIds(rawEmitters, collector);
  validateEmitters(rawEmitters, normalized, options, collector);
  validateMaterialVariantCap(rawEmitters, options, collector);

  return createVfxValidationResult(collector.issues, collector.blockers);
}

export function createVfxValidationResult(
  issues: readonly VfxValidationIssue[] = [],
  blockers: readonly VfxExportBlocker[] = [],
): VfxValidationResult {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    valid: errors.length === 0 && blockers.length === 0,
    errors,
    warnings,
    blockers: [...blockers],
  };
}

export function mergeVfxValidationResults(
  results: readonly VfxValidationResult[],
): VfxValidationResult {
  const issues: VfxValidationIssue[] = [];
  const blockers: VfxExportBlocker[] = [];
  for (const result of results) {
    issues.push(...result.errors, ...result.warnings);
    blockers.push(...result.blockers);
  }
  return createVfxValidationResult(issues, blockers);
}

function validateRawEffectEnvelope(
  source: Record<string, unknown>,
  collector: ValidationCollector,
): void {
  if ("app" in source && source.app !== EFFECT_APP) {
    addIssue(
      collector,
      "error",
      "bad-kind",
      "app",
      `Effect app must be "${EFFECT_APP}".`,
    );
  }
  if ("kind" in source && source.kind !== EFFECT_KIND) {
    addIssue(
      collector,
      "error",
      "bad-kind",
      "kind",
      `Effect kind must be "${EFFECT_KIND}".`,
    );
  }
  if ("version" in source && source.version !== EFFECT_VERSION) {
    addIssue(
      collector,
      "error",
      "bad-version",
      "version",
      `Effect version must be ${EFFECT_VERSION}.`,
    );
  }
}

function validateEmitterIds(
  rawEmitters: readonly unknown[],
  collector: ValidationCollector,
): void {
  const seen = new Map<string, number>();
  rawEmitters.forEach((rawEmitter, emitterIndex) => {
    const path = `emitters.${emitterIndex}.id`;
    if (!isRecord(rawEmitter)) {
      addIssue(
        collector,
        "error",
        "clamped-value",
        `emitters.${emitterIndex}`,
        "Emitter must be a JSON object.",
      );
      return;
    }
    validateRequiredId(
      rawEmitter.id,
      path,
      "Emitter id is required.",
      collector,
    );
    const id = normalizeIdForComparison(rawEmitter.id);
    if (!id) return;
    const previousIndex = seen.get(id);
    if (previousIndex === undefined) {
      seen.set(id, emitterIndex);
      return;
    }
    addIssueAndBlocker(
      collector,
      "duplicate-id",
      path,
      `Emitter id duplicates emitters.${previousIndex}.id.`,
    );
  });
}

function validateEmitters(
  rawEmitters: readonly unknown[],
  normalized: ParticleEffectDefinition,
  options: VfxAuthoringValidationOptions,
  collector: ValidationCollector,
): void {
  normalized.emitters.forEach((emitter, emitterIndex) => {
    const rawEmitter = rawEmitters[emitterIndex];
    const rawEmitterRecord = isRecord(rawEmitter) ? rawEmitter : {};
    const path = `emitters.${emitterIndex}`;
    validateTextureRef(
      rawEmitterRecord,
      emitter,
      emitterIndex,
      options,
      collector,
    );
    validateMeshRef(rawEmitterRecord, emitter, emitterIndex, collector);
    validateCoreRuntimeSupport(rawEmitterRecord, emitter, path, collector);
    validateEmitterModuleSupport(rawEmitterRecord, emitter, path, collector);
    validateEmitterMaterial(emitter, emitterIndex, options, collector);
  });
}

function validateMeshRef(
  rawEmitter: Record<string, unknown>,
  emitter: ParticleEmitterDefinition,
  emitterIndex: number,
  collector: ValidationCollector,
): void {
  if (emitter.mode !== "mesh" || emitter.mesh.renderMode !== "meshAsset") {
    return;
  }
  const mesh = isRecord(rawEmitter.mesh) ? rawEmitter.mesh : null;
  const asset = isRecord(mesh?.asset) ? mesh.asset : null;
  if (!asset?.path) {
    addIssue(
      collector,
      "warning",
      "invalid-asset-ref",
      `emitters.${emitterIndex}.mesh.asset`,
      "Three mesh particles need a prepared mesh asset reference before export.",
    );
    return;
  }
  const validation = validateVfxMeshAssetPath(asset.path);
  if (validation.valid) return;
  addIssueAndBlocker(
    collector,
    "invalid-asset-ref",
    `emitters.${emitterIndex}.mesh.asset.path`,
    validation.message ?? "Mesh asset reference is invalid.",
  );
}

function validateTextureRef(
  rawEmitter: Record<string, unknown>,
  emitter: ParticleEmitterDefinition,
  emitterIndex: number,
  options: VfxAuthoringValidationOptions,
  collector: ValidationCollector,
): void {
  const render = isRecord(rawEmitter.render) ? rawEmitter.render : null;
  validateTextureValue(
    render?.texture,
    `emitters.${emitterIndex}.render.texture`,
    options,
    collector,
  );

  if (!emitter.modules.trails) return;
  const advanced = isRecord(rawEmitter.advanced) ? rawEmitter.advanced : null;
  const trails = isRecord(advanced?.trails) ? advanced.trails : null;
  validateTextureValue(
    trails?.texture,
    `emitters.${emitterIndex}.advanced.trails.texture`,
    options,
    collector,
  );
}

function validateTextureValue(
  value: unknown,
  path: string,
  options: VfxAuthoringValidationOptions,
  collector: ValidationCollector,
): void {
  if (value == null) return;
  if (typeof value === "string" && value.trim() === "") return;
  const validation = validateVfxTextureAssetPath(value, {
    supportedExtensions: options.supportedTextureExtensions,
  });
  if (validation.valid) return;
  addIssueAndBlocker(
    collector,
    "invalid-asset-ref",
    path,
    validation.message ?? "Texture asset reference is invalid.",
  );
}

function validateCoreRuntimeSupport(
  rawEmitter: Record<string, unknown>,
  emitter: ParticleEmitterDefinition,
  path: string,
  collector: ValidationCollector,
): void {
  if (emitter.mode === "mesh" && emitter.mesh.renderMode === "pixiShard") {
    addIssue(
      collector,
      "warning",
      "unsupported-module",
      `${path}.mode`,
      "Mesh mode exports as Pixi 2D shard geometry semantics, not true 3D mesh rendering.",
    );
  }

  validateDepthRenderFlags(rawEmitter, path, collector);
}

function validateEmitterModuleSupport(
  rawEmitter: Record<string, unknown>,
  emitter: ParticleEmitterDefinition,
  path: string,
  collector: ValidationCollector,
): void {
  for (const moduleKey of PARTICLE_EMITTER_MODULE_KEYS) {
    if (!emitter.modules[moduleKey]) continue;

    if (PARTIAL_MODULES.has(moduleKey)) {
      addIssue(
        collector,
        "warning",
        "unsupported-module",
        `${path}.modules.${moduleKey}`,
        `${moduleKey} has partial runtime export support; validate authored subfields before shipping.`,
      );
    }
  }

  if (emitter.modules.textureSheetAnimation) {
    validateTextureSheetAnimationFields(rawEmitter, path, collector);
  }

  if (
    emitter.modules.inheritVelocity &&
    emitter.advanced.inheritVelocity.mode === "current"
  ) {
    addIssueAndBlocker(
      collector,
      "unsupported-module",
      `${path}.advanced.inheritVelocity.mode`,
      "Inherit Velocity current mode is not implemented in runtime export yet.",
    );
  }
}

function validateDepthRenderFlags(
  rawEmitter: Record<string, unknown>,
  path: string,
  collector: ValidationCollector,
): void {
  const render = isRecord(rawEmitter.render) ? rawEmitter.render : null;
  if (!render) return;

  for (const key of ["depthTest", "depthWrite", "depthInk"] as const) {
    if (render[key] !== true) continue;
    addIssue(
      collector,
      "warning",
      "unsupported-module",
      `${path}.render.${key}`,
      `${key} exports as deterministic Pixi 2.5D draw-order/ink semantics, not GPU depth-buffer rendering.`,
    );
  }
}

function validateTextureSheetAnimationFields(
  rawEmitter: Record<string, unknown>,
  path: string,
  collector: ValidationCollector,
): void {
  const advanced = isRecord(rawEmitter.advanced) ? rawEmitter.advanced : null;
  const settings =
    advanced && isRecord(advanced.textureSheetAnimation)
      ? advanced.textureSheetAnimation
      : null;
  if (!settings) return;

  if ("mode" in settings && settings.mode !== "grid") {
    addIssueAndBlocker(
      collector,
      "unsupported-module",
      `${path}.advanced.textureSheetAnimation.mode`,
      "Texture sheet animation only supports uniform grid mode in runtime export.",
    );
  }

  for (const key of Object.keys(settings)) {
    if (SUPPORTED_TEXTURE_SHEET_ANIMATION_FIELDS.has(key)) continue;
    addIssueAndBlocker(
      collector,
      "unsupported-module",
      `${path}.advanced.textureSheetAnimation.${key}`,
      `Texture sheet animation field "${key}" is not implemented in runtime export yet.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Material validation (techspec §9, §12)
//
// These rules work STRUCTURALLY from the `ShaderGraph` + `MaterialInstance`
// shapes (frozen contract in `materials.ts` / `materialInstance.ts`). They do
// NOT import the graph compiler — a tiny local tier/feature analysis
// (`analyzeShaderGraphStructure`) walks the honored outputs and is sufficient
// to count sampler taps, detect banned nodes, decide Tier-2-ness, and detect
// per-particle-channel conflicts. Caps mirror the perf doctrine (§0, §6.4):
// ≤4 simultaneous samplers (design ≤3; uTexture+uRamp+uMask = 3 is the tight
// case) and ≤6 distinct Tier-2 programs across the effect.
// ---------------------------------------------------------------------------

/** The built-in fixed-function shader (no graph needed). */
const SPRITE_MASTER_VALIDATION_ID = "sprite-master";
/** Hard simultaneous sampler-tap ceiling; design target is ≤3 (§6.4). */
const MATERIAL_SAMPLER_CAP = 4;
/** Design sampler target — the uTexture+uRamp+uMask tight case (§6.4). */
const MATERIAL_SAMPLER_DESIGN = 3;
/** Soft Tier-2 program count across the effect (§0, §9). */
const MATERIAL_TIER2_VARIANT_SOFT_CAP = 6;
/** Hard Tier-2 program ceiling (§9, §10-P4). */
const MATERIAL_TIER2_VARIANT_HARD_CAP = 8;

/**
 * `[NA]` / deferred node types (techspec §4.2). When any of these feed an
 * honored output the material is data-only (Tier 3): a blocker because the
 * preview cannot render it (Custom-node injection is disallowed outright, §1.2).
 */
const MATERIAL_BANNED_NODE_TYPES = new Set<string>([
  // The only types in the §4.2 list that the frozen node-type union can
  // actually carry are scene/derivative-style ops; the union itself already
  // drops PBR/3D types (forward-compat). We additionally flag any node whose
  // `params.custom` HLSL/GLSL escape hatch is set (always disallowed, §9/Q9).
]);

interface ShaderGraphStructure {
  /** Distinct textureSample nodes reachable from honored outputs. */
  samplerTaps: number;
  /** Any reachable node reads the shared MainTex/fallback particle texture. */
  requiresMainTexture: boolean;
  /** Per-particle StaticSwitch usage feeding an honored output (banned, §9). */
  hasPerParticleStaticSwitch: boolean;
  /** Deferred/§4.2 node types reachable from honored outputs (paths). */
  bannedNodeTypes: string[];
  /** A per-particle `dynamicParameter` feed reaches an honored output. */
  hasPerParticleScalar: boolean;
  /**
   * A per-particle tint reaches the BaseColor output (a reachable
   * `particleColor` node — the per-particle 8-bit tint read, §3.1).
   */
  hasPerParticleTint: boolean;
  /** Tier 2 = needs a per-pixel-per-particle program (ParticleContainer shader or custom Mesh). */
  tier2: boolean;
  /**
   * A reachable `noise`/`vectorNoise` node opted into the expensive runtime
   * procedural path (`params.runtime === true`) instead of the default bake.
   */
  hasRuntimeNoise: boolean;
}

/**
 * Structurally analyze a `ShaderGraph`: walk back from the honored output slots
 * over edges/inputs, counting samplers and flagging deferred/banned/Tier-2
 * features. Cheap and side-effect-free; mirrors the frozen normalize shapes.
 */
function analyzeShaderGraphStructure(graph: ShaderGraph): ShaderGraphStructure {
  const nodeById = new Map<string, ShaderGraph["nodes"][number]>();
  for (const node of graph.nodes) nodeById.set(node.id, node);
  const edgeById = new Map<string, ShaderGraph["edges"][number]>();
  for (const edge of graph.edges) edgeById.set(edge.id, edge);

  const reachable = new Set<string>();
  const frontier: string[] = [];
  for (const slot of Object.values(graph.outputs)) {
    const node = resolveEdgeSourceNode(slot, edgeById);
    if (node) frontier.push(node);
  }
  while (frontier.length > 0) {
    const nodeId = frontier.pop() as string;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    const node = nodeById.get(nodeId);
    if (!node) continue;
    for (const edgeId of Object.values(node.inputs)) {
      const sourceNode = resolveEdgeSourceNode(edgeId, edgeById);
      if (sourceNode) frontier.push(sourceNode);
    }
  }

  // Per-particle param feeds: a declared `perParticle` float param OR a
  // reachable `dynamicParameter` node drives a per-particle scalar (§5).
  const hasPerParticleParam = graph.params.some(
    (param) => param.perParticle === true && param.type === "float",
  );
  const reachableNodes = [...reachable]
    .map((id) => nodeById.get(id))
    .filter((node): node is ShaderGraph["nodes"][number] => node !== undefined);
  const hasDynamicParameter = reachableNodes.some(
    (node) => node.type === "dynamicParameter",
  );
  const hasPerParticleScalar = hasDynamicParameter || hasPerParticleParam;
  // Per-particle tint = a reachable `particleColor` node feeds an honored output
  // (the per-particle 8-bit tint read, §3.1).
  const hasPerParticleTint = reachableNodes.some(
    (node) => node.type === "particleColor",
  );

  let samplerTaps = 0;
  let requiresMainTexture = false;
  let hasPerParticleStaticSwitch = false;
  let tier2 = false;
  let hasRuntimeNoise = false;
  const bannedNodeTypes: string[] = [];

  for (const node of reachableNodes) {
    if (
      node.type === "textureSample" ||
      node.type === "particleSubUV" ||
      node.type === "antialiasedTextureMask"
    ) {
      samplerTaps += 1;
      requiresMainTexture = true;
      // A SubUV *blend* (cross-fade) adds a second tap and a fragment mix.
      if (node.type === "particleSubUV" && node.params.blend === true) {
        samplerTaps += 1;
        tier2 = true;
      }
    }
    // Runtime procedural noise opts out of the default bake (expensive overdraw).
    if (
      (node.type === "noise" || node.type === "vectorNoise") &&
      node.params.runtime === true
    ) {
      hasRuntimeNoise = true;
      tier2 = true;
    }
    // Per-particle StaticSwitch is banned as a per-particle axis (§9): a
    // StaticSwitch node carrying `perParticle: true` is the banned shape.
    if (isStaticSwitchNode(node) && node.params.perParticle === true) {
      hasPerParticleStaticSwitch = true;
    }
    if (MATERIAL_BANNED_NODE_TYPES.has(node.type) || hasCustomEscape(node)) {
      bannedNodeTypes.push(node.type);
    }
    // Per-pixel fragment ops that cannot bake force Tier 2 (§4, §6.2). The
    // structural proxy: a fragment math node fed by a per-particle signal, or a
    // SubUV blend (already set above).
    if (isFragmentShaderNode(node) && hasPerParticleScalar) {
      tier2 = true;
    }
  }

  return {
    samplerTaps,
    requiresMainTexture,
    hasPerParticleStaticSwitch,
    bannedNodeTypes,
    hasPerParticleScalar,
    hasPerParticleTint,
    tier2,
    hasRuntimeNoise,
  };
}

function resolveEdgeSourceNode(
  edgeId: string | null | undefined,
  edgeById: Map<string, ShaderGraph["edges"][number]>,
): string | null {
  if (!edgeId) return null;
  const edge = edgeById.get(edgeId);
  return edge ? edge.source : null;
}

function isStaticSwitchNode(node: ShaderGraph["nodes"][number]): boolean {
  // StaticSwitch is not a distinct node-type in the frozen union; it is
  // expressed as a `step`/`lerp` selector carrying `params.staticSwitch`.
  return node.params.staticSwitch === true;
}

function hasCustomEscape(node: ShaderGraph["nodes"][number]): boolean {
  // No Custom HLSL/GLSL node ever (§1.2, Q9): any node smuggling raw shader
  // source via a `custom` param is disallowed.
  return typeof node.params.custom === "string" && node.params.custom !== "";
}

function isFragmentShaderNode(node: ShaderGraph["nodes"][number]): boolean {
  // Fragment-stage per-pixel ops that cannot bake when fed per-particle.
  return (
    node.type === "desaturate" ||
    node.type === "fresnel" ||
    node.type === "sphereMask" ||
    node.type === "step" ||
    node.type === "smoothstep"
  );
}

/** Tier-2 = needs a per-pixel-per-particle program (counted against the cap). */
function isStructurallyTier2(graph: ShaderGraph): boolean {
  return analyzeShaderGraphStructure(graph).tier2;
}

function normalizeMaterialInstanceValue(
  value: unknown,
): MaterialInstance | null {
  if (!isRecord(value)) return null;
  return value as unknown as MaterialInstance;
}

function resolveMaterialGraph(
  shaderId: string,
  options: VfxAuthoringValidationOptions,
): ShaderGraph | null {
  const graphs = options.materialGraphs;
  if (!graphs || !Object.prototype.hasOwnProperty.call(graphs, shaderId)) {
    return null;
  }
  return normalizeShaderGraph(graphs[shaderId]);
}

function validateEmitterMaterial(
  emitter: ParticleEmitterDefinition,
  emitterIndex: number,
  options: VfxAuthoringValidationOptions,
  collector: ValidationCollector,
): void {
  const material = emitter.render.material;
  if (!material) return;
  const path = `emitters.${emitterIndex}.render.material`;

  const hasMainTex = Boolean(material.mainTex && material.mainTex.path);
  const hasFallbackTexture = Boolean(
    emitter.render.texture && emitter.render.texture.trim(),
  );
  const hasSharedTexture = hasMainTex || hasFallbackTexture;

  // The built-in Sprite Master is fixed-function (no graph needed); structural
  // rules below only apply to graph-backed materials.
  const isSpriteMaster = material.shaderId === SPRITE_MASTER_VALIDATION_ID;
  const graph = resolveMaterialGraph(material.shaderId, options);
  const structure = graph ? analyzeShaderGraphStructure(graph) : null;
  // missing-MainTex / missing-material (blocker): only materials that actually
  // sample the shared MainTex/fallback texture need one. Procedural graphs such
  // as panned noise + gradient ramp + spherical opacity render without MainTex.
  const requiresMainTexture =
    isSpriteMaster ||
    (structure
      ? structure.requiresMainTexture
      : Boolean(options.materialGraphs));
  if (!hasSharedTexture && requiresMainTexture) {
    addIssueAndBlocker(
      collector,
      "missing-material",
      `${path}.mainTex`,
      "Material samples MainTex but has no resolvable MainTex and the emitter has no fallback render.texture; nothing renders (techspec §9).",
    );
  }

  if (!graph) {
    // A non-Sprite-Master material whose graph cannot be resolved is a missing
    // reference (blocker) — same severity as a missing asset (§9).
    if (!isSpriteMaster && options.materialGraphs) {
      addIssueAndBlocker(
        collector,
        "missing-material",
        path,
        `Material references shader "${material.shaderId}" but no such ShaderGraph asset resolves (techspec §9).`,
      );
    }
    return;
  }

  if (!structure) return;
  validateSamplerCap(structure, emitterIndex, collector);
  validateBannedNodes(structure, emitterIndex, collector);
  validateChannelConflict(structure, graph, emitterIndex, collector);
  validateRuntimeNoise(structure, emitterIndex, collector);
}

function validateRuntimeNoise(
  structure: ShaderGraphStructure,
  emitterIndex: number,
  collector: ValidationCollector,
): void {
  if (!structure.hasRuntimeNoise) return;
  addIssue(
    collector,
    "warning",
    "material-runtime-noise",
    `emitters.${emitterIndex}.render.material`,
    "Runtime Noise is expensive for particle overdraw; prefer the baked Noise texture (techspec §9; iteration 5b).",
  );
}

function validateSamplerCap(
  structure: ShaderGraphStructure,
  emitterIndex: number,
  collector: ValidationCollector,
): void {
  const path = `emitters.${emitterIndex}.render.material`;
  if (structure.samplerTaps > MATERIAL_SAMPLER_CAP) {
    // Over the hard ceiling → blocker.
    addIssueAndBlocker(
      collector,
      "material-sampler-cap",
      path,
      `Material taps ${structure.samplerTaps} textures simultaneously; the renderer allows at most ${MATERIAL_SAMPLER_CAP} (techspec §6.4, §9).`,
    );
    return;
  }
  if (structure.samplerTaps >= MATERIAL_SAMPLER_DESIGN) {
    // At/over the design target but under the hard cap → warning. The tight
    // uTexture+uRamp+uMask=3 case sits exactly at the design budget and so
    // leaves no sampler headroom (techspec §6.4 — flag it).
    addIssue(
      collector,
      "warning",
      "material-sampler-cap",
      path,
      `Material taps ${structure.samplerTaps} textures; the design budget is ${MATERIAL_SAMPLER_DESIGN} (uTexture+uRamp+uMask), leaving no sampler headroom (techspec §6.4).`,
    );
  }
}

function validateBannedNodes(
  structure: ShaderGraphStructure,
  emitterIndex: number,
  collector: ValidationCollector,
): void {
  const path = `emitters.${emitterIndex}.render.material`;
  if (structure.hasPerParticleStaticSwitch) {
    addIssueAndBlocker(
      collector,
      "material-banned-node",
      path,
      "Per-particle StaticSwitch is banned: a per-particle switch forks one program per particle (techspec §3.x, §9).",
    );
  }
  for (const nodeType of structure.bannedNodeTypes) {
    addIssueAndBlocker(
      collector,
      "material-banned-node",
      path,
      `Deferred/[NA] node "${nodeType}" feeds an honored output; it cannot render in an unlit 2D batch and is data-only (techspec §4.2, §9).`,
    );
  }
}

function validateChannelConflict(
  structure: ShaderGraphStructure,
  graph: ShaderGraph,
  emitterIndex: number,
  collector: ValidationCollector,
): void {
  const path = `emitters.${emitterIndex}.render.material`;
  // Per-particle tint AND a smuggled per-particle scalar both want the one
  // 8-bit `color` attribute (§3.1, §5.1). Reject UNLESS the material is Tier 2
  // (a custom Mesh can carry both via a dedicated attribute).
  if (structure.tier2) return;
  // Per-particle tint = a reachable `particleColor` node feeds an honored output
  // (the per-particle 8-bit tint read, §3.1). `perParticle` is float-only on the
  // param declaration (frozen normalize), so the tint signal is the node, not a
  // color param.
  const hasSmuggledScalar = graph.params.some(
    (param) =>
      param.type === "float" &&
      param.perParticle === true &&
      param.perParticleFeed === "smuggle-8bit",
  );
  if (structure.hasPerParticleTint && hasSmuggledScalar) {
    addIssueAndBlocker(
      collector,
      "material-channel-conflict",
      path,
      "Per-particle tint and a smuggled per-particle scalar both need the one 8-bit color attribute; there is no spare channel (Tier-2 custom Mesh required) — techspec §3.1, §5.1, §9.",
    );
  }
}

function validateMaterialVariantCap(
  rawEmitters: readonly unknown[],
  options: VfxAuthoringValidationOptions,
  collector: ValidationCollector,
): void {
  if (!options.materialGraphs) return;
  // Count distinct Tier-2 programs across the whole effect (one per Tier-2
  // shaderId — Tier 0/1 collapse to the free `sprite-master` axis, §6.5).
  const tier2ShaderIds = new Set<string>();
  for (const rawEmitter of rawEmitters) {
    if (!isRecord(rawEmitter)) continue;
    const render = isRecord(rawEmitter.render) ? rawEmitter.render : null;
    const material = normalizeMaterialInstanceValue(render?.material);
    if (!material || typeof material.shaderId !== "string") continue;
    const graph = resolveMaterialGraph(material.shaderId, options);
    if (!graph) continue;
    if (isStructurallyTier2(graph)) tier2ShaderIds.add(material.shaderId);
  }
  const count = tier2ShaderIds.size;
  if (count > MATERIAL_TIER2_VARIANT_HARD_CAP) {
    addIssueAndBlocker(
      collector,
      "material-variant-cap",
      "$",
      `Effect compiles ${count} distinct Tier-2 material programs; the hard ceiling is ${MATERIAL_TIER2_VARIANT_HARD_CAP} (techspec §9, §10-P4).`,
    );
  } else if (count > MATERIAL_TIER2_VARIANT_SOFT_CAP) {
    addIssue(
      collector,
      "warning",
      "material-variant-cap",
      "$",
      `Effect compiles ${count} distinct Tier-2 material programs; the design cap is ${MATERIAL_TIER2_VARIANT_SOFT_CAP} (techspec §9).`,
    );
  }
}

function validateRequiredId(
  value: unknown,
  path: string,
  message: string,
  collector: ValidationCollector,
): void {
  if (typeof value === "string" && value.trim()) return;
  addIssueAndBlocker(collector, "missing-id", path, message);
}

function validateRawNumbers(
  value: unknown,
  path: string,
  collector: ValidationCollector,
): void {
  if (typeof value === "number") {
    validateNumber(value, path, collector);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateRawNumbers(
        item,
        path ? `${path}.${index}` : `${index}`,
        collector,
      );
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    validateRawNumbers(item, path ? `${path}.${key}` : key, collector);
  }
}

function validateNumber(
  value: number,
  path: string,
  collector: ValidationCollector,
): void {
  if (!Number.isFinite(value)) {
    addNumericIssue(
      collector,
      path,
      "Numeric authoring values must be finite.",
    );
    return;
  }

  const rule = numericRuleForPath(path);
  if (!rule) return;
  if (value < rule.min || value > rule.max) {
    addNumericIssue(
      collector,
      path,
      `Numeric authoring value will be clamped to ${rule.min}..${rule.max}.`,
    );
  }
}

function numericRuleForPath(path: string): NumericRule | undefined {
  if (path.includes(".initializeParticle.color.intensity.")) {
    if (
      path.endsWith(".value") ||
      path.endsWith(".min") ||
      path.endsWith(".max") ||
      path.endsWith(".editorMin") ||
      path.endsWith(".editorMax") ||
      path.endsWith(".y")
    ) {
      return {
        suffix: path.slice(path.lastIndexOf(".") + 1),
        min: 0,
        max: PARTICLE_HDR_COLOR_INTENSITY_VALUE_LIMIT,
      };
    }
  }
  return NUMERIC_RULES.find((item) => path.endsWith(item.suffix));
}

function addNumericIssue(
  collector: ValidationCollector,
  path: string,
  message: string,
): void {
  if (collector.pathsWithNumericIssues.has(path)) return;
  collector.pathsWithNumericIssues.add(path);
  addIssue(collector, "warning", "clamped-value", path, message);
}

function addIssueAndBlocker(
  collector: ValidationCollector,
  code: VfxValidationIssueCode,
  path: string,
  message: string,
): void {
  addIssue(collector, "error", code, path, message);
  collector.blockers.push({ code, path, message });
}

function addIssue(
  collector: ValidationCollector,
  severity: VfxValidationSeverity,
  code: VfxValidationIssueCode,
  path: string,
  message: string,
): void {
  collector.issues.push({ severity, code, path, message });
}

function normalizeIdForComparison(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
