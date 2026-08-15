import type { Vec4 } from "../../engine/math";
import { numberOr } from "../../engine/particleModuleSettingUtils";

/**
 * Deterministic procedural noise generator (iteration 5b §6 "Add generated noise
 * bake support"). Framework-agnostic (plain numbers / typed arrays, no Pixi/DOM)
 * so it is shared verbatim by BOTH the runtime Tier-0 bake (`bake.ts`) and the
 * editor live preview (`previewEval.ts`) — same pixels in both, by construction.
 *
 * The headline rule (README P0): noise BAKES by default. There is no runtime
 * shader FBM here; we evaluate a closed-form, integer-lattice-hashed noise
 * per-texel. Because every value derives from a 32-bit integer hash of the
 * lattice cell + seed (never `Math.random`), the same params+seed produce
 * byte-identical output. `tiling` wraps the noise domain at Repeat Size / Tile
 * Size; for a seamless 0..1 bake, author Scale to span that same domain.
 */

// ---------------------------------------------------------------------------
// Option shapes + param readers (single source of the param-key vocabulary)
// ---------------------------------------------------------------------------

/** Scalar `noise` node function modes (Unreal `Noise` Function options). */
export type ScalarNoiseKind =
  "value" | "fastGradient" | "perlinGradient" | "simplex" | "voronoi";

/** Vector `vectorNoise` node function modes (Unreal `Vector Noise`). */
export type VectorNoiseKind =
  "cellnoise" | "perlin3d" | "perlinGradient" | "perlinCurl" | "voronoi";

export interface ScalarNoiseOptions {
  kind: ScalarNoiseKind;
  /** Frequency: cells across the [0,1] UV span. */
  scale: number;
  /** Tiling repeat domain in noise-space units. */
  repeatSize: number;
  /** FBM octaves (hard-capped 1..8 in the editor). */
  levels: number;
  /** Lacunarity — frequency multiplier per octave. */
  levelScale: number;
  /** Persistence — amplitude multiplier per octave. */
  gain: number;
  /** `abs(2n-1)` ridged turbulence. */
  turbulence: boolean;
  /** Seamlessly wrap the lattice at the UV edges. */
  tiling: boolean;
  /** Deterministic seed. */
  seed: number;
  /** Output remap low. */
  outputMin: number;
  /** Output remap high. */
  outputMax: number;
}

export interface VectorNoiseOptions {
  kind: VectorNoiseKind;
  scale: number;
  /** Tiling repeat domain in noise-space units. */
  tileSize: number;
  tiling: boolean;
  seed: number;
  /** Store the vector field in 0..1 channels (else signed -1..1). */
  normalizeOutput: boolean;
}

const SCALAR_KINDS = new Set<ScalarNoiseKind>([
  "value",
  "fastGradient",
  "perlinGradient",
  "simplex",
  "voronoi",
]);
const VECTOR_KINDS = new Set<VectorNoiseKind>([
  "cellnoise",
  "perlin3d",
  "perlinGradient",
  "perlinCurl",
  "voronoi",
]);

function intParam(value: unknown, fallback: number): number {
  return Math.round(numberOr(value, fallback));
}

/** Read a `noise` node's `params` into resolved options (the param-key contract). */
export function scalarNoiseOptionsFromParams(
  params: Record<string, unknown>,
): ScalarNoiseOptions {
  const kind = SCALAR_KINDS.has(params.function as ScalarNoiseKind)
    ? (params.function as ScalarNoiseKind)
    : "perlinGradient";
  return {
    kind,
    scale: Math.max(0.0001, numberOr(params.scale, 16)),
    repeatSize: Math.max(1, intParam(params.repeatSize, 256)),
    levels: Math.max(1, Math.min(8, intParam(params.levels, 1))),
    levelScale: numberOr(params.levelScale, 2),
    gain: numberOr(params.gain, 0.5),
    turbulence: params.turbulence === true,
    tiling: params.tiling !== false,
    seed: intParam(params.seed, 0),
    outputMin: numberOr(params.outputMin, 0),
    outputMax: numberOr(params.outputMax, 1),
  };
}

/** Read a `vectorNoise` node's `params` into resolved options. */
export function vectorNoiseOptionsFromParams(
  params: Record<string, unknown>,
): VectorNoiseOptions {
  const kind = VECTOR_KINDS.has(params.function as VectorNoiseKind)
    ? (params.function as VectorNoiseKind)
    : "perlinCurl";
  return {
    kind,
    scale: Math.max(0.0001, numberOr(params.scale, 8)),
    tileSize: Math.max(1, intParam(params.tileSize, 256)),
    tiling: params.tiling !== false,
    seed: intParam(params.seed, 0),
    normalizeOutput: params.normalizeOutput !== false,
  };
}

// ---------------------------------------------------------------------------
// Integer-lattice hashing (deterministic, no Math.random)
// ---------------------------------------------------------------------------

