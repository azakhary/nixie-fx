# Opaque scene depth for soft particles

Emitter `render.softParticles` is `{ enabled: false, near: 0, far: 1 }` by
default. Near/Far are **linear camera-space surface gaps in world units**,
not camera-fade distances. Contribution is multiplied by
`clamp((sceneDepth - particleDepth - near) / (far - near), 0, 1)`.
Empty background keeps the original appearance. Invalid/nonfinite imported
ranges reset together to 0/1; the toggle is retained. Values must remain
representable as a positive range in shader float precision.

```ts
import { ThreeSoftParticleDepth, ThreeVfxRenderer } from "nixie-fx/three";
const depth = new ThreeSoftParticleDepth();
const vfx = new ThreeVfxRenderer({ scene, camera, softParticles: depth });
const instance = vfx.createEffect(compiledEffect, { seed: 1234 });

function frame(dt: number) {
  vfx.update(dt);                    // exactly one simulation/update
  depth.prepare(renderer, scene, camera); // optional opaque capture
  renderer.render(scene, camera);  // host's usual beauty/post-processing
}
// On teardown, after removing the host frame callback:
vfx.destroy();
depth.dispose();
```

For WebGPURenderer, import `createThreeNodeAdapter` from
`nixie-fx/three/webgpu` and pass `renderAdapter: createThreeNodeAdapter()`.
Use `beginThreeWebGpuFrame(renderer)` once before preparing/rendering a frame
when driving WebGPURenderer directly. Existing `ThreeNodeRenderPipeline`
users keep its frame bookkeeping and call `depth.prepare` before
`pipeline.render()`. Native WebGPU and its WebGL2 fallback use the same node
fade. Call `vfx.setCamera(camera)` when replacing the camera, and pass that
camera to `prepare` too. No renderer or animation loop is created by depth.

The default integration lazily owns one render target/depth texture. It captures
opaque depth-writing scene meshes with their original materials, retaining
cutouts, displacement and skinning. All participating Nixie effect roots,
including trails and opaque particle surfaces, are excluded; transparent
meshes, lines and sprites cannot enter the depth texture. Share a depth object
across VFX renderers in the same scene and prepare it once per camera.

If a host already produces an opaque-only `DepthTexture`, pass it to
`new ThreeSoftParticleDepth(hostDepthTexture)`. This resource is borrowed and
never disposed; `prepare` then only updates camera/viewport state and performs
**zero** extra captures. The texture must be current, use conventional [0,1]
(non-reversed, non-logarithmic) hardware depth, cover the full active camera
viewport, and exclude VFX. Multisampled buffers must be resolved first. Keep
its texture identity stable when resizing. The owned path supports ordinary
perspective and orthographic cameras with the same conventional depth contract.

`depth.stats.passes` is the last prepare's capture count (0 or 1), `captures`
is cumulative, and `activeMeshes` counts participating visible draws. With
all settings off there is no capture, GPU depth allocation or shader sampling.
Hidden/destroyed consumers do not request captures. Active depth targets resize
with the viewport and are released on disposal. A capture restores the host's
render target, background, clear settings and object/material visibility.

The fade applies after authored material output so textures, lighting,
emission, legacy colors and authored opacity are not applied twice. Alpha and
Additive scale alpha; Premultiplied Alpha scales both final RGB and alpha once.
Transparent surfaces with fading enabled retain depth testing but do not write
depth. Opaque/Masked graph materials and trails retain their existing rules.
Soft draws remain instanced where already supported; cross-emitter surface
batchers treat them as barriers to preserve their per-emitter depth uniforms.
Pixi preserves the settings and reports the feature unavailable.

## Behavior references

- [Unity URP particle shader](https://docs.unity.cn/Packages/com.unity.render-pipelines.universal%407.4/manual/particles-unlit-shader.html)
- [Unity particle color and soft intersections](https://docs.unity.com/en-us/engine/6000.3/manual/particle-color)
- [Unity Standard Particle Shader](https://docs.unity.com/en-us/engine/6000.3/manual/materials-and-shaders/built-in/shader-built-in-birp/shader-standard-particle-shaders/shaders)

This is an optional renderer feature, not a depth-read graph node. See the
[editable project and consumer](../examples/soft-particles/README.md).

Before the next npm release, consumers can pin the public repository to an
exact commit (`git+https://github.com/azakhary/nixie-fx.git#<full-commit>`).
The npm `prepare` lifecycle builds the public package entrypoints for Git
installs. Install scripts and development build dependencies must be allowed;
no sibling checkout, copied `dist` directory or local tarball is required.
