# Clustered particle lights (WA-2216)

This is the implementation milestone. The requester deferred the polished
architectural showcase and physical-device validation. The comparison fixtures
are editable regression inputs, not visual approval or supported performance
profiles. No GPU particle simulation, particle readbacks, shadows, or mesh-flow
work is included.

## Host integration

Use the paired editor/runtime `codex/2216-clustered-particle-lighting` branches.
The runtime branch includes the exact soft-particle prerequisite `758fa8b`
already required by editor main's Dockerfile. No npm release is required.

```ts
import { ThreeVfxRenderer } from 'nixie-fx/three';
import {
  createThreeWebGpuRenderer, createThreeNodeAdapter,
  createThreeClusteredLighting, ThreeNodeRenderPipeline,
} from 'nixie-fx/three/webgpu';

const { renderer, backend } = await createThreeWebGpuRenderer();
const lighting = createThreeClusteredLighting(renderer, scene);
const particles = new ThreeVfxRenderer({ scene, camera,
  renderAdapter: createThreeNodeAdapter(), /* asset/material providers */ });
const effect = particles.createEffect(exportedEffect);
const unregister = lighting.manager.add(effect);
lighting.manager.setProfile({ mode: 'clustered', maxLights: 128,
  totalSceneLights: 128, maxLightsPerCluster: 16 });
// These are experimental settings. Check lighting.supported, lighting.reason,
// backend, and manager.stats in your UI; do not infer support from the request.
const pipeline = new ThreeNodeRenderPipeline(renderer, scene, camera);
function hostFrame(dt: number) {
  particles.update(dt);                         // once
  lighting.manager.update(dt, camera);          // once, after all effect updates
  pipeline.render();                           // one beauty render (plus enabled post effects)
}
// Reuse the same saved/exported effect for the small path:
lighting.manager.setProfile({ mode: 'small', maxLights: 2 });
// On effect removal: unregister(); particles.removeEffect(effect, true).
// Teardown: pipeline.dispose(); particles.destroy(); lighting.dispose();
// lighting.manager.dispose(); then dispose the host-owned renderer.
```

One manager per scene serves every effect/renderer producer. Install one binding
per initialized WebGPURenderer before rendering; other scenes delegate to the
host's original lighting. Dispose the binding before its manager and renderer.
Three r184/r185 capture their lighting factory on initialization: this integration
wraps the existing factory and clears render-list caches on binding changes.
It does not replace the renderer, schedule frames, alter DPR, or delete game
lights. The cache seam is deliberately guarded; an incompatible Three version
fails explicitly. Host materials with their own custom `lightsNode` intentionally
retain that lighting override rather than being rewritten.

## Bounds and selection

- Allocation ceilings: 512 light records, 16 × 9 × 16 view clusters, 64 entries
  per cluster. Two reusable data textures hold about 592 KiB; backing arrays
  have the same bound. Resizing does not allocate a larger cluster grid.
- Profiles normalize capacities into these ceilings and set `capacityClamped`
  when any requested value is changed. They live on the host,
  never in effect definitions. The small API retains the existing 0/2/4 VFX
  allowance contract. Clustered allowance is `min(maxLights, totalSceneLights -
  visibleGameLightCount)`, clamped at zero. All visible scene lights count,
  conservatively including zero-intensity/ambient lights; their cost is never
  silently removed. This is a count reservation, not a GPU-cost model for shadows.
- Reuse WA-2214's importance scoring, persistent instance/emitter/particle IDs,
  hysteresis and 160 ms replacement fades. Fading slots count against capacity.
  Raising a playing budget fades in new slots. A hard capacity decrease must
  immediately evict excess slots to honor the new bound; retained slots keep
  their gains. Explicit paused budget changes and seeks rebuild immediately.
