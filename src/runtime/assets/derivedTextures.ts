import type { ParticleOpacitySource } from "../../engine/particles";

/**
 * Derived-texture helpers for the renderer-material "opacity source" feature.
 *
 * The pure pixel transform here is framework-agnostic (no Pixi/DOM) so it can be
 * unit tested directly. The Pixi-specific wrapper that turns a `Texture` into a
 * derived-alpha `Texture` lives in `src/runtime/pixi/material.ts`.
 */

/** True when the opacity source requires generating a derived alpha mask. */
export function opacitySourceNeedsDerivation(
  source: ParticleOpacitySource,
): boolean {
  return source !== "textureAlpha";
}

/** Rec. 709 luminance weights, matching common image tooling. */
const LUMINANCE_R = 0.2126;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;

/**
 * Rewrite the alpha channel of a straight-alpha RGBA buffer in place so that
 * opacity is taken from the requested source channel/luminance. RGB is left
 * untouched, so the particle tint still multiplies the original texture colour.
 *
 * @param rgba Straight (non-premultiplied) RGBA bytes, length a multiple of 4.
 */
export function deriveAlphaInPlace(
  rgba: Uint8ClampedArray | Uint8Array,
  source: ParticleOpacitySource,
  invert: boolean,
): void {
  if (source === "textureAlpha") {
    if (!invert) return;
    for (let i = 3; i < rgba.length; i += 4) {
      rgba[i] = 255 - rgba[i]!;
    }
    return;
  }
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    let alpha: number;
    switch (source) {
      case "red":
        alpha = r;
        break;
      case "green":
        alpha = g;
        break;
      case "blue":
        alpha = b;
        break;
      case "luminance":
        alpha = LUMINANCE_R * r + LUMINANCE_G * g + LUMINANCE_B * b;
        break;
      case "inverseLuminance":
        alpha = 255 - (LUMINANCE_R * r + LUMINANCE_G * g + LUMINANCE_B * b);
        break;
      case "constant":
        alpha = 255;
        break;
      default:
        alpha = rgba[i + 3]!;
        break;
    }
    rgba[i + 3] = invert ? 255 - alpha : alpha;
  }
}

/**
 * Stable cache key for a derived texture so the renderer reuses one GPU texture
 * per derivation combination instead of regenerating it.
 *
 * The legacy alpha-derivation key is `(source, opacitySource, invert)`. A
 * material graph bake (techspec §6.1 Tier 0) reuses the SAME derived-texture
 * cache but must not collide with — or be shadowed by — legacy alpha derivation,
 * so it appends an optional `materialBakeHash` (the deterministic digest of
 * `graph + overrides + mainTex.uid`, techspec §6.5).
 *
 * BACKWARD COMPAT (load-bearing): when `materialBakeHash` is `undefined` the key
 * is byte-identical to the original three-arg form, so every legacy emitter
 * (no material) keeps the exact same cache slot and the existing alpha-derivation
 * path stays bit-identical (asserted by `derivedTextures.test.ts`).
 */
export function derivedTextureCacheKey(
  sourceKey: string | number,
  source: ParticleOpacitySource,
  invert: boolean,
  materialBakeHash?: string,
): string {
  const base = `${sourceKey}|${source}|${invert ? 1 : 0}`;
  return materialBakeHash === undefined ? base : `${base}|${materialBakeHash}`;
}
