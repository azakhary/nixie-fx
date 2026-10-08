import {
  Color,
  BufferAttribute,
  DynamicDrawUsage,
  Sphere,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Mesh,
} from "three";
import {
  sampleParticleGradientAlpha,
  sampleParticleGradientColor,
  sampleParticleScalarValue,
  type ParticleEmitterDefinition,
} from "../../engine/particles";
import type { Vec3, Vec4 } from "../../engine/math";
import { sampleIndependentTrailColor } from "../trailColor";
import { PARTICLE_ALIGNMENT_AXIS } from "../particleOrientation";
import type {
  ThreeEmitterMaterialResolution,
  ThreeParticleMaterial,
} from "./materialAdapter";
import {
  applyThreeTextureFrame,
  type ThreeTextureFrameSet,
} from "./textureFrames";
const DEFAULT_UP = new Vector3(...PARTICLE_ALIGNMENT_AXIS);
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export interface ThreeTrailView {
  trailMesh: Mesh;
  trailGeometry: BufferGeometry;
  trailMaterial: ThreeParticleMaterial;
  trailResolution: ThreeEmitterMaterialResolution | null;
  trailTextureFrames: ThreeTextureFrameSet | null;
  trailHistories: Map<string, ThreeTrailHistory>;
  trailEmitterPosition: Vec3;
  /** Retained high-water storage, released with the owning emitter view. */
  trailBuffers?: ThreeTrailBuffers;
  trailPointPool?: ThreeTrailPoint[];
}

export interface ThreeTrailPoint {
  dynamicParams: [number, number, number, number] | null;
  position: Vector3;
  timeSeconds: number;
  lifetimeSeconds: number;
  distanceFromHead: number;
  color: [number, number, number];
  alpha: number;
  width: number;
  maxLength?: number;
  seed: number;
}

interface ThreeTrailHistory {
  points: ThreeTrailPoint[];
  lastSeenFrame: number;
}

