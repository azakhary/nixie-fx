import { numberOr } from "../../engine/particleModuleSettingUtils";
import type { Vec4 } from "../../engine/math";
import type { MaterialArtifact, MaterialFixedDescriptor } from "./artifact";
import {
  resolveMaterialParamValue,
  resolveMaterialTextureNodeBinding,
  type MaterialEdge,
  type MaterialInstance,
  type MaterialNode,
  type ShaderGraph,
} from "../schema/materials";
import { MATERIAL_FRAGMENT_HEADER } from "./materialFragmentPrelude";

export interface MaterialSamplerBinding {
  nodeId: string;
  uniform: string;
  path: string;
}

export const MATERIAL_MAX_NODE_SAMPLERS = 7;

export function canRenderTier2ParticleContainerShader(
  artifact: MaterialArtifact,
): boolean {
  if (artifact.tier !== "tier2-shader") return false;
  return !artifact.diagnostics.some((message) =>
    message.includes("custom Mesh path required"),
  );
}

export function tier2ParticleSamplerDeferralDiagnostics(
  graph: ShaderGraph,
  instance: MaterialInstance,
): string[] {
  const compiler = new MaterialGlslCompiler(graph, instance);
  const samplers = compiler.samplerBindings();
  const messages = [...compiler.samplerDiagnostics()];
  if (samplers.length > 0) {
    messages.push(
      "Per-node material textures are not yet bound on particles; they fall back to the emitter MainTex.",
    );
  }
  return messages;
}
export interface CompiledMaterialFragment {
  fragment: string;
  /** Per-node texture samplers the source reads (empty when none). */
  samplers: MaterialSamplerBinding[];
  /** Diagnostics (e.g. the per-material sampler cap was exceeded). */
  diagnostics: string[];
}

export function createMaterialPreviewFragmentSource({
  artifact,
  graph,
  instance,
}: {
  artifact: MaterialArtifact;
  graph: ShaderGraph;
  instance: MaterialInstance;
}): string | null {
  if (artifact.tier === "tier3-defer") return null;
  return new MaterialGlslCompiler(graph, instance).fragmentSource(
    artifact.fixed,
  );
}

/**
 * Compile the material preview fragment AND expose its per-node sampler list so
 * the GPU host can bind a texture per unit (M4). The sampler list is empty for
 * every graph that uses no per-node `params.tex` (and no wired texture param),
 * preserving the single-`uTexture` MainTex contract byte-for-byte.
 */
export function createMaterialPreviewFragment({
  artifact,
  graph,
  instance,
}: {
  artifact: MaterialArtifact;
  graph: ShaderGraph;
  instance: MaterialInstance;
}): CompiledMaterialFragment | null {
  if (artifact.tier === "tier3-defer") return null;
  const compiler = new MaterialGlslCompiler(graph, instance);
  const fragment = compiler.fragmentSource(artifact.fixed);
  return {
    fragment,
    samplers: compiler.samplerBindings(),
    diagnostics: compiler.samplerDiagnostics(),
  };
}

export function createMaterialNodePreviewFragmentSource({
  graph,
  instance,
  nodeId,
  sourceHandle = "out",
}: {
  graph: ShaderGraph;
  instance: MaterialInstance;
  nodeId: string;
  sourceHandle?: string;
}): string | null {
  return new MaterialGlslCompiler(graph, instance).nodePreviewFragmentSource(
    nodeId,
    sourceHandle,
  );
}

/**
 * Compile a single-node preview fragment AND expose the per-node sampler list it
 * references, so the node-preview host can bind that node's own texture (M4).
 */
export function createMaterialNodePreviewFragment({
  graph,
  instance,
  nodeId,
  sourceHandle = "out",
}: {
  graph: ShaderGraph;
  instance: MaterialInstance;
  nodeId: string;
  sourceHandle?: string;
}): CompiledMaterialFragment | null {
  const compiler = new MaterialGlslCompiler(graph, instance);
  const fragment = compiler.nodePreviewFragmentSource(nodeId, sourceHandle);
  if (fragment === null) return null;
  return {
    fragment,
    samplers: compiler.samplerBindings(),
    diagnostics: compiler.samplerDiagnostics(),
  };
}

