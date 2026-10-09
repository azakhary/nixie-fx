# Three WebGPU rendering and authored materials

`nixie-fx/three/webgpu` is an opt-in draw adapter. The existing CPU simulation,
particle preparation, effect serialization, playback and WA-2214 light manager
remain shared. It does not implement compute simulation or clustered lighting.
The consumer owns the renderer, scene, camera and frame loop.

```ts
import { ThreeVfxRenderer, ThreeVfxLightManager } from 'nixie-fx/three';
import {
  createThreeWebGpuRenderer, createThreeNodeAdapter,
  ThreeNodeRenderPipeline, disposeThreeWebGpuRenderer,
} from 'nixie-fx/three/webgpu';

const { renderer, backend } = await createThreeWebGpuRenderer({
  signal: controller.signal,
  onDeviceLost: message => showErrorAndStopFrames(message),
});
const particles = new ThreeVfxRenderer({
  scene, camera, renderAdapter: createThreeNodeAdapter(),
  textureProvider, meshProvider, materialGraphProvider,
});
const instance = particles.createEffect(exportedEffect, { seed: 1234 });
const lights = ThreeVfxLightManager.forScene(scene, 2);
const unregister = lights.add(instance);
const pipeline = new ThreeNodeRenderPipeline(renderer, scene, camera);
pipeline.setBloom(sceneDefinition.bloom);
// One host rAF: particles.update(dt); lights.update(dt, camera); pipeline.render();
// On teardown: unregister(); particles.destroy(); pipeline.dispose();
// Dispose a light manager only when its owning scene is being destroyed.
// Then: lights.dispose(); disposeThreeWebGpuRenderer(renderer);
```

`backend` is `webgpu` or `webgl2-fallback`. The latter uses WebGPURenderer's
node-material WebGL2 backend; it is distinct from legacy `WebGLRenderer`.
`forceWebGL: true` makes the fallback reproducible in the example. Initialization
is asynchronous, an aborted late initialization is disposed, and no canvas or
animation loop is installed by the helper. Stop the host loop while hidden.
`ThreeNodeRenderPipeline` advances Three's frame bookkeeping exactly once. Hosts
rendering directly call `beginThreeWebGpuFrame(renderer)` once before rendering.

Three r184/r185 starts a private bookkeeping rAF during init even without a user
animation callback. The helper stops it through a small, checked compatibility
seam. Upgrade this seam with Three, rather than allowing invisible renderers to
keep ticking. Disposal also releases the fallback's GL context slot. The API
handles lost-device notification; hosts must display it, stop rendering and
recreate resources on Retry or explicitly choose legacy WebGL.

## Feature matrix

“Implemented” describes the available path, not visual approval on every device.
Native r184 and forced fallback r184 have headed desktop compilation smoke;
physical iOS/Android and measured visual tolerances remain pending human review.

| Feature | Legacy WebGL | Native WebGPU | Three WebGL2 fallback |
|---|---|---|---|
| CPU simulation, fixed seed, seek, transforms | Shared | Shared | Shared |
| Camera-facing particles | Existing quad/batch path | CPU-prepared instanced quads | Same node path |
| Mesh particles, normals, winding, sorting | Existing mesh path | Instanced geometry | Same node path |
| Authored unlit/lit graphs | GLSL/fixed/bake compiler | TSL graph, Basic/Standard node material | Same TSL graph to GLSL |
| Parameters, portable subgraphs, time | Existing compiler | Implemented | Implemented |
| Particle Color and Dynamic Parameters | Existing versioned semantics | Per-instance/ribbon attributes | Same attributes |
| Relative Time / Random | Legacy compatibility feeds | Same alpha/color-derived feeds | Same feeds |
| Texture sheets, SubUV frame blending | Existing path | Per-instance UV frames | Same path |
| Custom-material trails | Existing ribbon compiler | Node material, color/dynamic ribbon attributes | Same path |
| Opaque/masked/alpha/additive/premultiplied | Existing | Implemented | Implemented |
| Depth, faces, distance/age sort | Existing | Implemented; depth gate at instance-batch granularity | Same |
| HDR and bloom | Half-float composer + UnrealBloomPass | HDR scene pass + BloomNode | Same node postprocessing |
| Scene lights and lighting graph reads | Existing | Real host lights and live uniforms | Same |
| WA-2214 particle illumination | Shared manager | Same identity, budget, fade and reservation | Same |
| Material editor, scene save/load/export | Existing authored format | Same authored format | Same authored format |
| Overdraw editor diagnostic | Available | Visible “use legacy WebGL” diagnostic | Same diagnostic |
| Host GLSL ShaderMaterial injection | Available | Rejected with emitter/action | Rejected with emitter/action |
| Deferred particle Position/Size/Speed/Direction/MacroUV reads | No authored legacy Three feed | Explicit material/node error; use Dynamic Parameters | Same error |
| GPU simulation / clustered lights | Separate tasks | Separate tasks | Separate tasks |