- Reject nonpositive/nonfinite ranges. Cull the influence sphere against the
  camera frustum, then conservatively assign its projected bounding cube to
  logarithmic depth slices. Near-plane-crossing spheres cover all XY cells.
  Exact point attenuation/range is evaluated per fragment, so offscreen source
  centers can illuminate onscreen surfaces. Perspective and orthographic
  cameras require finite near/far planes.
- Admit selected lights in stable identity order, independent of selector array
  compaction. Each light must fit every cell in its conservative influence volume;
  if any cell is full, omit that whole light from all cells. This prevents hard
  cell/depth-slice cuts across surfaces. Overflow is a deliberate whole-light
  omission, not an energy-conserving approximation; moving lights can change
  admission. Reduce ranges or raise capacity to relieve it. Conservative bounds
  can overestimate occupancy. Fixed scratch arrays use another 6.75 KiB.
  `maxOccupancy` and `overflowClusters` describe demand before admission;
  `overflowAssignments` counts all entries omitted by whole-light rejection.
- The fixed lists feed Three's normal lit BRDF and NixieFX's authored
  `sceneDiffuseLighting` graph input. Existing roughness, normals, metallic,
  opacity, transparency, material graphs and bloom remain in their owner paths.
- Native WebGPU is required. A WebGL2 fallback is explicitly reported and uses
  the small path with two VFX lights until the host selects another small cap.
  It never claims clustered support. CPU particle simulation is unchanged.

## Diagnostics

`manager.stats` is a mutable snapshot: poll it locally or use an external store;
do not send it through a whole React workspace each frame.

| Field | Meaning |
| --- | --- |
| candidates / active / fading | Producer candidates, occupied selected slots, transitional slots |
| requestedMode / mode / supported / reason | Requested versus actual path and capability explanation |
| capacityClamped | A requested capacity was nonfinite, fractional or outside allocation limits |
| requestedBudget / budget | Configured VFX request and effective allowance |
| totalSceneCapacity / sceneLights / budgetReduction | Host total, reserved scene lights, reduction in VFX allowance |
| perClusterCapacity | Active bounded entry limit per cluster |
| invalidRanges / invalidCandidates | Rejected range evaluations versus other invalid producer values |
| frustumCulled | Valid influence spheres entirely outside the camera |
| budgetRejected | Eligible candidates exceeding global selection capacity |
| contributingLights | Selected lights with at least one retained cluster assignment |
| overflowClusters / overflowAssignments / overflowLights | Crowded demand cells, all omitted entries, wholly omitted lights |
| maxOccupancy | Peak pre-truncation occupancy; includes conservative intersections |

Invalid authored ranges are counted at curve evaluation before they disappear
from candidate snapshots. Candidate count therefore excludes those rejected
upstream. Emitter-authored maxLights remains an artistic producer constraint;
host budget rejection is counted separately after that constraint.

## Review and evidence

Use `examples/webgpu` and the editor's `docs/qa/webgpu` project. The consumer's
`?clustered=1` URL selects the distributed preset and requests native WebGPU.
Choose the crowded preset, three instances, a total cap of 16 and a per-cluster
cap of 1 to inspect both overflow categories. Switch to forced WebGL2 to inspect
the unsupported message. Use `scene-read` to exercise authored lighting inputs.

The consumer supports 60 s warmup + 300 s sampling (up to 600 s), bounded at
120,000 samples. It reports camera, backend, resolution/DPR, effects/ranges,
materials, bloom, particle/light counts, frame lows/max/p99, 30 s timing buckets,
simulation/preparation CPU, light selection/cluster CPU, render-submission CPU,
and total CPU. GPU time is explicitly unmeasured. The consumer has no editor/React
cost; record that separately in the real editor. Tab hiding or configuration
changes cancel measurements. Enter device/GPU/OS and append human thermal notes.

No sustained device budget is certified by this code delivery. Physical iOS,
physical Android, thermal behavior and final visuals are unresolved until human
QA. Do not turn a compile/lifecycle smoke into a performance claim.
