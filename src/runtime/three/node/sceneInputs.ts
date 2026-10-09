import {
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  PointLight,
  SpotLight,
  type Light,
} from "three";
import * as T from "three/tsl";
import type { Node } from "three/webgpu";
import type { ThreeNodeGraphInputs } from "./graph";

// Read the renderer's real scene lights, including the existing WA-2214 pool.
// No separate selection, budget, light objects or per-frame scene traversal.
// Three rebuilds these expressions when its light topology changes. Values are
// render-group uniforms, so moving/fading lights does not recompile a material.
export function createSceneGraphInputs(): NonNullable<
  ThreeNodeGraphInputs["scene"]
> {
  const read = (
    kind:
      | "mainLightDirection"
      | "mainLightColor"
      | "sceneAmbientColor"
      | "sceneDiffuseLighting",
  ) =>
    T.Fn((builder) => {
      const lights = builder.lightsNode.getLights();
      const main = lights.find(
        (l): l is DirectionalLight => l instanceof DirectionalLight,
      );
      if (kind === "mainLightDirection")
        return T.vec4(
          main
            ? T.lightPosition(main).sub(T.lightTargetPosition(main)).normalize()
            : T.vec3(0, 1, 0),
          0,
        );
      if (kind === "mainLightColor")
        return T.vec4(main ? lightColor(main).div(Math.PI) : T.vec3(0), 1);
      let sum: Node<"vec3"> = T.vec3(0);
      for (const light of lights) {
        const color = lightColor(light);
        if (light instanceof AmbientLight) sum = sum.add(color);
        else if (light instanceof HemisphereLight) {
          const groundColor = new Color();
          const ground = T.uniform(groundColor)
            .setGroup(T.renderGroup)
            .onRenderUpdate(() => {
              groundColor
                .copy(light.groundColor)
                .multiplyScalar(light.intensity);
            });
          const weight = T.normalWorld
            .dot(T.lightPosition(light).normalize())
            .mul(0.5)
            .add(0.5);
          sum = sum.add(T.mix(ground, color, weight));
        } else if (kind === "sceneDiffuseLighting") {
          if (light instanceof DirectionalLight) {
            sum = sum.add(
              color.mul(
                T.normalWorld
                  .dot(
                    T.lightPosition(light)
                      .sub(T.lightTargetPosition(light))
                      .normalize(),
                  )
                  .clamp(),
              ),
            );
          } else if (
            light instanceof PointLight ||
            light instanceof SpotLight
          ) {
            const vector = T.lightPosition(light).sub(T.positionWorld),
              distance = vector.length(),
              direction = vector.normalize();
            const range = T.uniform(light.distance)
              .setGroup(T.renderGroup)
              .onRenderUpdate(() => light.distance);
            const decay = T.uniform(light.decay)
              .setGroup(T.renderGroup)
              .onRenderUpdate(() => light.decay);
            const falloff = T.float(1).div(distance.pow(decay).max(0.01));
            let attenuation: Node<"float"> = range
              .greaterThan(0)
              .select(
                falloff.mul(
                  T.float(1).sub(distance.div(range).pow(4)).clamp().pow(2),
                ),
                falloff,
              );
            if (light instanceof SpotLight) {
              const cone = T.uniform(0)
                .setGroup(T.renderGroup)
                .onRenderUpdate(() => Math.cos(light.angle));
              const penumbra = T.uniform(0)
                .setGroup(T.renderGroup)
                .onRenderUpdate(() =>
                  Math.cos(light.angle * (1 - light.penumbra)),
                );
              attenuation = attenuation.mul(
                T.smoothstep(
                  cone,
                  penumbra,
                  direction.dot(
                    T.lightPosition(light)
                      .sub(T.lightTargetPosition(light))
                      .normalize(),
                  ),
                ),
              );
            }
            sum = sum.add(
              color.mul(attenuation).mul(T.normalWorld.dot(direction).clamp()),
            );
          }
        }
      }
      return T.vec4(sum.div(Math.PI), 1);
    })();
  return {
    mainLightDirection: read("mainLightDirection"),
    mainLightColor: read("mainLightColor"),
    sceneAmbientColor: read("sceneAmbientColor"),
    sceneDiffuseLighting: read("sceneDiffuseLighting"),
  };
}
function lightColor(light: Light) {
  const color = new Color();
  return T.uniform(color)
    .setGroup(T.renderGroup)
    .onRenderUpdate(() => {
      color.copy(light.color).multiplyScalar(light.intensity);
    });
}
