import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Nixie cathodes as swept tubes. Each digit is one or more stroke paths
 * (authored in a 100x160 y-down box, nixie-style rounded forms); the lit
 * digit gets a fatter "plasma sheath" tube via the same curve.
 *
 * Real tubes are hand-bent wire with an uneven discharge, so all the
 * imperfection is baked at build time from seeded noise: the path wobbles,
 * the sheath/halo swell where the plasma runs hot and pinch where it is
 * weak, and an `aIntensity` vertex attribute carries the same noise to the
 * shaders so brightness stays correlated with thickness.
 */

export type DigitGeometry = {
  /** thin metal cathode wire — always visible */
  core: THREE.BufferGeometry;
  /** fat plasma sheath hugging the wire — lit digit only */
  sheath: THREE.BufferGeometry;
  /** soft additive halo — lit digit only */
  halo: THREE.BufferGeometry;
};

type Stroke = {
  path: (p: THREE.Path) => void;
  closed: boolean;
};

const BOX_TOP = 16;
const BOX_BOTTOM = 146;

export function createDigitGeometry(id: number, height: number): DigitGeometry {
  const coreR = height * 0.006;
  const sheathR = height * 0.019;
  const haloR = height * 0.042;
  const strokes = DIGIT_STROKES[id];
  if (!strokes) {
    throw new Error(`Unknown digit ${id}`);
  }

  const cores: THREE.BufferGeometry[] = [];
  const sheaths: THREE.BufferGeometry[] = [];
  const halos: THREE.BufferGeometry[] = [];
  strokes.forEach((stroke, strokeIndex) => {
    const seed = id * 13.7 + strokeIndex * 71.3;
    const wrap = stroke.closed;
    // slow drift = the main hot/cold spans; ripple = fine unevenness
    const drift = makeNoise(seed + 1, 4, wrap);
    const ripple = makeNoise(seed + 2, 11, wrap);
    const bendX = makeNoise(seed + 3, 3, wrap);
    const bendY = makeNoise(seed + 4, 3, wrap);
    const bendZ = makeNoise(seed + 5, 2, wrap);
    const intensityAt = (t: number) =>
      THREE.MathUtils.clamp(1 + 0.26 * drift(t) + 0.09 * ripple(t), 0.55, 1.32);
    const widthAt = (t: number) => 1 + 0.28 * drift(t) + 0.05 * ripple(t);

    // hand-bent wire: smooth seeded wobble on the control points, shared by
    // wire + sheath + halo so they stay concentric
    const jitter = height * 0.007;
    const jitterZ = height * 0.0045;
    const pts2 = samplePath(stroke, height);
    const pts3 = pts2.map((p, k) => {
      const t = k / (pts2.length - 1);
      return new THREE.Vector3(
        p.x + jitter * bendX(t),
        p.y + jitter * bendY(t),
        jitterZ * bendZ(t),
      );
    });
    const curve = new THREE.CatmullRomCurve3(
      pts3,
      stroke.closed,
      "catmullrom",
      0.12,
    );

    cores.push(new THREE.TubeGeometry(curve, 110, coreR, 8, stroke.closed));
    const sheath = new THREE.TubeGeometry(
      curve,
      110,
      sheathR,
      10,
      stroke.closed,
    );
    shapeTube(sheath, curve, 110, 10, stroke.closed, widthAt, intensityAt);
    sheaths.push(sheath);
    const halo = new THREE.TubeGeometry(curve, 72, haloR, 8, stroke.closed);
    shapeTube(
      halo,
      curve,
      72,
      8,
      stroke.closed,
      (t) => 1 + 0.22 * drift(t),
      intensityAt,
    );
    halos.push(halo);

    if (!stroke.closed) {
      // wire tips end in a slightly fatter, brighter droplet of plasma
      for (const [end, t] of [
        [pts3[0], 0],
        [pts3[pts3.length - 1], 1],
      ] as const) {
        const tipGlow = intensityAt(t) * 1.12;
        cores.push(endCap(coreR, end));
        sheaths.push(endCap(sheathR * widthAt(t) * 1.22, end, tipGlow));
        halos.push(endCap(haloR * 1.15, end, tipGlow));
      }
    }
  });

  const core = merge(cores, id);
  const sheath = merge(sheaths, id);
  const halo = merge(halos, id);
  return { core, sheath, halo };
}

