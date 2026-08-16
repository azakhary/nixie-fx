import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
} from "three";
import type { ParticleBillboardShape } from "../../engine/particles";

/**
 * Procedural billboard shape textures for the Three backend (F12).
 *
 * The engine contract says `render.texture: null` "falls back to the
 * procedural billboard shape" — the Pixi backend rasterizes its procedural
 * sprites (`createPixiVfxProceduralTextures`), so assetless billboards on
 * Three must render the same shape instead of a bare untextured quad. The
 * bitmaps here are generated purely in math (no canvas/document), so they
 * work headless, in workers, and in node tests, and `billboard.softness`
 * drives the edge falloff explicitly.
 *
 * Textures are cached per shape+softness (+size) and shared across views —
 * callers must NOT dispose them (they never belong in a view's
 * `ownedTextures`). Hosts that want a hard teardown can call
 * `clearProceduralBillboardTextureCache()`.
 */

/** Power-of-two default keeps mipmaps friendly; visually matches Pixi's 96px sprites. */
const DEFAULT_PROCEDURAL_TEXTURE_SIZE = 64;
/** Minimum falloff band in pixels so softness 0 still antialiases the edge. */
const MIN_FALLOFF_BAND_PX = 1.25;
/** Circle radius as a fraction of texture size (mirrors Pixi's `size * 0.44`). */
const CIRCLE_RADIUS_FRACTION = 0.44;
/** Square half-extent as a fraction of size (mirrors Pixi's 8% inset rect). */
const SQUARE_HALF_EXTENT_FRACTION = 0.42;

const textureCache = new Map<string, DataTexture>();

/** Stable cache/view key for a procedural shape texture. */
export function proceduralBillboardTextureKey(
  shape: ParticleBillboardShape,
  softness: number,
  size = DEFAULT_PROCEDURAL_TEXTURE_SIZE,
): string {
  return `proc:${shape}:${quantizeSoftness(softness).toFixed(3)}:${size}`;
}

/**
 * The shared procedural texture for a billboard shape. White RGB with an
 * alpha falloff: opaque at the center, transparent at the shape edge, with
 * `softness` (0..1) controlling how much of the shape radius the falloff
 * band covers (0 = hard antialiased edge, 1 = falloff from the center).
 */
export function getProceduralBillboardTexture(
  shape: ParticleBillboardShape,
  softness: number,
  size = DEFAULT_PROCEDURAL_TEXTURE_SIZE,
): Texture {
  const key = proceduralBillboardTextureKey(shape, softness, size);
  const cached = textureCache.get(key);
  if (cached) return cached;
  const texture = createProceduralBillboardTexture(shape, softness, size);
  textureCache.set(key, texture);
  return texture;
}

/** Disposes and forgets every cached procedural texture (tests/teardown). */
export function clearProceduralBillboardTextureCache(): void {
  for (const texture of textureCache.values()) texture.dispose();
  textureCache.clear();
}

function createProceduralBillboardTexture(
  shape: ParticleBillboardShape,
  softness: number,
  size: number,
): DataTexture {
  const safeSize = Math.max(4, Math.round(size));
  const data = new Uint8Array(safeSize * safeSize * 4);
  const half = safeSize / 2;
  const clampedSoftness = quantizeSoftness(softness);
  for (let y = 0; y < safeSize; y++) {
    for (let x = 0; x < safeSize; x++) {
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      const alpha =
        shape === "square"
          ? squareAlpha(dx, dy, safeSize, clampedSoftness)
          : circleAlpha(dx, dy, safeSize, clampedSoftness);
      const offset = (y * safeSize + x) * 4;
      data[offset + 0] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new DataTexture(data, safeSize, safeSize, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function circleAlpha(
  dx: number,
  dy: number,
  size: number,
  softness: number,
): number {
  const radius = size * CIRCLE_RADIUS_FRACTION;
  const band = Math.max(softness * radius, MIN_FALLOFF_BAND_PX);
  return falloffAlpha(Math.hypot(dx, dy), radius, band);
}

function squareAlpha(
  dx: number,
  dy: number,
  size: number,
  softness: number,
): number {
  const halfExtent = size * SQUARE_HALF_EXTENT_FRACTION;
  const band = Math.max(softness * halfExtent, MIN_FALLOFF_BAND_PX);
  return falloffAlpha(Math.max(Math.abs(dx), Math.abs(dy)), halfExtent, band);
}

/** Smoothstep from opaque at `edge - band` to transparent at `edge`. */
function falloffAlpha(distance: number, edge: number, band: number): number {
  const t = Math.min(1, Math.max(0, (distance - (edge - band)) / band));
  return 1 - t * t * (3 - 2 * t);
}

function quantizeSoftness(softness: number): number {
  const clamped = Number.isFinite(softness)
    ? Math.min(1, Math.max(0, softness))
    : 0;
  return Math.round(clamped * 1000) / 1000;
}
