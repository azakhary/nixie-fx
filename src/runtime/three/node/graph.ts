import * as T from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";
import type { Texture } from "three";
import type {
  MaterialInstance,
  MaterialNode,
  MaterialOutputSlot,
  ShaderGraph,
} from "../../schema/materials";
import {
  resolveMaterialParamValue,
  resolveMaterialTextureNodeBinding,
} from "../../schema/materials";
import { expandMaterialSubgraphs } from "../../materials/subgraphs";
import { materialTextureUsesColor } from "../../materials/color";

export type Node4 = Node<"vec4">;
export interface ThreeNodeGraphInputs {
  time: UniformNode<"float", number>;
  particleColor: Node4;
  dynamic: Node4;
  subUv: Node4;
  mainTexture: Texture | null;
  textureForPath(path: string): Texture | null;
  scene?: Partial<
    Record<
      | "mainLightDirection"
      | "mainLightColor"
      | "sceneAmbientColor"
      | "sceneDiffuseLighting",
      Node4
    >
  >;
  tiles: [number, number];
}
export class ThreeNodeMaterialError extends Error {
  constructor(
    readonly materialId: string,
    readonly nodeId: string,
    reason: string,
  ) {
    super(
      `Material "${materialId}", node "${nodeId}": ${reason} Fix this node and retry.`,
    );
    this.name = "ThreeNodeMaterialError";
  }
}
export function nodeLinearColor(value: Node4): Node4 {
  const c = T.max(value.rgb, 0);
  return T.vec4(
    T.vec3(
      ...([c.r, c.g, c.b].map((v) =>
        T.mix(
          v.div(12.92),
          v.add(0.055).div(1.055).pow(2.4),
          T.step(0.04045, v),
        ),
      ) as [Node<"float">, Node<"float">, Node<"float">]),
    ),
    value.a,
  );
}
/** Compiles the authored graph, including portable subgraphs, without eval or GLSL injection. */
export function compileThreeNodeGraph(
  authored: ShaderGraph,
  instance: MaterialInstance,
  inputs: ThreeNodeGraphInputs,
) {
  const graph = expandMaterialSubgraphs(authored);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const cache = new Map<string, Node4>();
  const visiting = new Set<string>();
  let readsParticleColor = false;
  const color = (v: Node4) =>
    graph.colorVersion === 1 ? nodeLinearColor(v) : v;
  const main = (uv: Node<"vec2">) =>
    inputs.mainTexture
      ? T.texture(
          inputs.mainTexture,
          inputs.subUv.xy.add(T.fract(uv).mul(inputs.subUv.zw)),
        )
      : T.vec4(1);
  const select = (v: Node4, handle: string): Node4 => {
    const index = ["R", "G", "B", "A"].indexOf(handle);
    const param = ["Param1", "Param2", "Param3", "Param4"].indexOf(handle);
    const i = index >= 0 ? index : param;
    return i < 0 ? v : T.vec4([v.r, v.g, v.b, v.a][i]!);
  };
  const edgeValue = (id: string): Node4 => {
    const edge = edges.get(id);
    if (!edge || !nodes.has(edge.source))
      throw new ThreeNodeMaterialError(
        graph.id,
        id,
        "Missing graph connection.",
      );
    return select(evaluate(nodes.get(edge.source)!), edge.sourceHandle);
  };
  const evaluate = (node: MaterialNode): Node4 => {
    const old = cache.get(node.id);
    if (old) return old;
    if (visiting.has(node.id))
      throw new ThreeNodeMaterialError(
        graph.id,
        node.id,
        "Cyclic graph connection.",
      );
    visiting.add(node.id);
    const p = node.params;
    const num = (key: string, fallback: number) =>
      typeof p[key] === "number" && Number.isFinite(p[key])
        ? (p[key] as number)
        : fallback;
    const input = (pin: string, fallback: Node4 = T.vec4(0)): Node4 =>
      node.inputs[pin] ? edgeValue(node.inputs[pin]!) : fallback;
    const scalar = (pin: string, fallback: number) =>
      input(pin, T.vec4(fallback)).r;
    const uv = () => input("uv", T.vec4(T.uv(), 0, 0)).xy;
    const sample = () => {
      const binding = resolveMaterialTextureNodeBinding(
        graph,
        instance,
        node,
        nodes,
        edges,
      );
      if (!binding.path || binding.isMainTex) return main(uv());
      const tex = inputs.textureForPath(binding.path);
      if (!tex)
        throw new ThreeNodeMaterialError(
          graph.id,
          node.id,
          `Texture "${binding.path}" is unavailable.`,
        );
      return T.texture(tex, T.fract(uv()));
    };
    const a = (fallback = 0) => input("a", T.vec4(num("a", fallback)));
    const b = (fallback = 0) => input("b", T.vec4(num("b", fallback)));
    let result: Node4;
    switch (node.type) {
      case "constant":
        result =
          p.kind === "color" || (p.kind === undefined && Array.isArray(p.value))
            ? color(constant(p.value))
            : constant(p.value);
        break;
      case "param": {
        const name = String(p.name ?? "");
        const value = constant(
          resolveMaterialParamValue(graph, instance, name),
        );
        result =
          graph.params.find((p) => p.name === name)?.type === "color"
            ? color(value)
            : value;
        break;
      }
      case "time":
        result = T.vec4(inputs.time);
        break;
      case "uv":
        result = T.vec4(T.uv(), 0, 0);
        break;
      case "particleColor":
        readsParticleColor = true;
        result = color(inputs.particleColor);
        break;
      // Preserve the existing authored GLSL compatibility feeds. Rich CPU values
      // travel in separate attributes; changing old node meanings needs a version.
      case "particleRelativeTime":
        result = T.vec4(inputs.particleColor.a.clamp());
        break;
      case "particleRandom":
        result = T.vec4(
          T.fract(
            inputs.particleColor.r
              .add(inputs.particleColor.g.mul(13.17))
              .add(inputs.particleColor.b.mul(7.31)),
          ),
        );
        break;
      case "particleSpeed":
      case "particleSize":
      case "particleDirection":
      case "particlePosition":
      case "particleMacroUV":
        throw new ThreeNodeMaterialError(
          graph.id,
          node.id,
          `${node.type} has no authored legacy Three feed. Use Dynamic Parameter channels for per-particle values.`,
        );
      case "dynamicParameter":
        result = inputs.dynamic;
        break;
      case "textureSample":
        result = materialTextureUsesColor(graph, node)
          ? color(sample())
          : sample();
        break;
      case "particleSubUV": {
        let value: Node4 = sample();
        const binding = resolveMaterialTextureNodeBinding(
          graph,
          instance,
          node,
          nodes,
          edges,
        );
        const [x, y] = inputs.tiles;
        if (
          p.blend === true &&
          (!binding.path || binding.isMainTex) &&
          x * y > 1 &&
          inputs.mainTexture
        ) {
          const tiles = T.vec2(x, y),
            scaled = inputs.subUv.xy
              .add(T.fract(uv()).mul(inputs.subUv.zw))
              .mul(tiles),
            cell = scaled.floor();
          const frame = T.mod(
            T.float(y - 1)
              .sub(cell.y)
              .mul(x)
              .add(cell.x)
              .add(1),
            x * y,
          );
          const next = T.vec2(
            T.mod(frame, x),
            T.float(y - 1).sub(frame.div(x).floor()),
          )
            .add(scaled.fract())
            .div(tiles);
          value = T.mix(
            value,
            T.texture(inputs.mainTexture, next),
            inputs.particleColor.a.clamp(),
          );
        }
        result = materialTextureUsesColor(graph, node) ? color(value) : value;
        break;
      }
      case "tilingOffset":
        result = T.vec4(
          uv()
            .mul(input("tile", constant(p.tile, [1, 1, 0, 0])).xy)
            .add(input("offset", constant(p.offset)).xy),
          0,
          0,
        );
        break;
      case "panner":
        result = T.vec4(
          uv().add(
            input("speed", constant(p.speed)).xy.mul(
              node.inputs.time ? scalar("time", 0) : inputs.time,
            ),
          ),
          0,
          0,
        );
        break;
      case "polarCoordinates": {
        const delta = input("UV", T.vec4(T.uv(), 0, 0)).xy.sub(
          input("Center", constant(p.center, [0.5, 0.5, 0, 0])).xy,
        );
        const angle = delta
          .dot(delta)
          .equal(0)
          .select(T.float(0), T.atan(delta.x, delta.y));
        result = T.vec4(
          delta
            .length()
            .mul(2)
            .mul(scalar("Radial Scale", num("radialScale", 1))),
          angle.div(6.28).mul(scalar("Length Scale", num("lengthScale", 1))),
          0,
          0,
        );
        break;
      }
      case "rotateUV": {
        const center = constant(p.center, [0.5, 0.5, 0, 0]).xy,
          d = uv().sub(center),
          angle = inputs.time.mul(num("speed", 0) * Math.PI * 2),
          c = angle.cos(),
          s = angle.sin();
        result = T.vec4(
          center.add(
            T.vec2(c.mul(d.x).sub(s.mul(d.y)), s.mul(d.x).add(c.mul(d.y))),
          ),
          0,
          0,
        );
        break;
      }
      case "twoSidedSign":
        result = T.vec4(
          T.frontFacing.select(
            graph.side === "back" ? -1 : 1,
            graph.side === "back" ? 1 : -1,
          ),
        );
        break;
      case "sceneWorldNormal":
        result = T.vec4(T.normalWorld, 0);
        break;
      case "sceneWorldPosition":
        result = T.vec4(T.positionWorld, 1);
        break;
      case "sceneViewDirection":
        result = T.vec4(T.cameraPosition.sub(T.positionWorld).normalize(), 0);
        break;
      case "mainLightDirection":
      case "mainLightColor":
      case "sceneAmbientColor":
      case "sceneDiffuseLighting":
        if (!inputs.scene?.[node.type])
          throw new ThreeNodeMaterialError(
            graph.id,
            node.id,
            "This lighting read needs a scene-aware node adapter.",
          );
        result = inputs.scene[node.type]!;
        break;
      case "unpackNormal": {
        const n = input("in", T.vec4(0.5, 0.5, 1, 1))
          .xyz.mul(2)
          .sub(1);
        result = T.vec4(
          T.vec3(
            n.xy.mul(scalar("strength", num("strength", 1))),
            n.z.max(0.0001),
          ).normalize(),
          1,
        );
        break;
      }
      case "fresnelTrue":
        result = T.vec4(
          T.float(1)
            .sub(
              input("normal", T.vec4(T.normalWorld, 0))
                .xyz.normalize()
                .dot(
                  input(
                    "viewDir",
                    T.vec4(
                      T.cameraPosition.sub(T.positionWorld).normalize(),
                      0,
                    ),
                  ).xyz.normalize(),
                )
                .clamp(),
            )
            .pow(scalar("power", num("power", 1))),
        );
        break;
      case "fresnel":
        result = T.vec4(
          T.float(1)
            .sub(
              T.uv()
                .sub(constant(p.center, [0.5, 0.5, 0, 0]).xy)
                .length()
                .mul(2)
                .clamp(),
            )
            .max(0)
            .pow(Math.max(0, num("power", 1))),
        );
        break;
      case "sphereMask": {
        const r = Math.max(0.0001, num("radius", 0.5)),
          edge =
            r * (1 - Math.max(0, Math.min(1, num("hardness", 0.5)))) + 0.0001;
        result = T.vec4(
          T.float(1)
            .sub(
              T.uv()
                .sub(constant(p.center, [0.5, 0.5, 0, 0]).xy)
                .length()
                .sub(r - edge)
                .div(edge),
            )
            .clamp(),
        );
        break;
      }
      case "multiply":
        result = a(1).mul(b(1));
        break;
      case "add":
        result = a().add(b());
        break;
      case "subtract":
        result = a().sub(b());
        break;
      case "divide":
        result = a().div(b(1).abs().max(0.000001));
        break;
      case "min":
        result = T.min(a(), b());
        break;
      case "max":
        result = T.max(a(), b());
        break;
      case "lerp":
        result = each4((c) =>
          T.mix(
            channel(a(), c),
            channel(b(1), c),
            channel(input("t", T.vec4(num("t", 0.5))), c),
          ),
        );
        break;
      case "oneMinus":
        result = T.vec4(1).sub(input("in"));
        break;
      case "clamp":
        result = input("in").clamp(
          scalar("min", num("min", 0)),
          scalar("max", num("max", 1)),
        );
        break;
      case "step":
        result = each4((c) =>
          T.step(scalar("edge", num("edge", 0.5)), channel(input("in"), c)),
        );
        break;
      case "smoothstep":
        result = each4((c) =>
          T.smoothstep(
            scalar("edge0", num("edge0", 0)),
            scalar("edge1", num("edge1", 1)),
            channel(input("in"), c),
          ),
        );
        break;
      case "power":
        result = input("in")
          .max(0)
          .pow(input("exp", T.vec4(num("exponent", 1))));
        break;
      case "remap": {
        const lo = scalar("inMin", num("inMin", 0)),
          hi = scalar("inMax", num("inMax", 1)),
          outLo = scalar("outMin", num("outMin", 0)),
          outHi = scalar("outMax", num("outMax", 1));
        result = input("in")
          .sub(lo)
          .div(hi.sub(lo).max(0.000001))
          .mul(outHi.sub(outLo))
          .add(outLo);
        break;
      }
      case "desaturate": {
        const v = input("in");
        result = T.vec4(
          T.mix(
            v.rgb,
            T.vec3(v.rgb.dot(T.vec3(0.2126, 0.7152, 0.0722))),
            Math.max(0, Math.min(1, num("fraction", 1))),
          ),
          v.a,
        );
        break;
      }
      case "split":
        result = T.vec4(channel(input("in"), String(p.channel ?? "r")));
        break;
      case "combine":
        result = T.vec4(
          input("r").r,
          input("g").r,
          input("b").r,
          input("a", T.vec4(1)).r,
        );
        break;
      case "swizzle": {
        const v = input("in"),
          s = String(p.pattern ?? "rgba")
            .toLowerCase()
            .replace(/[^rgba]/g, "")
            .padEnd(4, "a")
            .slice(0, 4);
        result = T.vec4(
          ...(Array.from(s, (c) => channel(v, c)) as [
            Node<"float">,
            Node<"float">,
            Node<"float">,
            Node<"float">,
          ]),
        );
        break;
      }
      case "abs":
        result = input("in").abs();
        break;
      case "frac":
        result = input("in").fract();
        break;
      case "floor":
        result = input("in").floor();
        break;
      case "ceil":
        result = input("in").ceil();
        break;
      case "round":
        result = input("in").add(0.5).floor();
        break;
      case "sign":
        result = input("in").sign();
        break;
      case "sqrt":
        result = each4((c) => T.sqrt(channel(input("in"), c).max(0)));
        break;
      case "length":
        result = T.vec4(input("in").xyz.length());
        break;
      case "normalize": {
        const v = input("in");
        result = T.vec4(v.xyz.normalize(), v.a);
        break;
      }
      case "dot":
        result = T.vec4(a().xyz.dot(b().xyz));
        break;
      case "sine":
        result = input("in")
          .mul((Math.PI * 2) / Math.max(0.0001, num("period", 1)))
          .sin();
        break;
      case "cosine":
        result = input("in")
          .mul((Math.PI * 2) / Math.max(0.0001, num("period", 1)))
          .cos();
        break;
      case "if":
        result = a()
          .r.greaterThan(b().r.add(0.000001))
          .select(
            input("aGreater"),
            a()
              .r.lessThan(b().r.sub(0.000001))
              .select(input("aLess"), input("aEqual", input("aGreater"))),
          );
        break;
      case "antialiasedTextureMask": {
        const threshold = scalar("Threshold", num("threshold", 0.5)),
          soft = Math.max(0.0001, num("softness", 0.04));
        result = T.vec4(
          T.smoothstep(
            threshold.sub(soft),
            threshold.add(soft),
            channel(sample(), String(p.channel ?? "a")),
          ),
        );
        break;
      }
      case "sphericalParticleOpacity":
        result = T.vec4(
          T.float(1)
            .sub(
              T.uv()
                .sub(constant(p.center, [0.5, 0.5, 0, 0]).xy)
                .div(Math.max(0.0001, num("radius", 0.5)))
                .length(),
            )
            .max(0)
            .pow(scalar("Density", num("density", 1)))
            .clamp(),
        );
        break;
      case "gradientRamp": {
        const t = node.inputs.t ? scalar("t", 0) : T.uv().x;
        const stops = (Array.isArray(p.stops) ? p.stops : [])
          .map((s) => ({
            position: Math.max(0, Math.min(1, Number(s.position) || 0)),
            color: color(constant(s.color, [1, 1, 1, 1])),
          }))
          .sort((a, b) => a.position - b.position);
        result = stops[0]?.color ?? T.vec4(t);
        for (let i = 1; i < stops.length; i++) {
          const prev = stops[i - 1]!,
            curr = stops[i]!;
          result = T.mix(
            result,
            curr.color,
            t
              .sub(prev.position)
              .div(Math.max(0.0001, curr.position - prev.position))
              .clamp(),
          );
        }
        break;
      }
      case "noise":
      case "vectorNoise": {
        const pos = input("Position", T.vec4(T.uv(), 0, 0)).xy,
          scale = Math.max(
            0.0001,
            num("scale", node.type === "noise" ? 16 : 8),
          ),
          seed = num("seed", 0);
        const mode =
          p.function === "value" || p.function === "cellnoise"
            ? 1
            : p.function === "voronoi"
              ? 2
              : 0;
        const noise = (offset: [number, number], s: number) =>
          scalarNoise(pos.add(T.vec2(...offset)).mul(scale), s, mode);
        result =
          node.type === "noise"
            ? T.vec4(
                T.mix(
                  num("outputMin", 0),
                  num("outputMax", 1),
                  noise([0, 0], seed),
                ),
              )
            : T.vec4(
                noise([17, 31], seed),
                noise([73, 11], seed + 1),
                noise([5, 47], seed + 2),
                1,
              );
        break;
      }
      default:
        throw new ThreeNodeMaterialError(
          graph.id,
          node.id,
          `Unsupported node type "${node.type}".`,
        );
    }
    visiting.delete(node.id);
    cache.set(node.id, result);
    return result;
  };
  const slot = (slot: MaterialOutputSlot) =>
    graph.outputs[slot] ? edgeValue(graph.outputs[slot]!) : null;
  const base = slot("baseColor"),
    emissive = slot("emissive"),
    opacity = slot("opacity"),
    mask = slot("opacityMask"),
    normal = slot("normal"),
    roughness = slot("roughness"),
    metallic = slot("metallic");
  return {
    graph,
    base: base ?? color(main(T.uv())),
    emissive: emissive ?? T.vec4(0),
    opacity:
      opacity?.r ??
      (base
        ? base.a
        : emissive
          ? emissive.rgb.dot(T.vec3(0.2126, 0.7152, 0.0722))
          : main(T.uv()).a),
    mask,
    normal,
    roughness,
    metallic,
    readsParticleColor,
  };
}
function constant(
  value: unknown,
  fallback: [number, number, number, number] = [0, 0, 0, 0],
): Node4 {
  if (typeof value === "number")
    return T.vec4(Number.isFinite(value) ? value : 0);
  if (typeof value === "boolean") return T.vec4(value ? 1 : 0);
  const values = fallback.map((f, i) =>
    Array.isArray(value) &&
    typeof value[i] === "number" &&
    Number.isFinite(value[i])
      ? value[i]
      : f,
  );
  return T.vec4(values[0]!, values[1]!, values[2]!, values[3]!);
}
function channel(value: Node4, c: string) {
  return c === "g"
    ? value.g
    : c === "b"
      ? value.b
      : c === "a"
        ? value.a
        : value.r;
}
function scalarNoise(p: Node<"vec2">, seed: number, mode: number) {
  const hash = (p: Node<"vec2">, s: number) => {
    const v = T.fract(
      T.vec3(p.x, p.y, p.x)
        .mul(0.1031)
        .add(s * 0.00317),
    );
    const w = v.add(v.dot(T.vec3(v.y, v.z, v.x).add(33.33)));
    return w.x.add(w.y).mul(w.z).fract();
  };
  const i = p.floor(),
    f = p.fract();
  if (mode === 2) {
    let d: Node<"float"> = T.float(100000);
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        const cell = i.add(T.vec2(x, y)),
          diff = cell
            .add(T.vec2(hash(cell, seed), hash(cell, seed + 37.719)))
            .sub(p);
        d = T.min(d, diff.dot(diff));
      }
    return d.sqrt().min(1);
  }
  const offsets: [number, number][] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  const n = offsets.map((o) => {
    const h = hash(i.add(T.vec2(...o)), seed);
    return mode === 1
      ? h
      : T.vec2(h.mul(6.2831853).cos(), h.mul(6.2831853).sin()).dot(
          f.sub(T.vec2(...o)),
        );
  });
  const u =
    mode === 1
      ? f.mul(f).mul(T.vec2(3).sub(f.mul(2)))
      : f
          .mul(f)
          .mul(f)
          .mul(f.mul(f.mul(6).sub(15)).add(10));
  const value = T.mix(T.mix(n[0]!, n[1]!, u.x), T.mix(n[2]!, n[3]!, u.x), u.y);
  return mode === 1 ? value : value.mul(0.7071).add(0.5).clamp();
}

function each4(f: (channel: string) => Node<"float">): Node4 {
  return T.vec4(f("r"), f("g"), f("b"), f("a"));
}
