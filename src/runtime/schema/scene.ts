import type { Vec3 } from "../../engine/math";
import {
  clampNumber,
  isRecord,
  normalizeVec3,
  numberOr,
  safeString,
} from "../../engine/particleModuleSettingUtils";

/**
 * A scene-lighting setup, used to preview effects the way a game scene would
 * light them. It is NOT a world/level format: an effect never references a
 * scene, and scenes never reference effects. The editor keeps any number of
 * these as `*.scene` files and previews against one at a time; games may load
 * the same file through `createThreeSceneLights` (nixie-fx/three) or map the
 * plain JSON onto their own lights.
 *
 * Conventions (match glTF KHR_lights_punctual so the data ports cleanly):
 *  - Units are Three.js physical units: directional intensity in lux-like
 *    units, point/spot intensity in candela, `range` is the cutoff distance
 *    (0 = infinite) and `decay` the falloff exponent (2 = physically correct).
 *  - Lights shine along their local -Z axis. `rotation` is Euler degrees
 *    applied in Unity order (yaw Y, then pitch X, then roll Z; Three "YXZ").
 *  - Colors are sRGB hex strings (`#rrggbb`).
 */
export interface SceneDefinition {
  app: "vfx-editor";
  kind: "scene";
  version: 1;
  name: string;
  ambient: SceneAmbientSettings;
  lights: SceneLight[];
  /** Preview-only stand-in meshes (e.g. a character or floor to judge scale). */
  props: SceneProp[];
}

/** Unity "Environment Lighting › Source": flat Color or Sky/Ground Gradient. */
export type SceneAmbientSource = "color" | "gradient";

export const SCENE_AMBIENT_SOURCES: readonly SceneAmbientSource[] = [
  "color",
  "gradient",
];

export interface SceneAmbientSettings {
  source: SceneAmbientSource;
  /** Flat ambient color (source === "color"). */
  color: string;
  /** Gradient sky color (source === "gradient"). */
  skyColor: string;
  /** Gradient ground color (source === "gradient"). */
  groundColor: string;
  intensity: number;
}

export type SceneLightType = "directional" | "point" | "spot";

export const SCENE_LIGHT_TYPES: readonly SceneLightType[] = [
  "directional",
  "point",
  "spot",
];

export interface SceneLight {
  id: string;
  name: string;
  type: SceneLightType;
  enabled: boolean;
  color: string;
  intensity: number;
  /** World position. For directional lights only the gizmo placement uses it. */
  position: Vec3;
  /** Euler degrees, Unity order (Y, X, Z). Lights shine along local -Z. */
  rotation: Vec3;
  /** Point/spot cutoff distance; 0 = infinite. */
  range: number;
  /** Point/spot falloff exponent; 2 = physically correct inverse square. */
  decay: number;
  /** Spot full cone angle in degrees (Unity "Spot Angle"). */
  spotAngle: number;
  /** Spot edge softness, 0 = hard edge .. 1 = fully soft (Three penumbra). */
  penumbra: number;
}

export interface SceneProp {
  id: string;
  name: string;
  /** Project-relative mesh asset path (.glb / .gltf). */
  mesh: string;
  visible: boolean;
  position: Vec3;
  /** Euler degrees, Unity order (Y, X, Z). */
  rotation: Vec3;
  scale: Vec3;
}

