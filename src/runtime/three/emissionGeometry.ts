import type { BufferGeometry } from "three";
import type { ParticleEmissionGeometryInput } from "../../engine/particles";

/**
 * Adapts a three.js BufferGeometry into the engine's plain-array emission
 * input. Uses attribute accessors (not raw arrays) so interleaved and
 * normalized attributes read correctly. Returns null when the geometry has no
 * usable position data.
 */
export function threeGeometryToEmissionInput(
  geometry: BufferGeometry,
): ParticleEmissionGeometryInput | null {
  const position = geometry.getAttribute("position");
  if (!position || position.itemSize !== 3 || position.count === 0) {
    return null;
  }
  const vertexCount = position.count;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3 + 0] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }

  let normals: Float32Array | null = null;
  const normal = geometry.getAttribute("normal");
  if (normal && normal.itemSize === 3 && normal.count >= vertexCount) {
    normals = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      normals[i * 3 + 0] = normal.getX(i);
      normals[i * 3 + 1] = normal.getY(i);
      normals[i * 3 + 2] = normal.getZ(i);
    }
  }

  const index = geometry.getIndex();
  let indices: Uint32Array | null = null;
  if (index && index.count >= 3) {
    indices = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i++) {
      indices[i] = index.getX(i);
    }
  }

  return { positions, indices, normals };
}
