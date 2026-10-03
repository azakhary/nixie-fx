# Particle light emission (stage 1)

`emitter.lightEmission.version: 1` explicitly opts into real illumination.
The optional object is preserved by normalization, saving and the normal export
compiler/loader. Missing or unknown versions emit no scene lights. Existing
`modules.lights` and `advanced.lights` still use `applyLightColorApproximation`;
the new feature never enables, rewrites or replaces that legacy tint. Pixi
ignores real light emission and returns an explicit unsupported-feature report.

Modes are `disabled`, `emitter` (one origin light during the emitter's emission
window), and `particles` (live particles). Emitter mode samples the gradient
and lifetime curves at clamped emitter loop age (after start delay, repeating
for looping emitters, ending at duration for one-shots). Particle mode samples
at normalized particle age; scalar curves set to Loop Age use the current
emitter loop age. Normal random scalar modes use the stable particle seed or
emitter loop seed. Gradient alpha multiplies intensity. Non-finite positions,
colors, intensity or radius, non-positive radius and non-positive intensity
produce no candidate. `maxLights: null` allows every live candidate; a finite
maximum selects the oldest still-live particle IDs, with replacements only
as those particles die. Zero emits none. This artistic maximum is independent
of device settings.

Particle IDs survive swap compaction and capacity changes. A runtime-instance
prefix keeps identical effects independent. Candidates follow the same
simulation-space conversion and effect/root transforms as particle rendering.
The Three producer reuses motion samples from normal draw preparation; it adds
no simulation/update pass. `evaluateVfxLight` and `VfxLightSelector` in the core
entry point have no renderer imports. `VfxLightProducer` is a synchronous,
backend-neutral snapshot interface containing world positions, RGB color,
intensity, radius, a lifecycle revision, and pause state. A future GPU producer
can publish completed data through this interface; stage 1 does no readback,
compute or GPU simulation.

## Consumer integration

The host owns its Three scene, renderer and frame loop. There is exactly one
manager per `Scene`, retrieved by `ThreeVfxLightManager.forScene(scene)`; it is
shared even when several separate `ThreeVfxRenderer` objects use that scene.
Registration is explicit:

```ts
import { ThreeVfxRenderer, ThreeVfxLightManager } from "nixie-fx/three";
const fx = new ThreeVfxRenderer({ scene, camera });
const lights = ThreeVfxLightManager.forScene(scene, 2);
const instance = fx.createEffect(exportedEffect);
const releaseLights = lights.add(instance);

// Once per host frame, after all effect updates and before the one scene render:
fx.update(deltaSeconds);
lights.update(deltaSeconds, camera);
renderer.render(scene, camera);

lights.setBudget(4); // selectable VFX caps: 0, 2, 4
instance.pause(); // frozen producer candidates and selected intensity
instance.seek(1.5); // revision rebuilds correct candidates, also while paused
lights.reset(); // optional explicit host-wide discontinuity/restart
releaseLights(); // immediately clears this instance's owned slots
fx.removeEffect(instance);
// On final scene teardown, after all clients release their registrations:
lights.dispose();
fx.destroy();
```

For a host-wide pause, pass zero delta and stop effect updates. The editor skips
unchanged paused renders; consumers can likewise invalidate only when necessary.
Hidden roots/ancestors, detached roots, stopped or destroyed instances return an
empty contribution. Definitions, seek/restart and visibility changes increment
a revision. Unregister before removing an instance to release slots immediately;
the next manager update also clears contributions whose producer is no longer
visible/attached. Always unregister to release the manager's reference. Stop
frame work when the host is hidden; dispose the manager only at scene teardown,
not when one of several renderer clients is removed.

Selection ranks intensity × radius² / max(1, camera distance²), with 25% incumbent
hysteresis and an ID tie-breaker. Replacements fade their current slot out over
160ms before a new candidate fades into the slot. Fading slots consume the cap.
Pause preserves selected gains; seek/restart explicitly rebuilds instead of
fading obsolete history. Budget reductions clamp immediately. The pool keeps
exactly the assigned cap attached (zero-intensity unused slots) to avoid shader
recompilation as winners change. All pool lights are unshadowed PointLights with
physical inverse-square falloff and the candidate's finite distance cutoff.

## Host scene-light reservation policy

The cap is a **remaining VFX allowance**, not a total scene-light count. Profile
and reserve the game-owned lights, their shadow costs and lit-material workload
first; then choose 0, 2 or 4 VFX lights that fit the measured remaining budget.
`stats.sceneLights` counts visible pre-existing Three lights, including ambient
and hemisphere lights, separately from the VFX pool. A count is diagnostic,
not a universal cost estimate: ambient, directional, point, spot and shadowed
lights have different costs. The manager never removes or retunes game lights.
If a game changes its own lights, the host must reassess and call `setBudget`
with its newly tested remaining allowance. There is intentionally no automatic
one-light-one-cost subtraction or universal device limit. Editor caps are local
preview controls and never enter saved emitter definitions.

Read `manager.stats` for candidate, active (including fading), assigned budget
and existing scene-light counts. Subscribe in a small local component or read
from the host diagnostics; do not send per-frame metrics through workspace state.
The example reports simulation/selection, render submission, total work and rAF
frame intervals separately. These CPU timings do not measure completed GPU work.

The standalone `examples/shared-lights` consumes the normal exported bundle,
loads the same scene/geometry as the editable editor review project, and runs
three independent instances. Its README describes local package setup and QA.
