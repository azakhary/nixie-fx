import { ShaderMaterial, SRGBColorSpace, Vector3, type Camera } from "three";
import type { Vec3, Vec4 } from "../../engine/math";
import {
  sampleParticleGradientAlpha,
  sampleParticleGradientColor,
  type ParticleEmitterDefinition,
} from "../../engine/particles";
import { ParticleScalarValueSampler } from "../../engine/ParticleScalarValueSampler";
import type { ParticleScalarValue } from "../../engine/particles";
import { UnityTrailSet } from "../unityTrail";
import { applyThreeTextureFrame } from "./textureFrames";
import {
  clearThreeTrailGeometry,
  ensureTrailBuffers,
  updateTrailBounds,
  type ThreeTrailView,
} from "./trailGeometry";
import type { ParticleSample } from "./rendererState";

const WHITE: Vec4 = [1, 1, 1, 1];
const segmentA = new Vector3();
const toCamera = new Vector3();
const sideA = new Vector3();
const sideB = new Vector3();
const lastSide = new Vector3(0, 1, 0);
const lifetimeColor: Vec4 = [1, 1, 1, 1];
/** Exact prepared width-over-trail sampler, rebuilt when the authored value changes. */
const widthSamplers = new WeakMap<
  ParticleScalarValue,
  { signature: string; sampler: ParticleScalarValueSampler }
>();
function widthSampler(value: ParticleScalarValue): ParticleScalarValueSampler {
  const signature = JSON.stringify(value);
  let entry = widthSamplers.get(value);
  if (!entry || entry.signature !== signature) {
    entry = { signature, sampler: new ParticleScalarValueSampler(value) };
    widthSamplers.set(value, entry);
  }
  return entry.sampler;
}
const constantTrailColor: Vec4 = [1, 1, 1, 1];
const previousDirection = new Vector3();
const nextDirection = new Vector3();
/** sRGB → working-space memo: consecutive ribbon points usually repeat colors. */
const linearInput: Vec4 = [Number.NaN, 0, 0, 0];
const linearOutput: Vec4 = [1, 1, 1, 1];

/** Begin a Unity-model frame for this view's emitter state generation. */
export function beginThreeUnityTrails(
  view: ThreeTrailView,
  generation: number,
): void {
  (view.unityTrails ??= new UnityTrailSet()).begin(generation);
}

/** Record one sampled particle. Called before the particle surface is culled. */
export function updateThreeUnityTrail(
  view: ThreeTrailView,
  emitter: ParticleEmitterDefinition,
  sample: ParticleSample,
  timeSeconds: number,
): void {
  const settings = emitter.advanced.trails;
  if (sample.seed >= settings.ratio) return;
  const resolved = !!view.trailResolution;
  (view.unityTrails ??= new UnityTrailSet()).touch(
    settings,
    sample.particleId,
    sample.position[0],
    sample.position[1],
    sample.position[2],
    timeSeconds,
    sample.lifetime,
    sample.normalizedAge,
    sample.loopAge,
    sample.seed,
    sample.width,
    settings.inheritColor
      ? resolved
        ? sample.trailColor[0]
        : sample.color.r
      : 1,
    settings.inheritColor
      ? resolved
        ? sample.trailColor[1]
        : sample.color.g
      : 1,
    settings.inheritColor
      ? resolved
        ? sample.trailColor[2]
        : sample.color.b
      : 1,
    settings.inheritColor
      ? resolved
        ? sample.trailColor[3]
        : sample.alpha
      : 1,
  );
}

/**
 * Build every Unity-model ribbon of the emitter into the view's single trail
 * draw. Ribbon parameter t is head-to-tail distance over total length; width
 * is trail width × widthOverTrail(t); color is particle color ×
 * colorOverLifetime(particle age) × colorOverTrail(t). No implicit fades.
 */
