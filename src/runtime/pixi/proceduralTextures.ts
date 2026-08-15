import { Texture } from "pixi.js";
import type {
  PixiVfxFallbackTextures,
  PixiVfxProceduralTextureOptions,
} from "./types";

const DEFAULT_TEXTURE_SIZE = 96;

export function createPixiVfxProceduralTextures(
  options: PixiVfxProceduralTextureOptions = {},
): PixiVfxFallbackTextures {
  const size = Math.max(4, Math.round(options.size ?? DEFAULT_TEXTURE_SIZE));
  const documentRef = options.document ?? document;
  return {
    circle: createParticleTexture(documentRef, size, drawCircleTexture),
    square: createParticleTexture(documentRef, size, drawSquareTexture),
    triangleShard: createParticleTexture(
      documentRef,
      size,
      drawTriangleTexture,
    ),
    quadShard: createParticleTexture(documentRef, size, drawQuadTexture),
    grassShard: createParticleTexture(documentRef, size, drawShardTexture),
  };
}

export function destroyPixiVfxProceduralTextures(
  textures: PixiVfxFallbackTextures,
): void {
  for (const texture of Object.values(textures)) {
    texture.destroy(true);
  }
}

function createParticleTexture(
  documentRef: Pick<Document, "createElement">,
  size: number,
  draw: (context: CanvasRenderingContext2D, size: number) => void,
): Texture {
  const canvas = documentRef.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create particle texture context");
  draw(context, size);
  return Texture.from(canvas);
}

function drawCircleTexture(
  context: CanvasRenderingContext2D,
  size: number,
): void {
  const center = size * 0.5;
  const radius = size * 0.44;
  const gradient = context.createRadialGradient(
    center,
    center,
    radius * 0.12,
    center,
    center,
    radius,
  );
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.72, "rgba(255,255,255,0.82)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.fill();
}

function drawSquareTexture(
  context: CanvasRenderingContext2D,
  size: number,
): void {
  context.fillStyle = "white";
  context.fillRect(size * 0.08, size * 0.08, size * 0.84, size * 0.84);
}

function drawTriangleTexture(
  context: CanvasRenderingContext2D,
  size: number,
): void {
  context.fillStyle = "white";
  context.beginPath();
  context.moveTo(size * 0.5, size * 0.08);
  context.lineTo(size * 0.92, size * 0.86);
  context.lineTo(size * 0.08, size * 0.86);
  context.closePath();
  context.fill();
}

function drawQuadTexture(
  context: CanvasRenderingContext2D,
  size: number,
): void {
  context.fillStyle = "white";
  context.beginPath();
  context.moveTo(size * 0.28, size * 0.1);
  context.lineTo(size * 0.78, size * 0.18);
  context.lineTo(size * 0.72, size * 0.9);
  context.lineTo(size * 0.22, size * 0.82);
  context.closePath();
  context.fill();
}

function drawShardTexture(
  context: CanvasRenderingContext2D,
  size: number,
): void {
  context.fillStyle = "white";
  context.beginPath();
  context.moveTo(size * 0.5, size * 0.04);
  context.lineTo(size * 0.66, size * 0.48);
  context.lineTo(size * 0.58, size * 0.96);
  context.lineTo(size * 0.34, size * 0.52);
  context.closePath();
  context.fill();
}
