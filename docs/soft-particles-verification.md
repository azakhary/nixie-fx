# Verification · 27 October 2026

## Automated checks

- Runtime `npm run check`: 74 files / 998 tests passed, type/lint/source checks,
  build and package smoke passed.
- Editor `npm test`: 86 files / 755 tests passed. `npm run build` passed.
- Exported consumer production build passed.
- `npm run test:consumers`: core/export without peers, Pixi-only, Three-only,
  and Node-export consumers passed with the packed runtime.
- Focused depth tests cover malformed imports, disabled shader/pass absence,
  opaque-only capture, exclusion of VFX/transparent geometry, restoration after
  renderer failure, hidden/disposed effects and definition updates.
- Export regression covers per-emitter settings, old effects and invalid ranges.
- All four example effects validated and exported with zero errors. Materials
  retains the existing partial-trails export warning, visible in both hosts.

## Real renderer checks

Headed Chrome 156, Three r184, Apple M4 Max / 48 GB. Temporary readback probes
were removed after testing; no screenshots or recordings were produced.

90 material/camera/backend cases (900 draws) checked negative gaps, Near=0.25,
midpoint=0.625, Far=1 and gap=2 with fading off/on. Coverage: perspective and
orthographic, stock sprites, modern and legacy graph colors, lit graphs, mesh
graph particles, Alpha, Additive and Premultiplied Alpha; legacy WebGL, native
WebGPU, and WebGPURenderer's forced WebGL2 fallback. All cases retained ordinary
occlusion, contributed zero at Near, half at the midpoint (within 8-bit rounding),
and matched their disabled pixels at/beyond Far. Baselines were nonzero, so
black/failed renders could not pass the equality checks.

An additional 72 cases (720 draws) covered stock lit surfaces, lit mesh graphs
and empty background across both cameras, all three blends and all three
backends. Far/beyond equality and unchanged empty-background pixels passed.
These compare each backend to its own authored baseline; they do not assert
that unrelated pre-existing color differences between backends are fixed.

## Editor / exported host

The real `vfx-editor.prj` was opened through the launcher, with actual effect
files and Lit Scene props. Checked the Renderer toggle and distances, paused
numeric edits, undo/redo, duplication, save/close/reopen, Pixi unavailable hint
and retained settings, WebGL and native WebGPU, and scene selection. Negative
Far input corrected to a valid positive value. The consumer loads the real
compiled export; its toggle reports 0 captures disabled and 1 enabled.

Human visual acceptance and recording remain intentionally pending. Follow
[the review flow](../examples/soft-particles/README.md), especially textures,
light/glow appearance, trails, camera movement, and the three fixed checkpoints.

## Performance sample

120 visible diagnostic samples over 30 seconds per state after warmup. Real
Smoke project, 50 particles, legacy WebGL, floor/two cubes, bloom off, preview
1126×444 drawing pixels, DPR 1. Browser viewport 1600×1000. Diagnostic sampling
uses the existing local stats subscriber; no per-frame React state was added.

| Metric | Fade off median / maximum | Fade on median / maximum |
| --- | --- | --- |
| Frame interval | 16.7 / 17.7 ms | 16.7 / 17.7 ms |
| Simulation + particle preparation | 0.2 / 1.0 ms | 0.2 / 0.8 ms |
| Render CPU submission | 0.2 / 1.0 ms | 0.3 / 0.9 ms |
| Latest React commit | 0 / 13.2 ms | 0 / 12.8 ms |
| FPS (median / minimum) | 60 / 56 | 60 / 56 |

The primary output was a 1920×1080 **60 Hz TV**, mirrored to the laptop's
120 Hz-capable display. All samples therefore flag the requested <90 FPS /
>13 ms thresholds; this setup cannot establish a 120 Hz pass. Repeat on an
unmirrored 120 Hz display. The similar off/on React peaks are recorded rather
than hidden. Render submission is CPU timing, not a GPU timer measurement.
