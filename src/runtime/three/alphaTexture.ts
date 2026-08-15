import { CanvasTexture, Texture } from "three";
import type { ParticleOpacitySource } from "../../engine/particles";
import {
  deriveAlphaInPlace,
  opacitySourceNeedsDerivation,
} from "../assets/derivedTextures";

type CanvasFactory = Pick<Document, "createElement">;

export function threeAlphaMapFromOpacitySource(
  source: Texture,
  opacitySource: ParticleOpacitySource,
  invert: boolean,
  documentRef?: CanvasFactory,
): { texture: Texture | null; owned: boolean } {
  if (!opacitySourceNeedsDerivation(opacitySource)) {
    return { texture: null, owned: false };
  }
  if (opacitySource !== "constant") {
    const derived = createThreeDerivedAlphaTexture(
      source,
      opacitySource,
      invert,
      documentRef,
    );
    if (derived) return { texture: derived, owned: true };
  }
  if (opacitySource === "constant") return { texture: null, owned: false };
  if (invert) return { texture: null, owned: false };
  return { texture: source, owned: false };
}

function createThreeDerivedAlphaTexture(
  source: Texture,
  opacitySource: ParticleOpacitySource,
  invert: boolean,
  documentRef?: CanvasFactory,
): Texture | null {
  const doc =
    documentRef ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return null;

  const image = source.image as CanvasImageSource | undefined;
  const width = canvasImageWidth(image);
  const height = canvasImageHeight(image);
  if (!image || width <= 0 || height <= 0) return null;

  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  try {
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height);
    deriveAlphaInPlace(data.data, opacitySource, invert);
    context.putImageData(data, 0, 0);
  } catch {
    return null;
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = source.colorSpace;
  texture.flipY = source.flipY;
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.minFilter = source.minFilter;
  texture.magFilter = source.magFilter;
  texture.generateMipmaps = source.generateMipmaps;
  texture.needsUpdate = true;
  return texture;
}

function canvasImageWidth(image: CanvasImageSource | undefined): number {
  if (!image) return 0;
  if ("naturalWidth" in image && typeof image.naturalWidth === "number") {
    return image.naturalWidth;
  }
  if ("videoWidth" in image && typeof image.videoWidth === "number") {
    return image.videoWidth;
  }
  if ("width" in image && typeof image.width === "number") return image.width;
  return 0;
}

function canvasImageHeight(image: CanvasImageSource | undefined): number {
  if (!image) return 0;
  if ("naturalHeight" in image && typeof image.naturalHeight === "number") {
    return image.naturalHeight;
  }
  if ("videoHeight" in image && typeof image.videoHeight === "number") {
    return image.videoHeight;
  }
  if ("height" in image && typeof image.height === "number")
    return image.height;
  return 0;
}