/** 32-bit integer avalanche hash → unsigned 32-bit. */
function hashInt(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash a lattice cell (ix, iy) + seed to a float in [0, 1). */
function hash2(ix: number, iy: number, seed: number): number {
  const h =
    (Math.imul(ix | 0, 0x1f1f1f1f) ^
      Math.imul(iy | 0, 0x85ebca6b) ^
      Math.imul(seed | 0, 0xc2b2ae35)) |
    0;
  return hashInt(h) / 4294967296;
}

/** Positive modulo (lattice wrap for tiling). */
function pmod(n: number, m: number): number {
  if (m <= 0) return n;
  return ((n % m) + m) % m;
}

function wrap(coord: number, period: number): number {
  return period > 0 ? pmod(coord, period) : coord;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ---------------------------------------------------------------------------
// Primitive noise fields (each returns ~[0,1])
// ---------------------------------------------------------------------------

/** Bilinear value noise on the integer lattice. */
function valueNoise2D(
  x: number,
  y: number,
  seed: number,
  period: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fade(fx);
  const v = fade(fy);
  const v00 = hash2(wrap(x0, period), wrap(y0, period), seed);
  const v10 = hash2(wrap(x0 + 1, period), wrap(y0, period), seed);
  const v01 = hash2(wrap(x0, period), wrap(y0 + 1, period), seed);
  const v11 = hash2(wrap(x0 + 1, period), wrap(y0 + 1, period), seed);
  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

/** Perlin gradient noise, remapped from ~[-0.7,0.7] into [0,1]. */
function gradientNoise2D(
  x: number,
  y: number,
  seed: number,
  period: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fade(fx);
  const v = fade(fy);
  const dot = (ix: number, iy: number, dx: number, dy: number): number => {
    const a = hash2(wrap(ix, period), wrap(iy, period), seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = dot(x0, y0, fx, fy);
  const n10 = dot(x0 + 1, y0, fx - 1, fy);
  const n01 = dot(x0, y0 + 1, fx, fy - 1);
  const n11 = dot(x0 + 1, y0 + 1, fx - 1, fy - 1);
  const nx0 = lerp(n00, n10, u);
  const nx1 = lerp(n01, n11, u);
  return clamp01(lerp(nx0, nx1, v) * 0.7071 + 0.5);
}

/** Voronoi F1 distance (nearest feature-point distance), ~[0,1]. */
function voronoi2D(x: number, y: number, seed: number, period: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let minD = Infinity;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox;
      const cy = iy + oy;
      const wx = wrap(cx, period);
      const wy = wrap(cy, period);
      const jitterX = hash2(wx, wy, seed);
      const jitterY = hash2(wx, wy, (seed ^ 0x9e3779b9) | 0);
      const dx = cx + jitterX - x;
      const dy = cy + jitterY - y;
      const d = dx * dx + dy * dy;
      if (d < minD) minD = d;
    }
  }
  return Math.min(1, Math.sqrt(minD));
}

function scalarPrimitive(
  kind: ScalarNoiseKind,
): (x: number, y: number, seed: number, period: number) => number {
  switch (kind) {
    case "value":
      return valueNoise2D;
    case "voronoi":
      return voronoi2D;
    // fastGradient / perlinGradient / simplex all resolve to gradient noise for
    // the baked path (simplex is visually substituted; bake quality is identical).
    default:
      return gradientNoise2D;
  }
}

// ---------------------------------------------------------------------------
// Public sampling API
// ---------------------------------------------------------------------------

/**
 * Sample scalar FBM noise at a UV coordinate (each 0..1). Deterministic for a
 * given `(options, u, v)`. Returns a value remapped into `[outputMin, outputMax]`.
 */
export function sampleScalarNoise(
  options: ScalarNoiseOptions,
  u: number,
  v: number,
): number {
  const base = options.scale;
  const period = options.tiling ? options.repeatSize : 0;
  const primitive = scalarPrimitive(options.kind);
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < options.levels; i++) {
    const coordScale = base * freq;
    let n = primitive(
      u * coordScale,
      v * coordScale,
      options.seed + i * 101,
      period,
    );
    if (options.turbulence) n = Math.abs(n * 2 - 1);
    sum += n * amp;
    norm += amp;
    amp *= options.gain;
    freq *= options.levelScale;
  }
  const value = clamp01(norm > 0 ? sum / norm : sum);
  return options.outputMin + value * (options.outputMax - options.outputMin);
}

/**
 * Sample a vector noise field at a UV coordinate → RGBA. R/G/B carry the vector
 * field; A carries a feature/distance value (useful for Voronoi). When
 * `normalizeOutput` is set, signed components are mapped into 0..1.
 */
export function sampleVectorNoise(
  options: VectorNoiseOptions,
  u: number,
  v: number,
): Vec4 {
  const base = options.scale;
  const period = options.tiling ? options.tileSize : 0;
  return sampleVectorNoiseAtScale(options, u, v, base, period);
}

function sampleVectorNoiseAtScale(
  options: VectorNoiseOptions,
  u: number,
  v: number,
  coordScale: number,
  period: number,
): Vec4 {
  const x = u * coordScale;
  const y = v * coordScale;
  const seed = options.seed;
  const norm = (signed: number): number =>
    options.normalizeOutput ? clamp01(signed * 0.5 + 0.5) : signed;

  switch (options.kind) {
    case "cellnoise": {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const wx = wrap(ix, period);
      const wy = wrap(iy, period);
      return [
        hash2(wx, wy, seed),
        hash2(wx, wy, (seed ^ 0x68bc21eb) | 0),
        hash2(wx, wy, (seed ^ 0x1b873593) | 0),
        1,
      ];
    }
    case "voronoi": {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      let minD = Infinity;
      let cellX = 0;
      let cellY = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = ix + ox;
          const cy = iy + oy;
          const wx = wrap(cx, period);
          const wy = wrap(cy, period);
          const px = cx + hash2(wx, wy, seed);
          const py = cy + hash2(wx, wy, (seed ^ 0x9e3779b9) | 0);
          const d = (px - x) * (px - x) + (py - y) * (py - y);
          if (d < minD) {
            minD = d;
            cellX = wx;
            cellY = wy;
          }
        }
      }
      return [
        hash2(cellX, cellY, (seed ^ 0x12345) | 0),
        hash2(cellX, cellY, (seed ^ 0x6789a) | 0),
        hash2(cellX, cellY, (seed ^ 0xbcdef) | 0),
        Math.min(1, Math.sqrt(minD)),
      ];
    }
    case "perlinCurl": {
      // Curl of a scalar potential → a divergence-free 2D flow field. Finite
      // difference of gradient noise gives (∂P/∂y, -∂P/∂x).
      const e = 0.01;
      const pot = (px: number, py: number): number =>
        gradientNoise2D(px, py, seed, period) * 2 - 1;
      const dPdx = (pot(x + e, y) - pot(x - e, y)) / (2 * e);
      const dPdy = (pot(x, y + e) - pot(x, y - e)) / (2 * e);
      let cx = dPdy;
      let cy = -dPdx;
      const len = Math.hypot(cx, cy) || 1;
      cx /= len;
      cy /= len;
      return [norm(cx), norm(cy), 0.5, 1];
    }
    default: {
      // perlin3d / perlinGradient → three decorrelated gradient channels.
      const r = gradientNoise2D(x, y, seed, period) * 2 - 1;
      const g = gradientNoise2D(x, y, (seed ^ 0x51ed270b) | 0, period) * 2 - 1;
      const b = gradientNoise2D(x, y, (seed ^ 0x2545f491) | 0, period) * 2 - 1;
      return [norm(r), norm(g), norm(b), 1];
    }
  }
}

