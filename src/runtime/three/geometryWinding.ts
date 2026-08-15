import { BufferAttribute, BufferGeometry, Matrix4 } from "three";

export function repairMirroredGeometryWinding(
  geometry: BufferGeometry,
  sourceMatrix: Matrix4,
): boolean {
  if (sourceMatrix.determinant() >= 0) return false;
  reverseGeometryWinding(geometry);
  return true;
}

export function reverseGeometryWinding(geometry: BufferGeometry): void {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i < index.count - 2; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
  } else {
    for (const attribute of Object.values(geometry.attributes)) {
      swapTriangleVertices(attribute, 1, 2);
    }
  }

  negateVectorAttribute(geometry.getAttribute("normal"), 3);
  negateVectorAttribute(geometry.getAttribute("tangent"), 3);
}

function swapTriangleVertices(
  attribute: BufferGeometry["attributes"][string],
  aOffset: number,
  bOffset: number,
): void {
  if (!(attribute instanceof BufferAttribute)) return;
  const itemSize = attribute.itemSize;
  const values = attribute.array as unknown as number[];
  for (let i = 0; i < attribute.count - 2; i += 3) {
    const a = (i + aOffset) * itemSize;
    const b = (i + bOffset) * itemSize;
    for (let c = 0; c < itemSize; c++) {
      const next = values[a + c]!;
      values[a + c] = values[b + c]!;
      values[b + c] = next;
    }
  }
  attribute.needsUpdate = true;
}

function negateVectorAttribute(
  attribute: BufferGeometry["attributes"][string] | undefined,
  components: number,
): void {
  if (!(attribute instanceof BufferAttribute)) return;
  const itemSize = attribute.itemSize;
  const values = attribute.array as unknown as number[];
  const limit = Math.min(itemSize, components);
  for (let i = 0; i < attribute.count; i++) {
    const offset = i * itemSize;
    for (let c = 0; c < limit; c++) {
      values[offset + c] = -(values[offset + c] ?? 0);
    }
  }
  attribute.needsUpdate = true;
}
