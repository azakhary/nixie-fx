import {
  Color,
  Float32BufferAttribute,
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
}

interface ThreeTrailPoint {
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
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const dynamicParams: number[] = [];
  const indices: number[] = [];
  const settings = emitter.advanced.trails;
  const trailColor: Vec4 = [1, 1, 1, 1];
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
  const srgbColor = new Color();
  for (const [key, history] of view.trailHistories) {
    pruneThreeTrailPoints(history.points, undefined, timeSeconds);
    if (history.points.length < 2) {
      if (history.points.length === 0) view.trailHistories.delete(key);
      continue;
    }
    const points = history.points;
    const fallbackLength = Math.max(points[0]?.distanceFromHead ?? 1, 1);
    const startVertex = positions.length / 3;
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
        const rgb = sampleParticleGradientColor(settings.color, trailT);
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
        const tint = fixed?.tint ?? [1, 1, 1, 1];
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
      const dir = new Vector3().subVectors(next.position, prev.position);
      if (dir.lengthSq() <= 0.0000001) dir.set(0, 1, 0);
      dir.normalize();
      const viewDir = new Vector3().subVectors(camera.position, point.position);
      if (viewDir.lengthSq() <= 0.0000001) viewDir.set(0, 0, 1);
      viewDir.normalize();
      const side = new Vector3().crossVectors(dir, viewDir);
      if (side.lengthSq() <= 0.0000001) side.copy(DEFAULT_UP);
      side.normalize().multiplyScalar(width * 0.5);
      positions.push(
        // History is sampled in simulation world space. The mesh lives under
        // the translated effect root, just like particle meshes; subtract its
        // origin at submission, without moving the retained history points.
        point.position.x - side.x - effectPosition[0],
        point.position.y - side.y - effectPosition[1],
        point.position.z - side.z - effectPosition[2],
        point.position.x + side.x - effectPosition[0],
        point.position.y + side.y - effectPosition[1],
        point.position.z + side.z - effectPosition[2],
      );
      colors.push(r, g, b, alpha, r, g, b, alpha);
      if (resolution) {
        const u =
          settings.textureMode === "tile"
            ? point.distanceFromHead
            : point.distanceFromHead /
              Math.max(points[0]!.distanceFromHead, 0.000001);
        uvs.push(u, 0, u, 1);
        if (point.dynamicParams)
          dynamicParams.push(...point.dynamicParams, ...point.dynamicParams);
        normals.push(
          viewDir.x,
          viewDir.y,
          viewDir.z,
          viewDir.x,
          viewDir.y,
          viewDir.z,
        );
      }
    }
    const vertexCount = positions.length / 3 - startVertex;
    for (let i = 0; i < vertexCount / 2 - 1; i++) {
      const a = startVertex + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  if (positions.length === 0 || indices.length === 0) {
    clearThreeTrailGeometry(view);
    return;
  }
  view.trailGeometry.setAttribute(
    "position",
    new Float32BufferAttribute(positions, 3),
  );
  view.trailGeometry.setAttribute(
    "color",
    new Float32BufferAttribute(colors, 4),
  );
  if (resolution) {
    view.trailGeometry.setAttribute(
      "trailDynamicParams",
      new Float32BufferAttribute(dynamicParams, 4),
    );
    view.trailGeometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
    view.trailGeometry.setAttribute(
      "normal",
      new Float32BufferAttribute(normals, 3),
    );
  }
  view.trailGeometry.setIndex(indices);
  view.trailGeometry.computeBoundingSphere();
  view.trailMesh.visible = true;
}

export function clearThreeTrailView(view: ThreeTrailView): void {
  view.trailHistories.clear();
  clearThreeTrailGeometry(view);
}

function clearThreeTrailGeometry(view: ThreeTrailView): void {
  view.trailMesh.visible = false;
  view.trailGeometry.setIndex([]);
  view.trailGeometry.deleteAttribute("position");
  view.trailGeometry.deleteAttribute("color");
  view.trailGeometry.deleteAttribute("trailDynamicParams");
  view.trailGeometry.deleteAttribute("uv");
  view.trailGeometry.deleteAttribute("normal");
}

export function pruneThreeTrailPoints(
  points: ThreeTrailPoint[],
  maxLength: number | undefined,
  timeSeconds: number,
): void {
  let distanceFromHead = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]!;
    const next = points[i + 1];
    if (next) distanceFromHead += point.position.distanceTo(next.position);
    point.distanceFromHead = distanceFromHead;
  }
  while (
    points.length > 0 &&
    ((maxLength !== undefined &&
      points[0]!.distanceFromHead > maxLength &&
      points.length > 1) ||
      timeSeconds - points[0]!.timeSeconds > points[0]!.lifetimeSeconds)
  ) {
    points.shift();
  }
}
