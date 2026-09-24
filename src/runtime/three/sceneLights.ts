import {
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  PointLight,
  SpotLight,
  type Light,
} from "three";
import {
  normalizeSceneDefinition,
  sceneLightDirection,
  type SceneDefinition,
  type SceneLight,
} from "../schema/scene";

/**
 * Live Three.js lights for a `SceneDefinition`. Add `group` to your scene;
 * call `update` with an edited definition to retune the lights in place (the
 * light objects are only rebuilt when the set of light types changes, which
 * is also the only case where Three recompiles lit materials).
 */
export interface ThreeSceneLights {
  readonly group: Group;
  update(scene: SceneDefinition): void;
  /** The Three light for a scene light id (null when disabled or unknown). */
  getLight(id: string): Light | null;
  dispose(): void;
}

type AmbientObject = AmbientLight | HemisphereLight;
type SceneLightObject = DirectionalLight | PointLight | SpotLight;

export function createThreeSceneLights(
  scene: SceneDefinition,
): ThreeSceneLights {
  const group = new Group();
  group.name = "NixieFX Scene Lights";
  let ambient: AmbientObject | null = null;
  let lights = new Map<string, SceneLightObject>();
  let structureKey = "";

  const clear = () => {
    for (const child of [...group.children]) {
      group.remove(child);
      (child as Partial<Light>).dispose?.();
    }
    ambient = null;
    lights = new Map();
  };

  const build = (definition: SceneDefinition) => {
    clear();
    ambient =
      definition.ambient.source === "gradient"
        ? new HemisphereLight()
        : new AmbientLight();
    ambient.name = "Ambient";
    group.add(ambient);
    for (const light of definition.lights) {
      if (!light.enabled) continue;
      const object = createLightObject(light);
      object.name = light.name;
      group.add(object);
      if ("target" in object) group.add(object.target);
      lights.set(light.id, object);
    }
  };

  const apply = (definition: SceneDefinition) => {
    if (ambient instanceof HemisphereLight) {
      ambient.color.set(definition.ambient.skyColor);
      ambient.groundColor.set(definition.ambient.groundColor);
      ambient.position.set(0, 1, 0);
    } else if (ambient) {
      ambient.color.set(definition.ambient.color);
    }
    if (ambient) ambient.intensity = definition.ambient.intensity;
    for (const light of definition.lights) {
      const object = lights.get(light.id);
      if (object) applyLight(object, light);
    }
    group.updateMatrixWorld(true);
  };

  const update = (next: SceneDefinition) => {
    const definition = normalizeSceneDefinition(next);
    const key = sceneStructureKey(definition);
    if (key !== structureKey) {
      structureKey = key;
      build(definition);
    }
    apply(definition);
  };

  update(scene);

  return {
    group,
    update,
    getLight: (id) => lights.get(id) ?? null,
    dispose: () => {
      clear();
      group.removeFromParent();
    },
  };
}

/** Which Three objects a definition needs; equal keys retune in place. */
function sceneStructureKey(definition: SceneDefinition): string {
  return [
    definition.ambient.source,
    ...definition.lights
      .filter((light) => light.enabled)
      .map((light) => `${light.id}:${light.type}`),
  ].join("|");
}

function createLightObject(light: SceneLight): SceneLightObject {
  if (light.type === "directional") return new DirectionalLight();
  if (light.type === "spot") return new SpotLight();
  return new PointLight();
}

function applyLight(object: SceneLightObject, light: SceneLight): void {
  object.color.set(light.color);
  object.intensity = light.intensity;
  object.position.set(...light.position);
  if (object instanceof PointLight) {
    object.distance = light.range;
    object.decay = light.decay;
    return;
  }
  const direction = sceneLightDirection(light.rotation);
  object.target.position.set(
    light.position[0] + direction[0],
    light.position[1] + direction[1],
    light.position[2] + direction[2],
  );
  if (object instanceof SpotLight) {
    object.distance = light.range;
    object.decay = light.decay;
    object.angle = Math.min(Math.PI / 2, (light.spotAngle * Math.PI) / 360);
    object.penumbra = light.penumbra;
  }
}
