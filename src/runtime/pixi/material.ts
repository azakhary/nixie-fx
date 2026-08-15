import { CanvasSource, ImageSource, Texture } from "pixi.js";
import type { ParticleOpacitySource } from "../../engine/particles";
import { deriveAlphaInPlace } from "../assets/derivedTextures";
import { bakeGraphInPlace, type BakeTextureSampler } from "../materials/bake";
import type { MaterialInstance, ShaderGraph } from "../schema/materials";

type CanvasFactory = Pick<Document, "createElement">;

/**
 * Build a new texture whose alpha channel is derived from the requested source
 * channel/luminance of `source`. Returns `null` when derivation is not possible
 * (no DOM canvas available, or the source texture has no readable pixels — e.g.
 * `Texture.EMPTY` in headless tests), so the caller can fall back to the
 * original texture.
 */
export function createDerivedAlphaTexture(
  source: Texture,
  opacitySource: ParticleOpacitySource,
  invert: boolean,
  documentRef?: CanvasFactory,
): Texture | null {
  const doc =
    documentRef ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return null;

  const textureSource = source.source;
  const resource = textureSource?.resource as CanvasImageSource | undefined;
  const frame = source.frame;
  const sourceX = frame?.x ?? 0;
  const sourceY = frame?.y ?? 0;
  const width = frame?.width ?? textureSource?.pixelWidth ?? 0;
  const height = frame?.height ?? textureSource?.pixelHeight ?? 0;
  if (!resource || width <= 0 || height <= 0) return null;

  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  try {
    context.drawImage(
      resource,
      sourceX,
      sourceY,
      width,
      height,
      0,
      0,
      width,
      height,
    );
    const image = context.getImageData(0, 0, width, height);
    deriveAlphaInPlace(image.data, opacitySource, invert);
    context.putImageData(image, 0, 0);
  } catch {
    // Tainted canvas or an unsupported resource type — fall back to the source.
    return null;
  }

  return Texture.from(canvas);
}

/**
 * Return a `Texture` over the same pixels whose source is tagged
 * `premultiplied-alpha` (I13-A): an authored-premultiplied atlas is already
 * premultiplied, so Pixi must (a) NOT premultiply it again on upload and (b) NOT
 * auto-swap the `normal` container blend to `normal-npm` (that swap only fires
 * for `no-premultiply-alpha` sources). The RGB reaching the `[ONE, 1-SA]` blend
 * stage stays premultiplied, so a single atlas can mix additive glow with
 * translucent smoke. Returns the source unchanged when the resource is not an
 * uploadable image/canvas (headless / `Texture.EMPTY`), mirroring
 * `createDerivedAlphaTexture`'s null-safety.
 *
 * Two resource kinds reach here: an authored-premult atlas arrives as an
 * uploadable image (`ImageSource`), while an opacity-source-derived texture
 * (red/green/blue/luminance/inverseLuminance/constant) arrives canvas-backed
 * (`CanvasSource`, from `createDerivedAlphaTexture`'s `Texture.from(canvas)`).
 * `ImageSource.test` only matches image/bitmap/video, so the canvas case needs
 * its own branch — without it the premultiplied tag silently drops for every
 * derived opacity source and Pixi degrades to an alpha-equivalent look while
 * Three keeps `premultipliedAlpha=true` (a cross-backend divergence). A fresh
 * source is constructed (never mutating the incoming source's `alphaMode`)
 * because the derived texture is cached by (uid, opacitySource, invert) with no
 * blend axis, so it can be shared by a premultiplied and a non-premultiplied
 * emitter; only this premultiplied wrapper carries the tag.
 */
export function createPremultipliedSourceTexture(source: Texture): Texture {
  const resource = source.source?.resource;
  if (!resource) return source;
  if (ImageSource.test(resource)) {
    const premultipliedSource = new ImageSource({
      resource,
      alphaMode: "premultiplied-alpha",
    });
    return new Texture({ source: premultipliedSource, frame: source.frame });
  }
  if (CanvasSource.test(resource)) {
    const premultipliedSource = new CanvasSource({
      resource,
      alphaMode: "premultiplied-alpha",
    });
    return new Texture({ source: premultipliedSource, frame: source.frame });
  }
  return source;
}

/**
 * Tier-0 BAKE — evaluate a STATIC material graph per-texel against `source` and
 * return a derived `Texture` (techspec §6.1 Tier-0). This is the generalization
 * of `createDerivedAlphaTexture`: instead of only rewriting the alpha channel
 * from an opacity source, it runs the full per-texel graph evaluator
 * (`bakeGraphInPlace`) over the source pixels.
 *
 * It mirrors `createDerivedAlphaTexture` bit-for-bit in its canvas plumbing
 * (frame-aware draw, `willReadFrequently`, tainted-canvas fallback to `null`) so
 * the renderer can cache the result keyed by the compiler's `bakeHash`
 * (`derivedTextureCacheKey(uid, opacitySource, invert, materialBakeHash)`).
 * Returns `null` when no DOM canvas is available or the source has no readable
 * pixels (headless tests), so the caller falls back to the source texture.
 *
 * NOTE: this is a NEW function; `createDerivedAlphaTexture` above is unchanged
 * and remains the legacy alpha-derivation path.
 */
export function createMaterialBakeTexture(
  source: Texture,
  graph: ShaderGraph,
  instance: MaterialInstance,
  options?: {
    documentRef?: CanvasFactory;
    samplerForPath?: BakeTextureSampler;
  },
): Texture | null {
  const doc =
    options?.documentRef ??
    (typeof document !== "undefined" ? document : undefined);
  if (!doc) return null;

  const textureSource = source.source;
  const resource = textureSource?.resource as CanvasImageSource | undefined;
  const frame = source.frame;
  const sourceX = frame?.x ?? 0;
  const sourceY = frame?.y ?? 0;
  const width = frame?.width ?? textureSource?.pixelWidth ?? 0;
  const height = frame?.height ?? textureSource?.pixelHeight ?? 0;
  if (!resource || width <= 0 || height <= 0) return null;

  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  try {
    context.drawImage(
      resource,
      sourceX,
      sourceY,
      width,
      height,
      0,
      0,
      width,
      height,
    );
    const image = context.getImageData(0, 0, width, height);
    bakeGraphInPlace(image.data, width, height, graph, instance, {
      samplerForPath: options?.samplerForPath,
    });
    context.putImageData(image, 0, 0);
  } catch {
    // Tainted canvas or an unsupported resource type — fall back to the source.
    return null;
  }

  return Texture.from(canvas);
}
