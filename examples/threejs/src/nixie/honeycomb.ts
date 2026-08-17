import * as THREE from "three";

/**
 * The nixie anode is NOT a cylinder: it is a flattened box of very fine
 * hexagonal mesh — a flat mesh wall in front of the digit stack, a flat wall
 * behind it, wrapping tightly around the sides. We build it as one swept
 * rounded-rectangle wall with a procedural seamless hex-grid alpha texture:
 * a single draw call, arbitrarily fine cells, and the front/back overlap
 * produces the same moiré the real tube shows.
 */

let hexTexture: THREE.Texture | null = null;

export function getHexAlphaTexture(): THREE.Texture {
  if (hexTexture) {
    return hexTexture;
  }
  // Seamless pointy-top hex tile: period = (sqrt(3)*s, 3*s).
  const H = 222;
  const W = 128; // ~sqrt(3)/3 * H
  const s = H / 3;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 15.6;
  ctx.lineJoin = "round";
  for (let row = -1; row <= 2; row++) {
    const cy = (row * H) / 2;
    const offset = row % 2 === 0 ? 0 : W / 2;
    for (let col = -1; col <= 2; col++) {
      const cx = col * W + offset;
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = Math.PI / 2 + (k * Math.PI) / 3;
        const x = cx + Math.cos(a) * s;
        const y = cy + Math.sin(a) * s;
        if (k === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  hexTexture = tex;
  return tex;
}

export type CageOptions = {
  width: number;
  depth: number;
  height: number;
  cornerRadius: number;
  cellSize: number; // world size of one hex cell (width across)
};

export function createRoundedRectShape(
  w: number,
  d: number,
  r: number,
): THREE.Shape {
  const hw = w / 2;
  const hd = d / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hw + r, -hd);
  shape.lineTo(hw - r, -hd);
  shape.absarc(hw - r, -hd + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(hw, hd - r);
  shape.absarc(hw - r, hd - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-hw + r, hd);
  shape.absarc(-hw + r, hd - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-hw, -hd + r);
  shape.absarc(-hw + r, -hd + r, r, Math.PI, Math.PI * 1.5, false);
  shape.closePath();
  return shape;
}

export function createCageWallGeometry(
  opts: CageOptions,
): THREE.BufferGeometry {
  const shape = createRoundedRectShape(
    opts.width,
    opts.depth,
    opts.cornerRadius,
  );
  const segments = 220;
  const pts = shape.getSpacedPoints(segments);
  if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) > 1e-6) {
    pts.push(pts[0].clone());
  }
  const n = pts.length;

  // cumulative arc length for uniform hex density around the perimeter
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) {
    arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }

  const cellW = opts.cellSize;
  const cellH = opts.cellSize * (3 / Math.sqrt(3)); // keep hexes regular

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= 1; row++) {
    const y = -opts.height / 2 + row * opts.height;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const prev = pts[(i - 1 + n - 1) % (n - 1)];
      const next = pts[(i + 1) % (n - 1)];
      const tx = next.x - prev.x;
      const ty = next.y - prev.y;
      const len = Math.hypot(tx, ty) || 1;
      positions.push(p.x, y, p.y);
      normals.push(ty / len, 0, -tx / len);
      uvs.push(arc[i] / cellW, y / cellH);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i;
    const b = i + 1;
    const c = n + i;
    const d = n + i + 1;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

export function createCapPlateGeometry(
  width: number,
  depth: number,
  cornerRadius: number,
  thickness: number,
): THREE.BufferGeometry {
  const shape = createRoundedRectShape(width, depth, cornerRadius);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 24,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}