export const SCENE_FILE_EXTENSION = ".scene";
export const SCENE_POSITION_LIMIT = 1000;
export const SCENE_MAX_LIGHTS = 16;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeSceneColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (HEX_COLOR.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [r, g, b] = trimmed.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

/**
 * Euler rotation (degrees, Unity order) that points a light's -Z axis from
 * `position` toward `target`. Roll stays 0.
 */
export function sceneAimRotation(
  position: Vec3,
  target: Vec3 = [0, 0, 0],
  /** Round to 0.01° for tidy authored values (off keeps the exact aim). */
  round = true,
): Vec3 {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const dz = target[2] - position[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return [0, 0, 0];
  const x = dx / length;
  const y = dy / length;
  const z = dz / length;
  // forward(-Z) rotated by Ry(yaw)·Rx(pitch) = (-sin(yaw)cos(p), sin(p), -cos(yaw)cos(p))
  const pitch = Math.asin(clampNumber(y, -1, 1));
  const yaw = Math.atan2(-x, -z);
  const finish = round ? roundAngle : (value: number) => value;
  return [finish(toDegrees(pitch)), finish(toDegrees(yaw)), 0];
}

/** The world-space direction a light shines (its rotated local -Z axis). */
export function sceneLightDirection(rotation: Vec3): Vec3 {
  const pitch = toRadians(rotation[0]);
  const yaw = toRadians(rotation[1]);
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

export function createDefaultSceneAmbient(): SceneAmbientSettings {
  return {
    source: "gradient",
    color: "#8a94a3",
    skyColor: "#f7f9ff",
    groundColor: "#51606f",
    intensity: 1.15,
  };
}

let generatedSceneIdCounter = 0;

export function createSceneObjectId(prefix: string): string {
  generatedSceneIdCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${generatedSceneIdCounter.toString(36)}${random}`;
}

export function createDefaultSceneLight(
  type: SceneLightType,
  overrides: Partial<SceneLight> = {},
): SceneLight {
  const position: Vec3 =
    overrides.position ??
    (type === "directional"
      ? [3, 6, 5]
      : type === "spot"
        ? [0, 4, 3]
        : [1.5, 2, 1.5]);
  const light: SceneLight = {
    id: createSceneObjectId(type),
    name:
      type === "directional"
        ? "Directional Light"
        : type === "spot"
          ? "Spot Light"
          : "Point Light",
    type,
    enabled: true,
    color: "#ffffff",
    intensity: type === "directional" ? 2.2 : type === "spot" ? 30 : 12,
    position,
    rotation: sceneAimRotation(position),
    range: type === "directional" ? 0 : 12,
    decay: 2,
    spotAngle: 45,
    penumbra: 0.3,
    ...overrides,
  };
  return light;
}

export function createDefaultSceneProp(
  mesh: string,
  overrides: Partial<SceneProp> = {},
): SceneProp {
  const fileName = mesh.split("/").pop() ?? mesh;
  return {
    id: createSceneObjectId("prop"),
    name: fileName.replace(/\.[^.]+$/, "") || "Mesh",
    mesh,
    visible: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...overrides,
  };
}

/**
 * The stock look every preview used before scenes existed: a sky/ground
 * gradient plus a white key light and a cool fill light.
 */
export function createDefaultScene(name = "Default Scene"): SceneDefinition {
  return {
    app: "vfx-editor",
    kind: "scene",
    version: 1,
    name,
    ambient: createDefaultSceneAmbient(),
    lights: [
      createDefaultSceneLight("directional", {
        id: "key-light",
        name: "Key Light",
        position: [3, 6, 5],
        // Exact aim: identical to the old hardcoded light targeting origin.
        rotation: sceneAimRotation([3, 6, 5], [0, 0, 0], false),
        intensity: 2.2,
        color: "#ffffff",
      }),
      createDefaultSceneLight("directional", {
        id: "fill-light",
        name: "Fill Light",
        position: [-4, 2.5, -3],
        rotation: sceneAimRotation([-4, 2.5, -3], [0, 0, 0], false),
        intensity: 0.55,
        color: "#9fb9ff",
      }),
    ],
    props: [],
  };
}

export function normalizeSceneAmbient(value: unknown): SceneAmbientSettings {
  const fallback = createDefaultSceneAmbient();
  const source = isRecord(value) ? value : {};
  return {
    source: SCENE_AMBIENT_SOURCES.includes(source.source as SceneAmbientSource)
      ? (source.source as SceneAmbientSource)
      : fallback.source,
    color: normalizeSceneColor(source.color, fallback.color),
    skyColor: normalizeSceneColor(source.skyColor, fallback.skyColor),
    groundColor: normalizeSceneColor(source.groundColor, fallback.groundColor),
    intensity: clampNumber(
      numberOr(source.intensity, fallback.intensity),
      0,
      1000,
    ),
  };
}

export function normalizeSceneLight(
  value: unknown,
  index = 0,
): SceneLight | null {
  if (!isRecord(value)) return null;
  const type = SCENE_LIGHT_TYPES.includes(value.type as SceneLightType)
    ? (value.type as SceneLightType)
    : null;
  if (!type) return null;
  const fallback = createDefaultSceneLight(type, {
    id: `${type}-${index + 1}`,
  });
  const position = normalizeVec3(
    value.position,
    fallback.position,
    -SCENE_POSITION_LIMIT,
    SCENE_POSITION_LIMIT,
  );
  return {
    id: safeString(value.id, fallback.id).trim() || fallback.id,
    name: safeString(value.name, fallback.name),
    type,
    enabled: value.enabled !== false,
    color: normalizeSceneColor(value.color, fallback.color),
    intensity: clampNumber(
      numberOr(value.intensity, fallback.intensity),
      0,
      100000,
    ),
    position,
    rotation: normalizeVec3(
      value.rotation,
      sceneAimRotation(position),
      -3600,
      3600,
    ),
    range: clampNumber(numberOr(value.range, fallback.range), 0, 100000),
    decay: clampNumber(numberOr(value.decay, fallback.decay), 0, 10),
    spotAngle: clampNumber(
      numberOr(value.spotAngle, fallback.spotAngle),
      1,
      179,
    ),
    penumbra: clampNumber(numberOr(value.penumbra, fallback.penumbra), 0, 1),
  };
}

export function normalizeSceneProp(
  value: unknown,
  index = 0,
): SceneProp | null {
  if (!isRecord(value)) return null;
  const mesh = safeString(value.mesh, "").trim();
  if (!mesh) return null;
  const fallback = createDefaultSceneProp(mesh, { id: `prop-${index + 1}` });
  return {
    id: safeString(value.id, fallback.id).trim() || fallback.id,
    name: safeString(value.name, fallback.name),
    mesh,
    visible: value.visible !== false,
    position: normalizeVec3(
      value.position,
      fallback.position,
      -SCENE_POSITION_LIMIT,
      SCENE_POSITION_LIMIT,
    ),
    rotation: normalizeVec3(value.rotation, fallback.rotation, -3600, 3600),
    scale: normalizeVec3(value.scale, fallback.scale, -1000, 1000),
  };
}

export function normalizeSceneDefinition(value: unknown): SceneDefinition {
  const source = isRecord(value) ? value : {};
  const lights = (Array.isArray(source.lights) ? source.lights : [])
    .map((light, index) => normalizeSceneLight(light, index))
    .filter((light): light is SceneLight => light !== null)
    .slice(0, SCENE_MAX_LIGHTS);
  const props = (Array.isArray(source.props) ? source.props : [])
    .map((prop, index) => normalizeSceneProp(prop, index))
    .filter((prop): prop is SceneProp => prop !== null);
  return {
    app: "vfx-editor",
    kind: "scene",
    version: 1,
    name: safeString(source.name, "Scene"),
    ambient: normalizeSceneAmbient(source.ambient),
    lights: uniqueIds(lights),
    props: uniqueIds(props),
  };
}

/** True when the JSON looks like a scene file (used for sniffing imports). */
export function isSceneDefinitionLike(value: unknown): boolean {
  return isRecord(value) && value.kind === "scene";
}

export function parseSceneDefinition(text: string): SceneDefinition {
  const parsed = JSON.parse(text) as unknown;
  if (!isSceneDefinitionLike(parsed)) {
    throw new Error('Not a NixieFX scene file (expected "kind": "scene").');
  }
  return normalizeSceneDefinition(parsed);
}

export function serializeSceneDefinition(scene: SceneDefinition): string {
  return `${JSON.stringify(normalizeSceneDefinition(scene), null, 2)}\n`;
}

function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id;
    let suffix = 2;
    while (seen.has(id)) id = `${item.id}-${suffix++}`;
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function roundAngle(value: number): number {
  return Math.round(value * 100) / 100;
}