No authored graph falls back to a stock material in the node adapter. Missing
graphs/textures, cycles and unsupported node types throw diagnostics. The emitter
wrapper adds surface/trail context. A failed view build releases partial resources;
a replacement is constructed before disposing the previous view. Consumer hosts
should keep authored data and offer Retry or a declared backend choice.

## Visual comparison criteria and known algorithm differences

Use the editable editor fixture `docs/qa/webgpu`, seed 1234, time 0.5/1.5/2.5s,
orthographic target (0,.85,0), yaw 0, pitch -.82, view height 12. Compare equal
viewport, DPR, lighting budget, bloom and exposure. The standalone checkpoint
button restores the same camera/seed/time. Particle positions/counts should match
exactly at fixed simulation steps; the unit test compares the shared transforms.

The old custom-lit GGX implementation and Three Standard node BSDF are different
implementations. Small highlight/roughness differences are expected; verify the
same normal direction, light attenuation, metallic response and silhouettes.
Bloom uses two related Three implementations and may differ at glow edges and
thresholds. Instanced transparent meshes sort within each emitter, and the depth
write gate is conservative for a batch containing any translucent instance, as
in the existing instanced billboard path. Cross-emitter transparent overlap can
therefore differ from the legacy per-particle mesh path. Old color-version output
uses its historical raw-display convention; colorVersion 1 follows linear math.

These are review criteria, not measured tolerance claims: no missing features or
frames, exact CPU transforms/counts at matched steps, no flipped normals, and no
unexpected opaque/transparent changes are acceptable. Inspect highlight and glow
regions separately; if the reviewer requires numeric image error bounds, those
remain unmeasured and must be established before acceptance. Static bake-tier
noise versus live shader noise also needs feature-specific review. Do not claim
bounded parity merely because shaders compile.

## Tested versions and limits

Development baseline: Three 0.184.0, @types/three 0.184.1, TypeScript 5.7, local
unpublished nixie-fx 0.1.20 branch build. Package peer range remains r184/r185.
The clean package consumer validates normal entry points with Three as its only
renderer peer; backend-neutral imports remain free of Three/Pixi dependencies.
r185, Safari and physical mobile browsers are not covered by the desktop smoke.

The supplied results report native/fallback desktop 30-second samples. The initial native/fallback runs and a final native repeat
failed the strict 120Hz desktop 90fps/13ms lows criterion. The final native repeat
ran predominantly at 120fps (9.3ms p99), with three slow intervals; the earlier
30fps pacing did not reproduce and its cause remains unresolved. CPU submission is not GPU time.
No universal particle/light budget, thermal result, mobile pass, actual device-loss
pass or bounded visual-parity approval is asserted. See the example README for
secure-origin phone setup and the human recording checklist.

Three's upstream references: [WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html),
[TSL](https://threejs.org/docs/pages/TSL.html). The installed r184 source is the
compatibility baseline for this branch.