export function drawThreeUnityTrailView(
  view: ThreeTrailView,
  emitter: ParticleEmitterDefinition,
  camera: Camera,
  timeSeconds: number,
  effectPosition: Vec3,
): void {
  const set = view.unityTrails;
  const settings = emitter.advanced.trails;
  if (!set) {
    clearThreeTrailGeometry(view);
    return;
  }
  set.end(settings, timeSeconds);
  let requiredVertices = 0;
  for (const trail of set.trails.values())
    requiredVertices += (trail.pointCount + 2) * 2;
  if (requiredVertices === 0) {
    clearThreeTrailGeometry(view);
    return;
  }
  const buffers = ensureTrailBuffers(view, requiredVertices);
  const positions = buffers.position.array;
  const colors = buffers.color.array;
  const uvs = buffers.uv.array;
  const normals = buffers.normal.array;
  const dynamicParams = buffers.dynamicParams.array;
  const indices = buffers.index.array;
  const resolution = view.trailResolution;
  resolution?.updateTime?.(timeSeconds);
  const shader =
    view.trailMaterial instanceof ShaderMaterial || !!resolution?.updateTime;
  if (
    view.trailMaterial instanceof ShaderMaterial &&
    view.trailMaterial.uniforms.uTime
  )
    view.trailMaterial.uniforms.uTime.value = timeSeconds;
  if (
    view.trailTextureFrames &&
    !(view.trailMaterial instanceof ShaderMaterial)
  )
    applyThreeTextureFrame(
      view.trailMaterial,
      view.trailTextureFrames,
      0,
      resolution?.fixed ?? null,
      timeSeconds,
    );
  const srgb = buffers.srgbColor;
  const rgba = buffers.trailColor;
  // A gradient whose stops share one RGB needs no per-point color sample.
  const trailStops = settings.colorOverTrail.colorStops;
  const constantRgb = trailStops.every(
    (stop) =>
      stop.color[0] === trailStops[0]!.color[0] &&
      stop.color[1] === trailStops[0]!.color[1] &&
      stop.color[2] === trailStops[0]!.color[2],
  );
  if (constantRgb)
    sampleParticleGradientColor(settings.colorOverTrail, 0, constantTrailColor);
  linearInput[0] = Number.NaN;
  const widthOverTrail = widthSampler(settings.widthOverTrail);
  let vertexCount = 0;
  let indexCount = 0;
  for (const trail of set.trails.values()) {
    const centers = set.ensureCenters(trail.pointCount);
    const count = trail.sampleCenters(timeSeconds, centers);
    if (count < 2) continue;
    let total = 0;
    for (let i = 1; i < count; i++) total += centerDistance(centers, i - 1, i);
    if (total <= 1e-7) continue;
    lastSide.set(0, 1, 0);
    previousDirection.set(0, 0, 0);
    // Color over lifetime depends only on particle age: one sample per trail.
    sampleParticleGradientColor(
      settings.colorOverLifetime,
      trail.normalizedAge,
      lifetimeColor,
    );
    lifetimeColor[3] = sampleParticleGradientAlpha(
      settings.colorOverLifetime,
      trail.normalizedAge,
    );
    const startVertex = vertexCount;
    let distance = 0;
    for (let i = 0; i < count; i++) {
      if (i > 0) distance += centerDistance(centers, i - 1, i);
      const t = distance / total;
      const c = i * 3;
      const cx = centers[c]!;
      const cy = centers[c + 1]!;
      const cz = centers[c + 2]!;
      if (constantRgb) {
        rgba[0] = constantTrailColor[0];
        rgba[1] = constantTrailColor[1];
        rgba[2] = constantTrailColor[2];
      } else sampleParticleGradientColor(settings.colorOverTrail, t, rgba);
      rgba[0] *= lifetimeColor[0];
      rgba[1] *= lifetimeColor[1];
      rgba[2] *= lifetimeColor[2];
      rgba[3] =
        lifetimeColor[3] *
        sampleParticleGradientAlpha(settings.colorOverTrail, t);
      if (!resolution) {
        if (
          rgba[0] !== linearInput[0] ||
          rgba[1] !== linearInput[1] ||
          rgba[2] !== linearInput[2]
        ) {
          linearInput[0] = rgba[0];
          linearInput[1] = rgba[1];
          linearInput[2] = rgba[2];
          srgb.setRGB(rgba[0], rgba[1], rgba[2], SRGBColorSpace);
          linearOutput[0] = srgb.r;
          linearOutput[1] = srgb.g;
          linearOutput[2] = srgb.b;
        }
        rgba[0] = linearOutput[0];
        rgba[1] = linearOutput[1];
        rgba[2] = linearOutput[2];
      }
      let r = trail.color[0]! * rgba[0];
      let g = trail.color[1]! * rgba[1];
      let b = trail.color[2]! * rgba[2];
      let alpha = trail.color[3]! * rgba[3];
      if (resolution) {
        const usage = resolution.particleColorUsage;
        if (!usage.rgb) r = g = b = 1;
        if (!usage.alpha) alpha = 1;
        if (!shader) {
          const fixed = resolution.fixed;
          const tint = fixed?.tint ?? WHITE;
          const emissive = 1 + Math.max(0, fixed?.emissive ?? 0);
          srgb.setRGB(
            r * tint[0]! * emissive,
            g * tint[1]! * emissive,
            b * tint[2]! * emissive,
            SRGBColorSpace,
          );
          r = srgb.r;
          g = srgb.g;
          b = srgb.b;
          alpha *= tint[3]! * (fixed?.opacity ?? 1);
        }
      }
      const halfWidth =
        0.5 * trail.width * Math.max(0, widthOverTrail.sample(t, trail.seed));
      toCamera.set(
        camera.position.x - cx,
        camera.position.y - cy,
        camera.position.z - cz,
      );
      if (toCamera.lengthSq() <= 1e-14) toCamera.set(0, 0, 1);
      toCamera.normalize();
      // Side is the normalized mean of the adjacent segment sides (head → tail).
      // Each segment direction is normalized once and reused by both endpoints.
      const hasPrevious = i > 0 && previousDirection.lengthSq() > 0;
      if (i < count - 1) segmentDirection(centers, i, i + 1, nextDirection);
      else nextDirection.set(0, 0, 0);
      sideA.set(0, 0, 0);
      if (hasPrevious && sideFacing(previousDirection, sideB)) sideA.add(sideB);
      if (nextDirection.lengthSq() > 0 && sideFacing(nextDirection, sideB))
        sideA.add(sideB);
      previousDirection.copy(nextDirection);
      if (sideA.lengthSq() <= 1e-14) sideA.copy(lastSide);
      else sideA.normalize();
      lastSide.copy(sideA);
      const offset = vertexCount * 3;
      positions[offset] = cx + sideA.x * halfWidth - effectPosition[0];
      positions[offset + 1] = cy + sideA.y * halfWidth - effectPosition[1];
      positions[offset + 2] = cz + sideA.z * halfWidth - effectPosition[2];
      positions[offset + 3] = cx - sideA.x * halfWidth - effectPosition[0];
      positions[offset + 4] = cy - sideA.y * halfWidth - effectPosition[1];
      positions[offset + 5] = cz - sideA.z * halfWidth - effectPosition[2];
      const u = settings.textureMode === "tile" ? distance : t;
      for (let k = 0; k < 2; k++) {
        const vertex = vertexCount + k;
        colors[vertex * 4] = r;
        colors[vertex * 4 + 1] = g;
        colors[vertex * 4 + 2] = b;
        colors[vertex * 4 + 3] = alpha;
        uvs[vertex * 2] = u;
        uvs[vertex * 2 + 1] = 1 - k;
        normals[vertex * 3] = toCamera.x;
        normals[vertex * 3 + 1] = toCamera.y;
        normals[vertex * 3 + 2] = toCamera.z;
        dynamicParams[vertex * 4] = 0;
        dynamicParams[vertex * 4 + 1] = 0;
        dynamicParams[vertex * 4 + 2] = 0;
        dynamicParams[vertex * 4 + 3] = 0;
      }
      vertexCount += 2;
    }
    for (let i = 0; i < count - 1; i++) {
      const a = startVertex + i * 2;
      indices[indexCount++] = a;
      indices[indexCount++] = a + 1;
      indices[indexCount++] = a + 2;
      indices[indexCount++] = a + 1;
      indices[indexCount++] = a + 3;
      indices[indexCount++] = a + 2;
    }
  }
  view.trailGeometry.setDrawRange(0, indexCount);
  if (indexCount === 0) {
    clearThreeTrailGeometry(view);
    return;
  }
  buffers.position.needsUpdate = true;
  buffers.color.needsUpdate = true;
  buffers.index.needsUpdate = true;
  buffers.uv.needsUpdate = true;
  buffers.normal.needsUpdate = true;
  buffers.dynamicParams.needsUpdate = true;
  updateTrailBounds(view.trailGeometry, buffers, vertexCount);
  view.trailMesh.visible = true;
}

function centerDistance(centers: Float32Array, a: number, b: number): number {
  const dx = centers[b * 3]! - centers[a * 3]!;
  const dy = centers[b * 3 + 1]! - centers[a * 3 + 1]!;
  const dz = centers[b * 3 + 2]! - centers[a * 3 + 2]!;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Unit direction of segment a → b, or zero for a degenerate segment. */
function segmentDirection(
  centers: Float32Array,
  a: number,
  b: number,
  out: Vector3,
): void {
  segmentA.set(centers[a * 3]!, centers[a * 3 + 1]!, centers[a * 3 + 2]!);
  out.set(centers[b * 3]!, centers[b * 3 + 1]!, centers[b * 3 + 2]!);
  out.sub(segmentA);
  if (out.lengthSq() <= 1e-14) out.set(0, 0, 0);
  else out.normalize();
}

/** Unit side of a segment direction facing `toCamera`; false when parallel. */
function sideFacing(direction: Vector3, out: Vector3): boolean {
  out.crossVectors(direction, toCamera);
  if (out.lengthSq() <= 1e-14) return false;
  out.normalize();
  return true;
}