/** deterministic integer hash -> [0,1) */
function hash(seed: number, i: number): number {
  const s = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * Smooth seeded value noise over [0,1] -> [-1,1]. `cells` sets the feature
 * count; wrapped noise is periodic so closed strokes have no seam.
 */
function makeNoise(
  seed: number,
  cells: number,
  wrap: boolean,
): (t: number) => number {
  const at = (i: number) =>
    hash(seed, wrap ? ((i % cells) + cells) % cells : i);
  return (t: number) => {
    const x = THREE.MathUtils.clamp(t, 0, 1) * cells;
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return THREE.MathUtils.lerp(at(i), at(i + 1), s) * 2 - 1;
  };
}

/**
 * Post-process a TubeGeometry: scale each vertex ring around its curve
 * center (variable thickness) and bake the matching brightness into an
 * `aIntensity` attribute. Ring layout mirrors TubeGeometry's generator:
 * tubularSegments+1 rings of radialSegments+1 vertices.
 */
function shapeTube(
  geo: THREE.BufferGeometry,
  curve: THREE.Curve<THREE.Vector3>,
  tubularSegments: number,
  radialSegments: number,
  closed: boolean,
  widthAt: (t: number) => number,
  intensityAt: (t: number) => number,
): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const ringSize = radialSegments + 1;
  const glow = new Float32Array(pos.count);
  const center = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= tubularSegments; i++) {
    // the final closed ring duplicates ring 0's vertices — keep scales equal
    const u = closed && i === tubularSegments ? 0 : i / tubularSegments;
    curve.getPointAt(u, center);
    const w = widthAt(u);
    const g = intensityAt(u);
    for (let j = 0; j < ringSize; j++) {
      const k = i * ringSize + j;
      v.fromBufferAttribute(pos, k);
      v.sub(center).multiplyScalar(w).add(center);
      pos.setXYZ(k, v.x, v.y, v.z);
      glow[k] = g;
    }
  }
  geo.setAttribute("aIntensity", new THREE.BufferAttribute(glow, 1));
}

function endCap(
  radius: number,
  at: THREE.Vector3,
  intensity?: number,
): THREE.BufferGeometry {
  const cap = new THREE.SphereGeometry(radius, 10, 8);
  cap.translate(at.x, at.y, at.z);
  if (intensity !== undefined) {
    const count = cap.getAttribute("position").count;
    cap.setAttribute(
      "aIntensity",
      new THREE.BufferAttribute(new Float32Array(count).fill(intensity), 1),
    );
  }
  return cap;
}

function merge(geos: THREE.BufferGeometry[], id: number): THREE.BufferGeometry {
  const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  if (!merged) {
    throw new Error(`Failed to build digit ${id}`);
  }
  return merged;
}

function samplePath(stroke: Stroke, height: number): THREE.Vector2[] {
  const path = new THREE.Path();
  stroke.path(path);
  const raw = path.getPoints(28);
  const scaleY = height / (BOX_BOTTOM - BOX_TOP);
  return raw.map(
    (p) =>
      new THREE.Vector2(
        ((p.x - 50) / 100) * height,
        (BOX_BOTTOM - p.y) * scaleY,
      ),
  );
}

const DIGIT_STROKES: Record<number, Stroke[]> = {
  0: [
    {
      closed: true,
      path: (p) => ellipse(p, 50, 81, 31, 58),
    },
  ],
  1: [
    {
      closed: false,
      path: (p) => {
        p.moveTo(52, 22);
        p.lineTo(52, 140);
      },
    },
  ],
  2: [
    {
      closed: false,
      path: (p) => {
        p.moveTo(21, 46);
        p.bezierCurveTo(20, 16, 79, 14, 79, 47);
        p.bezierCurveTo(79, 74, 45, 86, 23, 138);
        p.lineTo(81, 138);
      },
    },
  ],
  3: [
    {
      closed: false,
      path: (p) => {
        p.moveTo(24, 38);
        p.bezierCurveTo(34, 14, 76, 16, 75, 44);
        p.bezierCurveTo(74, 65, 57, 75, 45, 78);
        p.bezierCurveTo(63, 80, 81, 92, 78, 117);
        p.bezierCurveTo(74, 143, 29, 146, 22, 119);
      },
    },
  ],
  4: [
    {
      closed: false,
      path: (p) => {
        p.moveTo(60, 24);
        p.lineTo(19, 95);
        p.lineTo(87, 95);
      },
    },
    {
      closed: false,
      path: (p) => {
        p.moveTo(64, 60);
        p.lineTo(64, 140);
      },
    },
  ],
  5: [
    {
      closed: false,
      path: (p) => {
        p.moveTo(76, 24);
        p.lineTo(29, 24);
        p.lineTo(25, 67);
        p.bezierCurveTo(42, 57, 79, 62, 78, 98);
        p.bezierCurveTo(77, 133, 35, 145, 22, 115);
      },
    },
  ],
  6: [
    {
      closed: false,
      path: (p) => {
        p.moveTo(61, 22);
        p.bezierCurveTo(31, 43, 23, 80, 24, 101);
        p.bezierCurveTo(26, 131, 51, 143, 65, 132);
        p.bezierCurveTo(80, 119, 78, 92, 60, 86);
        p.bezierCurveTo(43, 80, 27, 91, 26, 104);
      },
    },
  ],
  7: [
    {
      closed: false,
      path: (p) => {
        p.moveTo(18, 26);
        p.lineTo(82, 26);
        p.lineTo(43, 138);
      },
    },
  ],
  8: [
    {
      closed: true,
      path: (p) => ellipse(p, 50, 53, 26, 33),
    },
    {
      closed: true,
      path: (p) => ellipse(p, 50, 113, 30, 31),
    },
  ],
  9: [
    {
      closed: false,
      path: (p) => {
        p.moveTo(39, 140);
        p.bezierCurveTo(69, 119, 77, 82, 76, 61);
        p.bezierCurveTo(74, 31, 49, 19, 35, 30);
        p.bezierCurveTo(20, 43, 22, 70, 40, 76);
        p.bezierCurveTo(57, 82, 73, 71, 74, 58);
      },
    },
  ],
};

function ellipse(
  path: THREE.Path,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): void {
  path.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, true, 0);
}