class MaterialGlslCompiler {
  private readonly nodeById = new Map<string, MaterialNode>();
  private readonly edgeById = new Map<string, MaterialEdge>();
  /** node id -> per-node sampler uniform name (only nodes with a resolved tex). */
  private readonly nodeSamplerUniform = new Map<string, string>();
  /** Ordered per-node sampler bindings (node id -> uniform -> asset path). */
  private readonly samplers: MaterialSamplerBinding[] = [];
  private readonly samplerDiagnosticMessages: string[] = [];

  constructor(
    private readonly graph: ShaderGraph,
    private readonly instance: MaterialInstance,
  ) {
    for (const node of graph.nodes) this.nodeById.set(node.id, node);
    for (const edge of graph.edges) this.edgeById.set(edge.id, edge);
    this.collectSamplers();
  }

  /** The per-node sampler bindings emitted (empty for no-texture-param graphs). */
  samplerBindings(): MaterialSamplerBinding[] {
    return this.samplers.map((s) => ({ ...s }));
  }

  /** Diagnostics raised while collecting samplers (e.g. the cap was exceeded). */
  samplerDiagnostics(): string[] {
    return [...this.samplerDiagnosticMessages];
  }

  /**
   * Pre-scan every texture-reading node (textureSample / particleSubUV /
   * antialiasedTextureMask) and assign a DETERMINISTIC sampler uniform name to
   * each one whose resolved texture path is non-empty. Determinism (sort by node
   * id) keeps the generated shader stable across graph array re-orderings so the
   * host's shader cache stays warm. Nodes with an EMPTY path get no entry and
   * fall back to `materialSampleMain` / `uTexture` (the documented contract).
   */
  private collectSamplers(): void {
    const candidates = this.graph.nodes
      .filter(
        (n) =>
          n.type === "textureSample" ||
          n.type === "particleSubUV" ||
          n.type === "antialiasedTextureMask",
      )
      .filter((n) => {
        const binding = this.resolveNodeTexBinding(n);
        return binding.path !== "" && !binding.isMainTex;
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let index = 0;
    for (const node of candidates) {
      if (index >= MATERIAL_MAX_NODE_SAMPLERS) {
        this.samplerDiagnosticMessages.push(
          `Material uses more than ${MATERIAL_MAX_NODE_SAMPLERS} per-node textures; node "${node.id}" falls back to MainTex.`,
        );
        continue;
      }
      const uniform = `uTex${index}`;
      index += 1;
      this.nodeSamplerUniform.set(node.id, uniform);
      this.samplers.push({
        nodeId: node.id,
        uniform,
        path: this.resolveNodeTexBinding(node).path,
      });
    }
  }

  /**
   * The asset path a texture-reading node samples: a wired `tex` input (a
   * texture-typed Parameter, M3 Phase-1) wins over the node's own `params.tex`.
   * Returns "" when the node reads no specific texture (→ MainTex fallback).
   */
  private resolveNodeTexBinding(
    node: MaterialNode,
  ): ReturnType<typeof resolveMaterialTextureNodeBinding> {
    return resolveMaterialTextureNodeBinding(
      this.graph,
      this.instance,
      node,
      this.nodeById,
      this.edgeById,
    );
  }

  /** The sampler-uniform header lines for the emitted per-node samplers. */
  private samplerUniformDeclarations(): string {
    if (this.samplers.length === 0) return "";
    return `${this.samplers.map((s) => `uniform sampler2D ${s.uniform};`).join("\n")}\n`;
  }

  fragmentSource(fixed: MaterialFixedDescriptor | undefined): string {
    const base = this.slotExpr("baseColor");
    const emissive = this.slotExpr("emissive");
    const opacity = this.slotScalarExpr("opacity");
    const opacityMask = this.slotExpr("opacityMask");
    const hasBase = base !== null;
    const hasEmissive = emissive !== null;
    const baseExpr = base ?? "materialSampleMain(vUV)";
    const emissiveExpr = emissive ?? "vec4(0.0)";
    const alphaExpr =
      opacity ??
      (hasBase
        ? `(${baseExpr}).a`
        : hasEmissive
          ? `materialLuminance((${emissiveExpr}).rgb)`
          : "materialSampleMain(vUV).a");
    const maskExpr = opacityMask ?? "vec4(1.0)";
    const emissiveScale = fixed ? "uFixedEmissive" : "0.0";

    // Opaque ignores opacity/opacityMask entirely: no discard, alpha forced to
    // 1 in the output encode (I12-G).
    if (this.graph.blend === "opaque") {
      return `${MATERIAL_FRAGMENT_HEADER}${this.samplerUniformDeclarations()}
void main(void) {
  vec4 baseColor = ${baseExpr};
  vec4 emissiveColor = ${emissiveExpr};
  vec4 outColor = baseColor;
  outColor.rgb = outColor.rgb * uFixedTint.rgb + emissiveColor.rgb;
  outColor.rgb *= (1.0 + max(0.0, ${emissiveScale}));
  outColor *= vColor;
  outColor.a = 1.0;
  gl_FragColor = outColor;
}
`;
    }

    // Masked always clips; an unwired mask falls back to thresholding the
    // computed opacity (I12-G). Other blends keep the wired-mask-only clip
    // (a vec4(1.0) mask never fires) byte-identical to before.
    const maskValueExpr =
      this.graph.blend === "masked" && opacityMask === null
        ? "opacityValue"
        : `(${maskExpr}).r`;
    // Masked pixels that survive the clip write fully-opaque alpha, mirroring
    // the opaque encode above: the mask gates draw/no-draw, so surviving
    // pixels never alpha-blend soft fringes (I12-G). Other blends keep the
    // soft alpha encode byte-identical to before.
    const alphaEncode =
      this.graph.blend === "masked"
        ? `outColor *= vColor;
  outColor.a = 1.0;`
        : `outColor.a = opacityValue * uFixedTint.a * uFixedOpacity;
  outColor *= vColor;`;

    return `${MATERIAL_FRAGMENT_HEADER}${this.samplerUniformDeclarations()}
void main(void) {
  vec4 baseColor = ${baseExpr};
  vec4 emissiveColor = ${emissiveExpr};
  float opacityValue = clamp((${alphaExpr}), 0.0, 1.0);
  float maskValue = ${maskValueExpr};
  if (maskValue < uClipValue) discard;
  vec4 outColor = baseColor;
  outColor.rgb = outColor.rgb * uFixedTint.rgb + emissiveColor.rgb;
  outColor.rgb *= (1.0 + max(0.0, ${emissiveScale}));
  ${alphaEncode}
  gl_FragColor = outColor;
}
`;
  }

  nodePreviewFragmentSource(
    nodeId: string,
    sourceHandle = "out",
  ): string | null {
    const node = this.nodeById.get(nodeId);
    if (!node) return null;
    const valueExpr = this.evalNode(node, new Set());
    const selectedExpr = this.select(
      valueExpr,
      resolveNodePreviewSourceHandle(node, sourceHandle),
    );
    return `${MATERIAL_FRAGMENT_HEADER}${this.samplerUniformDeclarations()}
void main(void) {
  vec4 value = ${selectedExpr};
  gl_FragColor = vec4(clamp(value.rgb, 0.0, 1.0), clamp(value.a, 0.0, 1.0));
}
`;
  }

  private slotExpr(slot: keyof ShaderGraph["outputs"]): string | null {
    const edgeId = this.graph.outputs[slot];
    if (!edgeId) return null;
    const edge = this.edgeById.get(edgeId);
    const node = edge ? this.nodeById.get(edge.source) : undefined;
    if (!edge || !node) return null;
    return this.select(this.evalNode(node, new Set()), edge.sourceHandle);
  }

  private slotScalarExpr(slot: keyof ShaderGraph["outputs"]): string | null {
    const expr = this.slotExpr(slot);
    return expr ? `((${expr}).r)` : null;
  }

  private evalNode(node: MaterialNode, visiting: Set<string>): string {
    if (visiting.has(node.id)) return "vec4(0.0)";
    visiting.add(node.id);
    const out = this.evalInner(node, visiting);
    visiting.delete(node.id);
    return out;
  }

  private evalInner(node: MaterialNode, visiting: Set<string>): string {
    const p = node.params;
    const input = (pin: string, fallback: string): string => {
      const edgeId = node.inputs[pin];
      if (!edgeId) return fallback;
      const edge = this.edgeById.get(edgeId);
      const source = edge ? this.nodeById.get(edge.source) : undefined;
      if (!edge || !source) return fallback;
      return this.select(this.evalNode(source, visiting), edge.sourceHandle);
    };
    const inputScalar = (pin: string, fallback: number): string =>
      `(${input(pin, this.scalar(fallback))}).r`;
    const inputUv = (): string =>
      node.inputs.uv ? `(${input("uv", "vec4(vUV, 0.0, 0.0)")}).xy` : "vUV";

    switch (node.type) {
      case "constant":
        return this.constVec4(p.value);
      case "time":
        return "vec4(uTime)";
      case "param": {
        const name = typeof p.name === "string" ? p.name : "";
        return this.constVec4(
          resolveMaterialParamValue(this.graph, this.instance, name),
        );
      }
      case "textureSample":
        return this.sampleTexture(node, inputUv());
      case "particleSubUV": {
        const uniform = this.nodeSamplerUniform.get(node.id);
        if (uniform) {
          // A node-picked texture overrides MainTex; the SubUV frame-blend stays
          // on the MainTex path (deferred), so sample the picked texture directly.
          return `texture2D(${uniform}, fract(${inputUv()}))`;
        }
        return p.blend === true
          ? `materialSampleSubUvBlend(${inputUv()})`
          : `materialSampleMain(${inputUv()})`;
      }
      case "uv":
        return "vec4(vUV, 0.0, 0.0)";
      case "tilingOffset": {
        const uv = input("uv", "vec4(vUV, 0.0, 0.0)");
        const tile = this.constVec4(p.tile, [1, 1, 0, 0]);
        const offset = this.constVec4(p.offset);
        return `vec4((${uv}).xy * max((${tile}).xy, vec2(0.000001)) + (${offset}).xy, 0.0, 0.0)`;
      }
      case "panner": {
        const uv = input("uv", "vec4(vUV, 0.0, 0.0)");
        const t = node.inputs.time ? inputScalar("time", 0) : "uTime";
        const speed = this.constVec4(p.speed);
        return `vec4((${uv}).xy + (${t}) * (${speed}).xy, 0.0, 0.0)`;
      }
      case "rotateUV": {
        const uv = input("uv", "vec4(vUV, 0.0, 0.0)");
        const center = this.constVec4(p.center, [0.5, 0.5, 0, 0]);
        const speed = this.number(p.speed, 0);
        return `(vec4(((${center}).xy) + mat2(cos(${speed.toFixed(8)} * uTime * 6.2831853), sin(${speed.toFixed(8)} * uTime * 6.2831853), -sin(${speed.toFixed(8)} * uTime * 6.2831853), cos(${speed.toFixed(8)} * uTime * 6.2831853)) * ((${uv}).xy - (${center}).xy), 0.0, 0.0))`;
      }
      case "fresnel": {
        const center = this.constVec4(p.center, [0.5, 0.5, 0, 0]);
        const power = Math.max(0, this.number(p.power, 1));
        return `vec4(pow(max(0.0, 1.0 - clamp(length(vUV - (${center}).xy) * 2.0, 0.0, 1.0)), ${power.toFixed(8)}))`;
      }
      case "sphereMask": {
        const center = this.constVec4(p.center, [0.5, 0.5, 0, 0]);
        const radius = Math.max(0.0001, this.number(p.radius, 0.5));
        const hardness = Math.max(0, Math.min(1, this.number(p.hardness, 0.5)));
        const edge = radius * (1 - hardness) + 0.0001;
        return `vec4(clamp(1.0 - ((length(vUV - (${center}).xy) - ${(radius - edge).toFixed(8)}) / ${edge.toFixed(8)}), 0.0, 1.0))`;
      }
      case "particleColor":
        return "vColor";
      case "particleRelativeTime":
        return "vec4(clamp(vColor.a, 0.0, 1.0))";
      case "particleRandom":
        return "vec4(fract(vColor.r + vColor.g * 13.17 + vColor.b * 7.31))";
      case "particleSpeed":
      case "particleSize":
      case "particleDirection":
      case "particlePosition":
      case "particleMacroUV":
        return "vec4(0.0)";
      case "dynamicParameter":
        return "uDynamicParams";
      case "multiply":
        return `((${input("a", "vec4(1.0)")}) * (${input("b", "vec4(1.0)")}))`;
      case "add":
        return `((${input("a", "vec4(0.0)")}) + (${input("b", "vec4(0.0)")}))`;
      case "subtract":
        return `((${input("a", "vec4(0.0)")}) - (${input("b", "vec4(0.0)")}))`;
      case "divide":
        return `((${input("a", "vec4(0.0)")}) / max(abs(${input("b", "vec4(1.0)")}), vec4(0.000001)))`;
      case "min":
        return `min(${input("a", "vec4(0.0)")}, ${input("b", "vec4(0.0)")})`;
      case "max":
        return `max(${input("a", "vec4(0.0)")}, ${input("b", "vec4(0.0)")})`;
      case "lerp": {
        const t = node.inputs.t
          ? input("t", "vec4(0.5)")
          : this.scalar(this.number(p.t, 0.5));
        return `mix(${input("a", "vec4(0.0)")}, ${input("b", "vec4(1.0)")}, ${t})`;
      }
      case "oneMinus":
        return `(vec4(1.0) - (${input("in", "vec4(0.0)")}))`;
      case "clamp": {
        const lo = node.inputs.min
          ? inputScalar("min", 0)
          : this.number(p.min, 0).toFixed(8);
        const hi = node.inputs.max
          ? inputScalar("max", 1)
          : this.number(p.max, 1).toFixed(8);
        return `clamp(${input("in", "vec4(0.0)")}, vec4(${lo}), vec4(${hi}))`;
      }
      case "step": {
        const edge = node.inputs.edge
          ? inputScalar("edge", 0.5)
          : this.number(p.edge, 0.5).toFixed(8);
        return `step(vec4(${edge}), ${input("in", "vec4(0.0)")})`;
      }
      case "smoothstep": {
        const e0 = node.inputs.edge0
          ? inputScalar("edge0", 0)
          : this.number(p.edge0, 0).toFixed(8);
        const e1 = node.inputs.edge1
          ? inputScalar("edge1", 1)
          : this.number(p.edge1, 1).toFixed(8);
        return `smoothstep(vec4(${e0}), vec4(${e1}), ${input("in", "vec4(0.0)")})`;
      }
      case "power": {
        const exp = node.inputs.exp
          ? input("exp", "vec4(1.0)")
          : this.scalar(this.number(p.exponent, 1));
        return `pow(max(${input("in", "vec4(0.0)")}, vec4(0.0)), ${exp})`;
      }
      case "remap": {
        const v = input("in", "vec4(0.0)");
        const inMin = node.inputs.inMin
          ? inputScalar("inMin", 0)
          : this.number(p.inMin, 0).toFixed(8);
        const inMax = node.inputs.inMax
          ? inputScalar("inMax", 1)
          : this.number(p.inMax, 1).toFixed(8);
        const outMin = node.inputs.outMin
          ? inputScalar("outMin", 0)
          : this.number(p.outMin, 0).toFixed(8);
        const outMax = node.inputs.outMax
          ? inputScalar("outMax", 1)
          : this.number(p.outMax, 1).toFixed(8);
        return `(vec4(${outMin}) + (((${v}) - vec4(${inMin})) / max(vec4(${inMax}) - vec4(${inMin}), vec4(0.000001))) * (vec4(${outMax}) - vec4(${outMin})))`;
      }
      case "desaturate": {
        const v = input("in", "vec4(0.0)");
        const fraction = Math.max(0, Math.min(1, this.number(p.fraction, 1)));
        return `vec4(mix((${v}).rgb, vec3(materialLuminance((${v}).rgb)), ${fraction.toFixed(8)}), (${v}).a)`;
      }
      case "split": {
        const channel = this.channel(p.channel);
        return `((${input("in", "vec4(0.0)")}).${channel}${channel}${channel}${channel})`;
      }
      case "combine":
        return `vec4((${input("r", "vec4(0.0)")}).r, (${input("g", "vec4(0.0)")}).r, (${input("b", "vec4(0.0)")}).r, (${node.inputs.a ? input("a", "vec4(1.0)") : "vec4(1.0)"}).r)`;
      case "swizzle": {
        const pattern = String(p.pattern ?? "rgba")
          .toLowerCase()
          .replace(/[^rgba]/g, "")
          .padEnd(4, "a")
          .slice(0, 4);
        return `((${input("in", "vec4(0.0)")}).${pattern})`;
      }
      case "abs":
        return `abs(${input("in", "vec4(0.0)")})`;
      case "frac":
        return `fract(${input("in", "vec4(0.0)")})`;
      case "floor":
        return `floor(${input("in", "vec4(0.0)")})`;
      case "ceil":
        return `ceil(${input("in", "vec4(0.0)")})`;
      case "round":
        return `floor(${input("in", "vec4(0.0)")} + vec4(0.5))`;
      case "sign":
        return `sign(${input("in", "vec4(0.0)")})`;
      case "sqrt":
        return `sqrt(max(${input("in", "vec4(0.0)")}, vec4(0.0)))`;
      case "length":
        return `vec4(length((${input("in", "vec4(0.0)")}).xyz))`;
      case "normalize":
        return `vec4(normalize((${input("in", "vec4(0.0)")}).xyz), (${input("in", "vec4(0.0)")}).a)`;
      case "dot":
        return `vec4(dot((${input("a", "vec4(0.0)")}).xyz, (${input("b", "vec4(0.0)")}).xyz))`;
      case "sine": {
        const period = Math.max(0.0001, this.number(p.period, 1));
        return `sin((${input("in", "vec4(0.0)")}) * ${((Math.PI * 2) / period).toFixed(8)})`;
      }
      case "cosine": {
        const period = Math.max(0.0001, this.number(p.period, 1));
        return `cos((${input("in", "vec4(0.0)")}) * ${((Math.PI * 2) / period).toFixed(8)})`;
      }
      case "if": {
        const a = inputScalar("a", 0);
        const b = inputScalar("b", 0);
        return `((${a}) > (${b}) + 0.000001 ? ${input("aGreater", "vec4(0.0)")} : ((${a}) < (${b}) - 0.000001 ? ${input("aLess", "vec4(0.0)")} : ${input("aEqual", input("aGreater", "vec4(0.0)"))}))`;
      }
      case "noise": {
        const pos = input("Position", "vec4(vUV, 0.0, 0.0)");
        const scale = Math.max(0.0001, this.number(p.scale, 16));
        const seed = this.number(p.seed, 0);
        const outMin = this.number(p.outputMin, 0);
        const outMax = this.number(p.outputMax, 1);
        const mode =
          p.function === "value" ? 1 : p.function === "voronoi" ? 2 : 0;
        return `vec4(materialScalarNoise((${pos}).xy, ${scale.toFixed(8)}, ${seed.toFixed(8)}, ${outMin.toFixed(8)}, ${outMax.toFixed(8)}, ${mode.toFixed(1)}))`;
      }
      case "vectorNoise": {
        const pos = input("Position", "vec4(vUV, 0.0, 0.0)");
        const scale = Math.max(0.0001, this.number(p.scale, 8));
        const seed = this.number(p.seed, 0);
        const mode =
          p.function === "cellnoise" ? 1 : p.function === "voronoi" ? 2 : 0;
        return `vec4(materialScalarNoise((${pos}).xy + vec2(17.0, 31.0), ${scale.toFixed(8)}, ${seed.toFixed(8)}, 0.0, 1.0, ${mode.toFixed(1)}), materialScalarNoise((${pos}).xy + vec2(73.0, 11.0), ${scale.toFixed(8)}, ${(seed + 1).toFixed(8)}, 0.0, 1.0, ${mode.toFixed(1)}), materialScalarNoise((${pos}).xy + vec2(5.0, 47.0), ${scale.toFixed(8)}, ${(seed + 2).toFixed(8)}, 0.0, 1.0, ${mode.toFixed(1)}), 1.0)`;
      }
      case "antialiasedTextureMask": {
        const sample = this.sampleTexture(node, inputUv());
        const ch = this.channel(p.channel ?? "a");
        const threshold = node.inputs.Threshold
          ? inputScalar("Threshold", 0.5)
          : this.number(p.threshold, 0.5).toFixed(8);
        const softness = Math.max(0.0001, this.number(p.softness, 0.04));
        return `vec4(smoothstep((${threshold}) - ${softness.toFixed(8)}, (${threshold}) + ${softness.toFixed(8)}, (${sample}).${ch}))`;
      }
      case "sphericalParticleOpacity": {
        const center = this.constVec4(p.center, [0.5, 0.5, 0, 0]);
        const radius = Math.max(0.0001, this.number(p.radius, 0.5));
        const density = node.inputs.Density
          ? inputScalar("Density", 1)
          : this.number(p.density, 1).toFixed(8);
        return `vec4(clamp(pow(max(0.0, 1.0 - length((vUV - (${center}).xy) / ${radius.toFixed(8)})), ${density}), 0.0, 1.0))`;
      }
      case "gradientRamp": {
        const t = node.inputs.t ? inputScalar("t", 0) : "vUV.x";
        return this.gradientExpr(p.stops, t);
      }
      default:
        return "materialSampleMain(vUV)";
    }
  }

  /**
   * Sample a texture-reading node: read the node's own assigned sampler uniform
   * (`uTexN`) when it has a non-empty resolved texture, else fall back to the
   * implicit MainTex (`materialSampleMain`). Mirrors the software evaluator's
   * "prefer the node's own texture over MainTex" rule (previewEval.ts).
   */
  private sampleTexture(node: MaterialNode, uvExpr: string): string {
    const uniform = this.nodeSamplerUniform.get(node.id);
    if (uniform) return `texture2D(${uniform}, fract(${uvExpr}))`;
    return `materialSampleMain(${uvExpr})`;
  }

  private select(expr: string, handle: string): string {
    switch (handle) {
      case "R":
      case "Param1":
        return `((${expr}).rrrr)`;
      case "G":
      case "Param2":
        return `((${expr}).gggg)`;
      case "B":
      case "Param3":
        return `((${expr}).bbbb)`;
      case "A":
      case "Param4":
        return `((${expr}).aaaa)`;
      default:
        return `(${expr})`;
    }
  }

  private constVec4(value: unknown, fallback: Vec4 = [0, 0, 0, 0]): string {
    const v = toVec4(value, fallback);
    return `vec4(${v.map((n) => this.number(n, 0).toFixed(8)).join(", ")})`;
  }

  private scalar(value: number): string {
    return `vec4(${this.number(value, 0).toFixed(8)})`;
  }

  private number(value: unknown, fallback: number): number {
    return numberOr(value, fallback);
  }

  private channel(value: unknown): string {
    const ch = typeof value === "string" ? value.toLowerCase() : "r";
    return ch === "g" || ch === "b" || ch === "a" ? ch : "r";
  }

  private gradientExpr(rawStops: unknown, t: string): string {
    const stops = (Array.isArray(rawStops) ? rawStops : [])
      .map((entry) => {
        const rec =
          typeof entry === "object" && entry !== null
            ? (entry as Record<string, unknown>)
            : {};
        return {
          position: Math.max(0, Math.min(1, this.number(rec.position, 0))),
          color: toVec4(rec.color, [1, 1, 1, 1]),
        };
      })
      .sort((a, b) => a.position - b.position);
    if (stops.length === 0) return `vec4(${t})`;
    let expr = this.constVec4(stops[0]!.color);
    for (let i = 1; i < stops.length; i++) {
      const prev = stops[i - 1]!;
      const curr = stops[i]!;
      const span = Math.max(0.0001, curr.position - prev.position);
      const f = `clamp(((${t}) - ${prev.position.toFixed(8)}) / ${span.toFixed(8)}, 0.0, 1.0)`;
      expr = `mix(${expr}, ${this.constVec4(curr.color)}, ${f})`;
    }
    return expr;
  }
}

function resolveNodePreviewSourceHandle(
  node: MaterialNode,
  sourceHandle: string,
): string {
  if (sourceHandle !== "out") return sourceHandle;
  if (node.type === "dynamicParameter") return "Param1";
  return sourceHandle;
}

function toVec4(value: unknown, fallback: Vec4): Vec4 {
  if (typeof value === "number") return [value, value, value, value];
  if (typeof value === "boolean") {
    const n = value ? 1 : 0;
    return [n, n, n, n];
  }
  if (Array.isArray(value)) {
    return [
      numberOr(value[0], fallback[0]),
      numberOr(value[1], fallback[1]),
      numberOr(value[2], fallback[2]),
      numberOr(value[3], fallback[3]),
    ];
  }
  return [...fallback];
}