export function drawThreeTrailView(
  view: ThreeTrailView,
  emitter: ParticleEmitterDefinition,
  camera: Camera,
  timeSeconds: number,
  effectPosition: Vec3,
): void {
  if (!emitter.modules.trails) {
    clearThreeTrailView(view);
    return;
  }
  const pool = (view.trailPointPool ??= []);
  let requiredVertices = 0;
  for (const [key, history] of view.trailHistories) {
    pruneThreeTrailPoints(history.points, undefined, timeSeconds, pool);
    if (history.points.length === 0) view.trailHistories.delete(key);
    else if (history.points.length >= 2)
      requiredVertices += history.points.length * 2;
  }
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
  let vertexCount = 0;
  let indexCount = 0;
  const settings = emitter.advanced.trails;
  const trailColor = buffers.trailColor;
  const resolution = view.trailResolution;
  const shader = view.trailMaterial instanceof ShaderMaterial;
  if (
    view.trailMaterial instanceof ShaderMaterial &&
    view.trailMaterial.uniforms.uTime
  ) {
    view.trailMaterial.uniforms.uTime.value = timeSeconds;
  }
  if (
    view.trailTextureFrames &&
    !(view.trailMaterial instanceof ShaderMaterial)
  ) {
    applyThreeTextureFrame(
      view.trailMaterial,
      view.trailTextureFrames,
      0,
      resolution?.fixed ?? null,
      timeSeconds,
    );
  }
  const srgbColor = buffers.srgbColor;
  for (const history of view.trailHistories.values()) {
    if (history.points.length < 2) continue;
    const points = history.points;
    const fallbackLength = Math.max(points[0]?.distanceFromHead ?? 1, 1);
    const startVertex = vertexCount;
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      const next = points[Math.min(i + 1, points.length - 1)] ?? point;
      const prev = points[Math.max(i - 1, 0)] ?? point;
      const maxLength = point.maxLength;
      if (maxLength !== undefined && point.distanceFromHead > maxLength)
        continue;
      const trailT = clamp(
        point.distanceFromHead / (maxLength ?? fallbackLength),
        0,
        1,
      );
      const ageFade =
        1 -
        clamp((timeSeconds - point.timeSeconds) / point.lifetimeSeconds, 0, 1);
      let r = point.color[0];
      let g = point.color[1];
      let b = point.color[2];
      let alpha = point.alpha;
      if (!settings.inheritColor) {
        const rgba = sampleIndependentTrailColor(
          settings,
          1 - ageFade,
          trailT,
          trailColor,
        );
        srgbColor.setRGB(
          rgba[0],
          rgba[1],
          rgba[2],
          resolution ? undefined : SRGBColorSpace,
        );
        r = srgbColor.r;
        g = srgbColor.g;
        b = srgbColor.b;
        alpha = rgba[3];
      } else if (settings.color) {
        const rgb = sampleParticleGradientColor(
          settings.color,
          trailT,
          trailColor,
        );
        srgbColor.setRGB(
          rgb[0],
          rgb[1],
          rgb[2],
          resolution ? undefined : SRGBColorSpace,
        );
        r = srgbColor.r;
        g = srgbColor.g;
        b = srgbColor.b;
        alpha = sampleParticleGradientAlpha(settings.color, trailT);
      }
      if (resolution) {
        if (!resolution.particleColorUsage.rgb) {
          r = 1;
          g = 1;
          b = 1;
        }
        if (!resolution.particleColorUsage.alpha) alpha = 1;
      }
      if (resolution && !shader) {
        const usage = resolution.particleColorUsage;
        const fixed = resolution.fixed;
        const tint = fixed?.tint ?? WHITE;
        const emissive = 1 + Math.max(0, fixed?.emissive ?? 0);
        srgbColor.setRGB(
          (usage.rgb ? r : 1) * tint[0]! * emissive,
          (usage.rgb ? g : 1) * tint[1]! * emissive,
          (usage.rgb ? b : 1) * tint[2]! * emissive,
          SRGBColorSpace,
        );
        r = srgbColor.r;
        g = srgbColor.g;
        b = srgbColor.b;
        alpha = (usage.alpha ? alpha : 1) * tint[3]! * (fixed?.opacity ?? 1);
      }
      alpha *= (1 - trailT) * ageFade;
      const width =
        point.width *
        Math.max(
          0,
          sampleParticleScalarValue(
            settings.widthOverTrail,
            trailT,
            point.seed,
          ),
        );
      if (alpha <= 0.01 || width <= 0.0001) continue;
      const dir = buffers.direction.subVectors(next.position, prev.position);
      if (dir.lengthSq() <= 0.0000001) dir.set(0, 1, 0);
      dir.normalize();
      const viewDir = buffers.viewDirection.subVectors(
        camera.position,
        point.position,
      );
      if (viewDir.lengthSq() <= 0.0000001) viewDir.set(0, 0, 1);
      viewDir.normalize();
      const side = buffers.side.crossVectors(dir, viewDir);
      if (side.lengthSq() <= 0.0000001) side.copy(DEFAULT_UP);
      side.normalize().multiplyScalar(width * 0.5);
      // History remains in simulation world space; vertices are effect-local.
      const offset = vertexCount * 3;
      positions[offset] = point.position.x - side.x - effectPosition[0];
      positions[offset + 1] = point.position.y - side.y - effectPosition[1];
      positions[offset + 2] = point.position.z - side.z - effectPosition[2];
      positions[offset + 3] = point.position.x + side.x - effectPosition[0];
      positions[offset + 4] = point.position.y + side.y - effectPosition[1];
      positions[offset + 5] = point.position.z + side.z - effectPosition[2];
      for (let vertex = vertexCount; vertex < vertexCount + 2; vertex++) {
        colors[vertex * 4] = r;
        colors[vertex * 4 + 1] = g;
        colors[vertex * 4 + 2] = b;
        colors[vertex * 4 + 3] = alpha;
        if (resolution) {
          uvs[vertex * 2] =
            settings.textureMode === "tile"
              ? point.distanceFromHead
              : point.distanceFromHead /
                Math.max(points[0]!.distanceFromHead, 0.000001);
          uvs[vertex * 2 + 1] = vertex - vertexCount;
          for (let channel = 0; channel < 4; channel++)
            dynamicParams[vertex * 4 + channel] =
              point.dynamicParams?.[channel] ?? 0;
          normals[vertex * 3] = viewDir.x;
          normals[vertex * 3 + 1] = viewDir.y;
          normals[vertex * 3 + 2] = viewDir.z;
        }
      }
      vertexCount += 2;
    }
    const historyVertexCount = vertexCount - startVertex;
    for (let i = 0; i < historyVertexCount / 2 - 1; i++) {
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
  if (resolution) {
    buffers.dynamicParams.needsUpdate = true;
    buffers.uv.needsUpdate = true;
    buffers.normal.needsUpdate = true;
  }
  updateTrailBounds(view.trailGeometry, buffers, vertexCount);
  view.trailMesh.visible = true;
}

export function clearThreeTrailView(view: ThreeTrailView): void {
  const pool = (view.trailPointPool ??= []);
  for (const history of view.trailHistories.values()) {
    for (const point of history.points) pool.push(point);
  }
  view.trailHistories.clear();
  clearThreeTrailGeometry(view);
}

function clearThreeTrailGeometry(view: ThreeTrailView): void {
  view.trailMesh.visible = false;
  // Keep the high-water allocation ready for the next burst; stale capacity
  // vertices are never submitted because the live index range is empty.
  view.trailGeometry.setDrawRange(0, 0);
}

export function pruneThreeTrailPoints(
  points: ThreeTrailPoint[],
  maxLength: number | undefined,
  timeSeconds: number,
  recycledPoints?: ThreeTrailPoint[],
): void {
  let distanceFromHead = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]!;
    const next = points[i + 1];
    if (next) distanceFromHead += point.position.distanceTo(next.position);
    point.distanceFromHead = distanceFromHead;
  }
  let expired = 0;
  while (
    expired < points.length &&
    ((maxLength !== undefined &&
      points[expired]!.distanceFromHead > maxLength &&
      points.length - expired > 1) ||
      timeSeconds - points[expired]!.timeSeconds >
        points[expired]!.lifetimeSeconds)
  ) {
    recycledPoints?.push(points[expired]!);
    expired++;
  }
  if (expired > 0) {
    // Compact once rather than shifting every expired element individually.
    for (let i = expired; i < points.length; i++)
      points[i - expired] = points[i]!;
    points.length -= expired;
  }
}

