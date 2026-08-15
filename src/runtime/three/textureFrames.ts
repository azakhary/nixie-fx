import {
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  type Texture,
} from "three";
import type { ParticleEmitterDefinition } from "../../engine/particles";
import type { MaterialFixedDescriptor } from "../materials/artifact";
import { sampleTextureSheetAnimationFrame } from "../modules";

interface ThreeTextureFrame {
  texture: Texture | null;
  offsetX: number;
  offsetY: number;
  repeatX: number;
  repeatY: number;
  centerX: number;
  centerY: number;
  rotation: number;
}

export interface ThreeTextureFrameSet {
  mapFrames: ThreeTextureFrame[];
  alphaMapFrames: ThreeTextureFrame[];
  shaderMap: Texture | null;
  ownedTextures: Texture[];
}

export function createThreeTextureFrameSet(
  map: Texture | null,
  alphaMap: Texture | null,
  emitter: ParticleEmitterDefinition,
  materialFixed: MaterialFixedDescriptor | null,
): ThreeTextureFrameSet {
  const dynamicUv = hasMaterialAnimatedUv(materialFixed);
  if (!emitter.modules.textureSheetAnimation) {
    const mapFrames = [createTextureFrame(map, dynamicUv)];
    const alphaMapFrames = [createTextureFrame(alphaMap, dynamicUv)];
    return {
      mapFrames,
      alphaMapFrames,
      shaderMap: map,
      ownedTextures: dynamicUv
        ? [...ownedTexturesOf(mapFrames), ...ownedTexturesOf(alphaMapFrames)]
        : [],
    };
  }

  const settings = emitter.advanced.textureSheetAnimation;
  const tilesX = Math.max(1, Math.round(settings.tiles[0]));
  const tilesY = Math.max(1, Math.round(settings.tiles[1]));
  const totalFrames = tilesX * tilesY;
  if (totalFrames <= 1) {
    const mapFrames = [createTextureFrame(map, dynamicUv)];
    const alphaMapFrames = [createTextureFrame(alphaMap, dynamicUv)];
    return {
      mapFrames,
      alphaMapFrames,
      shaderMap: map,
      ownedTextures: dynamicUv
        ? [...ownedTexturesOf(mapFrames), ...ownedTexturesOf(alphaMapFrames)]
        : [],
    };
  }

  const mapFrames = createSheetFrames(map, tilesX, tilesY);
  const alphaMapFrames = createSheetFrames(alphaMap, tilesX, tilesY);
  return {
    mapFrames,
    alphaMapFrames,
    shaderMap: map,
    ownedTextures: [
      ...ownedTexturesOf(mapFrames),
      ...ownedTexturesOf(alphaMapFrames),
    ],
  };
}

export function selectThreeTextureFrameIndex(
  emitter: ParticleEmitterDefinition,
  normalizedAge: number,
  seed: number,
  loopAge: number,
): number {
  if (!emitter.modules.textureSheetAnimation) return 0;
  return sampleTextureSheetAnimationFrame(
    emitter.advanced.textureSheetAnimation,
    normalizedAge,
    seed,
    loopAge,
  ).frame;
}

export function applyThreeTextureFrame(
  material: MeshBasicMaterial | MeshStandardMaterial,
  frames: ThreeTextureFrameSet,
  frameIndex: number,
  materialFixed: MaterialFixedDescriptor | null,
  timeSeconds: number,
): void {
  const mapFrame = selectFrame(frames.mapFrames, frameIndex);
  const alphaFrame = selectFrame(frames.alphaMapFrames, frameIndex);
  const map = mapFrame.texture;
  const alphaMap = alphaFrame.texture;

  applyAnimatedUv(mapFrame, materialFixed, timeSeconds);
  applyAnimatedUv(alphaFrame, materialFixed, timeSeconds);

  if (material.map !== map) {
    material.map = map;
    material.needsUpdate = true;
  }
  if (material.alphaMap !== alphaMap) {
    material.alphaMap = alphaMap;
    material.alphaTest = alphaMap ? 0.001 : 0;
    material.needsUpdate = true;
  }
}

