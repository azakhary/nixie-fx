# Native GPU simulation (`independent-v1`)

This Three-only profile adds per-emitter GPU simulation to the existing effect,
material, export and shared lighting APIs. CPU remains the default. Renderer
selection and simulation target are separate decisions. A WebGPU renderer using
its WebGL fallback **cannot** run compute.

## Host integration

```ts
const { renderer } = await createThreeWebGpuRenderer(); // await device init
const runtime = new ThreeVfxRenderer({
  scene, camera, renderAdapter: createThreeNodeAdapter(renderer),
  materialGraphProvider, textureProvider,
});
const effect = runtime.createEffect(exportedEffect, { seed: 42 });
const clustered = createThreeClusteredLighting(renderer, scene);
clustered.manager.setProfile({ mode: 'clustered', maxLights: 64,
  maxLightsPerCluster: 64, totalSceneLights: 64 });
clustered.manager.add(effect);
// In the game's existing frame loop:
beginThreeWebGpuFrame(renderer);
runtime.update(dt);
clustered.manager.update(dt, camera);
renderer.render(scene, camera);
// On removal: manager.remove(effect); runtime.removeEffect(effect);
// On host teardown: runtime.destroy(); clustered.dispose();
// disposeThreeWebGpuRenderer(renderer);
```

No runtime-owned rAF, global renderer, editor import or recurring particle
readback is added. Legacy callers may still use `createThreeNodeAdapter()`
without a renderer: GPU emitters then block or use their authored CPU fallback.
The full exported consumer is in `examples/gpu`.

## Contract and capacity

An absent `emitter.simulation` means legacy CPU semantics. `createGpuSimulation()`
creates the explicit version-1 settings: target, `independent-v1` profile, fixed
min/max bounds, blocked/CPU fallback, native-WebGPU/seven-storage-buffer/64-lane
requirements, `replace-oldest` overflow, and `reset-fixed-step` seeking. Effects
containing these settings and their compiled exports use format 2; legacy format
1 exports remain supported and stay format 1. Old consumers must upgrade before
loading format 2. The export contains data, never executable shader source.

CPU capacity remains 4,096. GPU capacity is 1–262,144 integer slots per emitter,
further limited by the initialized device's buffer size and dispatch limits.
Invalid requests and insufficient devices block; they are not silently reduced.
The UI shows the portable profile ceiling and the actual device ceiling.
An explicit `{ mode: 'cpu', maxParticles: 1024 }` fallback is serialized and
reports its reduced capacity and different integration/noise fidelity. It is
also used for unsupported GPU modules. A native, supported GPU emitter with this
policy still runs only on GPU, never a duplicate CPU population.

State uses six vec4 storage records (96 bytes/slot), plus a 16-byte control
buffer and small authoring LUTs: 4,096 = 0.375 MiB, 65,536 = 6 MiB, 262,144 =
24 MiB. These are state allocations, not total renderer/driver memory. Aggregate
allocation across effects remains the host's responsibility. Buffer allocation
failure follows the existing host failure/retry lifecycle, without changing the
saved effect.

Each logical update dispatches one emission counter pass and one independent
simulation pass, then rendering consumes those buffers directly. Emission uses
an integer counter and a bounded ring head; capacity overflow replaces the
oldest slots. Particle IDs wrap after 2^32 births; the ring head does not depend
on floating-point IDs. No CPU particle arrays are updated for native emitters.
The CPU runner keeps disabled one-slot placeholders to preserve authored emitter
indices and legacy seed order.

## Support matrix

| Area | Supported | Blocked / policy |
| --- | --- | --- |
| Emission | Rate curves, scheduled bursts, delay, duration, looping | Distance emission; >256 scheduled burst cycles per loop |
| Shapes | Point, circle (XZ), sphere, +Y hemisphere, box volume, cone base; random arc | Mesh/other shapes, nonrandom arc, arc quantization, direction alignment, cone volume |
| Initial values | Lifetime, velocity vector/shape direction, size XY, scalar rotation, seed colors/gradients | XYZ billboard rotation |
| Forces | Gravity/drag in Forces module; sine noise with octaves/scroll/damping | Curl noise and advanced velocity/force/speed modules |
| Lifetime curves | Color/alpha, size, scalar angular velocity | Speed-driven modules |
| Rendering | Camera-plane/screen-aligned billboards, existing Three node material graphs, texture/material time and particle color | Meshes, axis alignment, trails, flipbook/sub-UV and dynamic custom-data modules |
| Transparency | Additive, unsorted alpha/premultiplied using existing material rules | Any particle sorting; alpha may show overlap artifacts |
| Dependencies | Independent particles | Collision, triggers, subemitters, events, inherited motion and external fields |
| Picking/debug | Emitter gizmos and authored bounds; conservative count diagnostics | Per-particle picking/debug mirrors, automatic particle bounds, per-frame readback |
| Runtime overrides | Emission/initial-velocity multipliers, scalar size multiplier and color tint | Runtime curve/gradient overrides throw with an explanation; edit definition/reset instead. Motion sampler returns false; manual emitBurst rejects—use authored schedules |

