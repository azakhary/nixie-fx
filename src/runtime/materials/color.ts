import type { Vec4 } from "../../engine/math";
import type { MaterialNode, ShaderGraph } from "../schema/materials";

/** Color conversion preserves alpha and does not clamp HDR values. */
export function materialColorToLinear(value: Vec4): Vec4 {
  const convert = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return [convert(value[0]), convert(value[1]), convert(value[2]), value[3]];
}
export function materialColorToSrgb(value: Vec4): Vec4 {
  const convert = (v: number) =>
    v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return [convert(value[0]), convert(value[1]), convert(value[2]), value[3]];
}
export function materialTextureUsesColor(
  graph: ShaderGraph,
  node: MaterialNode,
): boolean {
  if (graph.colorVersion !== 1) return false;
  if (node.params.samplerType === "linear") return false;
  if (node.params.samplerType === "srgb") return true;
  // Historical "Color" was inert. Treat it as Auto without rewriting old files.
  return graph.edges.some(
    (edge) =>
      edge.source === node.id &&
      !["R", "G", "B", "A"].includes(edge.sourceHandle),
  );
}