export function applyThreeShaderTextureFrame(
  material: ShaderMaterial,
  frames: ThreeTextureFrameSet,
  frameIndex: number,
  materialFixed: MaterialFixedDescriptor | null,
  timeSeconds: number,
): void {
  const mapFrame = selectFrame(frames.mapFrames, frameIndex);
  applyAnimatedUv(mapFrame, materialFixed, timeSeconds);
  const subUv = material.uniforms.uSubUv?.value as
    { set: (x: number, y: number, z: number, w: number) => void } | undefined;
  const texture = mapFrame.texture;
  if (subUv) {
    subUv.set(
      texture?.offset.x ?? mapFrame.offsetX,
      texture?.offset.y ?? mapFrame.offsetY,
      texture?.repeat.x ?? mapFrame.repeatX,
      texture?.repeat.y ?? mapFrame.repeatY,
    );
    material.uniformsNeedUpdate = true;
  }
  const uniform = material.uniforms.uTexture;
  const shaderMap = frames.shaderMap ?? mapFrame.texture;
  if (uniform && uniform.value !== shaderMap) {
    uniform.value = shaderMap;
    material.uniformsNeedUpdate = true;
  }
}

function createSheetFrames(
  texture: Texture | null,
  tilesX: number,
  tilesY: number,
): ThreeTextureFrame[] {
  if (!texture) return [createTextureFrame(null, false)];
  const frames: ThreeTextureFrame[] = [];
  for (let frame = 0; frame < tilesX * tilesY; frame++) {
    const column = frame % tilesX;
    const row = Math.floor(frame / tilesX);
    frames.push(
      createTextureFrame(texture, true, {
        offsetX: texture.offset.x + (column * texture.repeat.x) / tilesX,
        offsetY:
          texture.offset.y + ((tilesY - row - 1) * texture.repeat.y) / tilesY,
        repeatX: texture.repeat.x / tilesX,
        repeatY: texture.repeat.y / tilesY,
      }),
    );
  }
  return frames;
}

function createTextureFrame(
  texture: Texture | null,
  clone: boolean,
  overrides?: {
    offsetX: number;
    offsetY: number;
    repeatX: number;
    repeatY: number;
  },
): ThreeTextureFrame {
  const frameTexture = clone && texture ? texture.clone() : texture;
  if (clone && frameTexture) frameTexture.needsUpdate = true;
  return {
    texture: frameTexture,
    offsetX: overrides?.offsetX ?? frameTexture?.offset.x ?? 0,
    offsetY: overrides?.offsetY ?? frameTexture?.offset.y ?? 0,
    repeatX: overrides?.repeatX ?? frameTexture?.repeat.x ?? 1,
    repeatY: overrides?.repeatY ?? frameTexture?.repeat.y ?? 1,
    centerX: frameTexture?.center.x ?? 0,
    centerY: frameTexture?.center.y ?? 0,
    rotation: frameTexture?.rotation ?? 0,
  };
}

function ownedTexturesOf(frames: ThreeTextureFrame[]): Texture[] {
  return frames
    .map((frame) => frame.texture)
    .filter((texture): texture is Texture => !!texture);
}

function selectFrame(
  frames: ThreeTextureFrame[],
  frameIndex: number,
): ThreeTextureFrame {
  return frames[positiveModulo(frameIndex, frames.length)] ?? frames[0]!;
}

function applyAnimatedUv(
  frame: ThreeTextureFrame,
  materialFixed: MaterialFixedDescriptor | null,
  timeSeconds: number,
): void {
  const texture = frame.texture;
  if (!texture) return;
  const pan = materialFixed?.uvPan;
  const rotate = materialFixed?.uvRotate;
  texture.repeat.set(frame.repeatX, frame.repeatY);
  texture.offset.set(
    frame.offsetX + (pan?.speed[0] ?? 0) * timeSeconds * frame.repeatX,
    frame.offsetY + (pan?.speed[1] ?? 0) * timeSeconds * frame.repeatY,
  );
  if (rotate) {
    texture.center.set(
      frame.offsetX + rotate.center[0] * frame.repeatX,
      frame.offsetY + rotate.center[1] * frame.repeatY,
    );
    texture.rotation = rotate.speed * timeSeconds * Math.PI * 2;
  } else {
    texture.center.set(frame.centerX, frame.centerY);
    texture.rotation = frame.rotation;
  }
}

function hasMaterialAnimatedUv(
  materialFixed: MaterialFixedDescriptor | null,
): boolean {
  const pan = materialFixed?.uvPan;
  const rotate = materialFixed?.uvRotate;
  return Boolean(
    (pan &&
      (Math.abs(pan.speed[0]) > 0.000001 ||
        Math.abs(pan.speed[1]) > 0.000001)) ||
    (rotate && Math.abs(rotate.speed) > 0.000001),
  );
}

function positiveModulo(value: number, divisor: number): number {
  if (divisor <= 0) return 0;
  return ((value % divisor) + divisor) % divisor;
}