Unsupported combinations produce authoring/export diagnostics. Explicit CPU
fallback permits the CPU behavior instead. Pixi cannot run this GPU profile;
Pixi CPU effects and explicit CPU fallbacks retain the existing runtime.

Curves and gradients use 256-sample LUTs prepared when a definition changes.
Scalar min/max curves retain seeded blending and particle-age/loop-age axes.
LUT interpolation can soften narrow keys and fixed-gradient boundaries. GPU
integration/random distributions are a declared quality profile, not bit-exact
CPU parity or cross-device determinism. Repeatability requires the same seed,
backend, definition and time steps. Keep game dt bounded; use fixed steps for
checkpoint comparisons.

## Lifecycle, transforms and bounds

- Mixed effects share play/pause/stop/restart/allow-completion/seek. Pausing stops
  simulation; resume restarts emission without discarding live particles. Stop
  destroys GPU buffers; restart recreates/reset them. Instance start times are
  subtracted from emitter time, including instances created later in a game.
- GPU emitter and material/resource edits reset the mixed preview to time zero.
  CPU-only edit semantics stay unchanged. Switching to CPU clamps its capacity
  to 4,096; switching back uses the retained GPU policy and current capacity.
- GPU seek resets and replays 1/60 steps. `effect.seek(seconds)` is synchronous
  for game-owned offline seeks. The editor chunks long seeks into at most 12
  steps / 6 ms CPU submission per displayed frame, renders once, and shows
  progress. Pause/resume or a second seek preserves the latest user intent.
  A step during replay advances from the visible cursor and stays paused.
- Local positions include the authored emitter transform and subsequently follow
  the effect transform. World positions bake that transform at birth and remain
  fixed when the effect moves. Emission rotations use authored degrees. Billboard
  facing comes from the camera. Lights use the same world positions.
- Bounds are authored in simulation space. Local bounds follow the effect;
  world bounds remain world-fixed. They control draw frustum culling only;
  offscreen simulation continues so re-entry is coherent. Include the particle
  radius, motion and all intended world-space emission positions. There is no
  automatic expansion or GPU readback. Too-small bounds can hide particles.
- Resize uses the existing host camera/material pipeline. Inactive editor hosts
  cancel rAF; hidden standalone pages suspend their frame loop. Device loss uses
  the preceding failure/retry path: recreate renderer/instances, reset simulation,
  preserve authored settings. There is no state recovery across lost devices.
- Teardown releases compute passes, storage buffers (including compute-only
  buffers never rendered), LUT textures and materials. Removing/hidden/detached
  effects stops their light contribution.

## Shared lighting

The existing scene manager still owns the total host light allowance and reserves
game lights first. Valid CPU candidates retain their importance selection. GPU
sources reserve the remainder in stable effect/emitter registration order. Within
a source, GPU lanes scan disjoint partitions and select the first live slot;
partition identity stays stable until death/recycling or a budget change.
This is a bounded representative selection, **not** GPU importance sorting or
cross-target optimal brightness ranking. GPU replacement is immediate; it does
not claim CPU selector cross-fade parity.

Authored light curves, radius, intensity, color and particle-color inheritance
are evaluated on GPU. The native cluster pass projects selected light bounds
and compacts indices without copying particles or light records to CPU. It
admits at most 64 GPU lights, and conservatively subtracts the greatest CPU
cluster occupancy from per-cluster capacity. This avoids partial-volume cuts,
but can reject more lights than a spatially optimal allocator. The manager's
budget/rejection statistics include these reservations/rejections. Active GPU
light counts are reserved upper bounds, including empty partitions; particle
counts likewise are slot upper bounds. They are not measured live populations.
Small-light mode does not support GPU lights and explains that constraint.

## Verification boundaries

See the editor's `docs/qa/gpu-simulation/README.md` for the dated desktop results,
fixture settings and human QA steps. No showcase, physical-phone claim, sustained
thermal result or cross-device visual approval is part of this implementation.