const WHITE: Vec4 = [1, 1, 1, 1];
interface ThreeTrailBuffers {
  capacity: number;
  position: BufferAttribute & { array: Float32Array };
  color: BufferAttribute & { array: Float32Array };
  uv: BufferAttribute & { array: Float32Array };
  normal: BufferAttribute & { array: Float32Array };
  dynamicParams: BufferAttribute & { array: Float32Array };
  index: BufferAttribute & { array: Uint32Array };
  srgbColor: Color;
  trailColor: Vec4;
  direction: Vector3;
  viewDirection: Vector3;
  side: Vector3;
}

function floatAttribute(capacity: number, itemSize: number) {
  return new BufferAttribute(
    new Float32Array(capacity * itemSize),
    itemSize,
  ).setUsage(DynamicDrawUsage) as BufferAttribute & { array: Float32Array };
}

function ensureTrailBuffers(
  view: ThreeTrailView,
  requiredVertices: number,
): ThreeTrailBuffers {
  const previous = view.trailBuffers;
  if (previous && previous.capacity >= requiredVertices) return previous;
  const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(requiredVertices)));
  // BufferAttribute cannot resize an uploaded GPU buffer. Release the old
  // geometry binding on growth, before replacing its attributes.
  if (previous) view.trailGeometry.dispose();
  const buffers: ThreeTrailBuffers = {
    capacity,
    position: floatAttribute(capacity, 3),
    color: floatAttribute(capacity, 4),
    uv: floatAttribute(capacity, 2),
    normal: floatAttribute(capacity, 3),
    dynamicParams: floatAttribute(capacity, 4),
    index: new BufferAttribute(new Uint32Array(capacity * 3), 1).setUsage(
      DynamicDrawUsage,
    ) as BufferAttribute & { array: Uint32Array },
    srgbColor: previous?.srgbColor ?? new Color(),
    trailColor: previous?.trailColor ?? [1, 1, 1, 1],
    direction: previous?.direction ?? new Vector3(),
    viewDirection: previous?.viewDirection ?? new Vector3(),
    side: previous?.side ?? new Vector3(),
  };
  view.trailGeometry.setAttribute("position", buffers.position);
  view.trailGeometry.setAttribute("color", buffers.color);
  view.trailGeometry.setAttribute("uv", buffers.uv);
  view.trailGeometry.setAttribute("normal", buffers.normal);
  view.trailGeometry.setAttribute("trailDynamicParams", buffers.dynamicParams);
  view.trailGeometry.setIndex(buffers.index);
  view.trailBuffers = buffers;
  return buffers;
}

function updateTrailBounds(
  geometry: BufferGeometry,
  buffers: ThreeTrailBuffers,
  vertexCount: number,
): void {
  const sphere = (geometry.boundingSphere ??= new Sphere());
  const data = buffers.position.array;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < vertexCount * 3; i += 3) {
    minX = Math.min(minX, data[i]!);
    maxX = Math.max(maxX, data[i]!);
    minY = Math.min(minY, data[i + 1]!);
    maxY = Math.max(maxY, data[i + 1]!);
    minZ = Math.min(minZ, data[i + 2]!);
    maxZ = Math.max(maxZ, data[i + 2]!);
  }
  sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  let radiusSquared = 0;
  for (let i = 0; i < vertexCount * 3; i += 3) {
    const dx = data[i]! - sphere.center.x;
    const dy = data[i + 1]! - sphere.center.y;
    const dz = data[i + 2]! - sphere.center.z;
    radiusSquared = Math.max(radiusSquared, dx * dx + dy * dy + dz * dz);
  }
  sphere.radius = Math.sqrt(radiusSquared);
}
