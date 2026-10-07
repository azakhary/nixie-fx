import type {
  BufferGeometry,
  InstancedMesh,
  Object3D,
  ShaderMaterial,
} from "three";

export type BillboardBatchSource = InstancedMesh<
  BufferGeometry,
  ShaderMaterial
>;
// Only runtime-owned, texture-only billboard views have this buffer contract.
// Hosts never need to inspect emitterViews or private simulation state.
const sources = new WeakSet<Object3D>();
export function registerBillboardBatchSource(mesh: BillboardBatchSource): void {
  sources.add(mesh);
}
export function isBillboardBatchSource(
  object: Object3D,
): object is BillboardBatchSource {
  return sources.has(object);
}
