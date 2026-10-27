import * as T from "three/tsl";
import type { ThreeSoftParticleDepth } from "../softParticles";
import type { ParticleSoftParticlesSettings } from "../../../engine/particles";

export function threeNodeSoftParticleFade(
  depth: ThreeSoftParticleDepth,
  settings: ParticleSoftParticlesSettings,
) {
  const camera = T.uniform(depth.uniforms.nfxDepthCamera.value).setGroup(
    T.renderGroup,
  );
  const ready = T.uniform(0)
    .setGroup(T.renderGroup)
    .onRenderUpdate(() => depth.uniforms.nfxDepthReady.value);
  const sampled = T.texture(depth.texture, T.screenUV).r;
  const linear = camera.z
    .greaterThan(0.5)
    .select(
      camera.x
        .mul(camera.y)
        .div(camera.y.sub(sampled.mul(camera.y.sub(camera.x)))),
      camera.x.add(sampled.mul(camera.y.sub(camera.x))),
    );
  const fade = linear
    .add(T.positionView.z)
    .sub(settings.near)
    .div(settings.far - settings.near)
    .clamp();
  return ready
    .lessThan(0.5)
    .or(sampled.greaterThanEqual(1))
    .select(T.float(1), fade);
}