// ---------------------------------------------------------------------------
// Image bakers (DOM-free; the editor wraps these into a canvas for thumbnails)
// ---------------------------------------------------------------------------

/** A DOM-free baked image (RGBA bytes). The editor wraps this into a canvas. */
export interface NoiseImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Bake scalar noise to a grayscale RGBA buffer (preview thumbnails / Tier 0). */
export function bakeScalarNoise(
  options: ScalarNoiseOptions,
  width: number,
  height: number,
): NoiseImage {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = w <= 1 ? 0 : x / w;
      const v = h <= 1 ? 0 : y / h;
      const n = clamp01(sampleScalarNoise(options, u, v)) * 255;
      const o = (y * w + x) * 4;
      data[o] = n;
      data[o + 1] = n;
      data[o + 2] = n;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Bake vector noise to an RGB-visualized RGBA buffer (preview thumbnails). */
export function bakeVectorNoise(
  options: VectorNoiseOptions,
  width: number,
  height: number,
): NoiseImage {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = w <= 1 ? 0 : x / w;
      const v = h <= 1 ? 0 : y / h;
      const c = sampleVectorNoise(options, u, v);
      const o = (y * w + x) * 4;
      data[o] = clamp01(c[0]) * 255;
      data[o + 1] = clamp01(c[1]) * 255;
      data[o + 2] = clamp01(c[2]) * 255;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

// ---------------------------------------------------------------------------
// 3-D curl noise (particle advection)
//
// The 2-D `perlinCurl` above serves UV-domain material baking. Particle motion
// needs the 3-D analogue: a divergence-free flow field, curl = ∇ × Ψ of a
// three-channel gradient-noise vector potential, taken by central finite
// differences. Shares the deterministic hashed-lattice infrastructure so the
// engine and editor previews sample the identical field.
// ---------------------------------------------------------------------------

/** Hash a 3-D lattice cell (ix, iy, iz) + seed to a float in [0, 1). */
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  const h =
    (Math.imul(ix | 0, 0x1f1f1f1f) ^
      Math.imul(iy | 0, 0x85ebca6b) ^
      Math.imul(iz | 0, 0x27d4eb2f) ^
      Math.imul(seed | 0, 0xc2b2ae35)) |
    0;
  return hashInt(h) / 4294967296;
}

/** Perlin gradient noise on the 3-D lattice, signed ~[-1, 1]. No tiling. */
export function gradientNoise3D(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const dot = (
    ix: number,
    iy: number,
    iz: number,
    dx: number,
    dy: number,
    dz: number,
  ): number => {
    // Uniform gradient direction from two hashes (azimuth + cos-polar).
    const azimuth = hash3(ix, iy, iz, seed) * Math.PI * 2;
    const cosPolar = hash3(ix, iy, iz, (seed ^ 0x9e3779b9) | 0) * 2 - 1;
    const sinPolar = Math.sqrt(Math.max(0, 1 - cosPolar * cosPolar));
    return (
      Math.cos(azimuth) * sinPolar * dx +
      Math.sin(azimuth) * sinPolar * dy +
      cosPolar * dz
    );
  };
  const n000 = dot(x0, y0, z0, fx, fy, fz);
  const n100 = dot(x0 + 1, y0, z0, fx - 1, fy, fz);
  const n010 = dot(x0, y0 + 1, z0, fx, fy - 1, fz);
  const n110 = dot(x0 + 1, y0 + 1, z0, fx - 1, fy - 1, fz);
  const n001 = dot(x0, y0, z0 + 1, fx, fy, fz - 1);
  const n101 = dot(x0 + 1, y0, z0 + 1, fx - 1, fy, fz - 1);
  const n011 = dot(x0, y0 + 1, z0 + 1, fx, fy - 1, fz - 1);
  const n111 = dot(x0 + 1, y0 + 1, z0 + 1, fx - 1, fy - 1, fz - 1);
  const nx00 = lerp(n000, n100, u);
  const nx10 = lerp(n010, n110, u);
  const nx01 = lerp(n001, n101, u);
  const nx11 = lerp(n011, n111, u);
  const nxy0 = lerp(nx00, nx10, v);
  const nxy1 = lerp(nx01, nx11, v);
  return lerp(nxy0, nxy1, w) * 1.155;
}

const CURL_EPSILON = 0.01;
// Rough RMS match against a unit sine wave so a given noise Strength feels
// comparable across the module's sine and curl modes.
const CURL_AMPLITUDE_SCALE = 0.4;

/**
 * Sample the divergence-free 3-D curl field at a point into `out`. The three
 * potential channels decorrelate by seed; the same (point, seed) always
 * returns the same vector, and the field has no per-particle dependence — all
 * particles share one coherent flow, which is what makes curl read as
 * turbulence instead of independent jitter.
 */
export function sampleCurlNoise3(
  x: number,
  y: number,
  z: number,
  seed: number,
  out: [number, number, number],
): void {
  const seedX = seed | 0;
  const seedY = (seed ^ 0x51ed270b) | 0;
  const seedZ = (seed ^ 0x2545f491) | 0;
  const e = CURL_EPSILON;
  const inv2e = 1 / (2 * e);
  // ∂Ψz/∂y − ∂Ψy/∂z
  const dPzdy =
    (gradientNoise3D(x, y + e, z, seedZ) -
      gradientNoise3D(x, y - e, z, seedZ)) *
    inv2e;
  const dPydz =
    (gradientNoise3D(x, y, z + e, seedY) -
      gradientNoise3D(x, y, z - e, seedY)) *
    inv2e;
  // ∂Ψx/∂z − ∂Ψz/∂x
  const dPxdz =
    (gradientNoise3D(x, y, z + e, seedX) -
      gradientNoise3D(x, y, z - e, seedX)) *
    inv2e;
  const dPzdx =
    (gradientNoise3D(x + e, y, z, seedZ) -
      gradientNoise3D(x - e, y, z, seedZ)) *
    inv2e;
  // ∂Ψy/∂x − ∂Ψx/∂y
  const dPydx =
    (gradientNoise3D(x + e, y, z, seedY) -
      gradientNoise3D(x - e, y, z, seedY)) *
    inv2e;
  const dPxdy =
    (gradientNoise3D(x, y + e, z, seedX) -
      gradientNoise3D(x, y - e, z, seedX)) *
    inv2e;
  out[0] = (dPzdy - dPydz) * CURL_AMPLITUDE_SCALE;
  out[1] = (dPxdz - dPzdx) * CURL_AMPLITUDE_SCALE;
  out[2] = (dPydx - dPxdy) * CURL_AMPLITUDE_SCALE;
}
