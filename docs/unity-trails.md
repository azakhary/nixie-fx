# Unity-compatible trails and related options

These options let effects converted from Unity's Shuriken ParticleSystem keep
their source behavior. Defaults preserve existing Nixie effects.

## `advanced.trails.model: "unity"`

Implemented by the Three backend. Pixi warns (`advanced.trails.model.unity`) and
uses the Nixie trail model.

- **History.** Each particle commits a point when it is at least
  `minVertexDistance` (world units) from its last committed point. The live
  particle position is a separate head that is always drawn, so slow particles
  still build trails at any frame rate.
- **Lifetime.** `lifetime` is a multiple of the particle's lifetime (Unity's
  0–1 slider), × current particle size when `sizeAffectsLifetime`. The oldest
  segment is clipped continuously at that age instead of popping.
- **Ribbon parameter.** `t` is head-to-tail distance divided by total ribbon
  length; stretch UVs use `u = t`, tile UVs use the distance.
- **Width.** `width × widthOverTrail(t)`, × current particle size when
  `sizeAffectsWidth`.
- **Color.** (particle color when `inheritColor`, else white) ×
  `colorOverLifetime(particle normalized age)` × `colorOverTrail(t)`. There are
  no implicit head-to-tail or age fades; `length` is ignored.
- **Death.** `dieWithParticles: false` keeps a dead particle's trail frozen at
  its last head until every point expires, with color over lifetime sampled at
  age 1. `true` removes it immediately.
- **Joins.** Each vertex pair uses the normalized mean of the adjacent segment
  sides facing the camera.

Measured against Unity 6000.2.6f2 `BakeTrailsMesh` on a source effect, with the
recorded particle path replayed through `setMotionSampler`: ribbon centers
within 2.3e-5, widths within 1.2e-5, `u` within 3e-6 and alpha within 0.006
(Unity bakes 8-bit vertex colors), over 396 captures. Unresolved: Unity widens
exact 90-degree corners beyond this join rule. Mirrored (left/right-handed)
hosts see the across-ribbon `v` coordinate flipped.

## `render.drawParticles: false`

The emitter simulates normally (trails, lights, sub-emitters and events still
read its particles) but submits no billboard or mesh. This is Unity's Render
Mode None.

## Velocity over Lifetime

- Curve-mode linear velocity now displaces by the integral of the curve
  (previously `v(t) × age`). Constant and random modes are unchanged.
- `axisRandom: "independent"` draws one random per axis for random/random-curve
  linear velocity, as Unity does. `"shared"` (default) keeps one random for all
  axes.
- Unity samples the curve at the start of each substep and integrates
  explicitly; Nixie integrates exactly. On a 60 Hz source effect the positions
  differ by at most 3.5 cm over a 2.7 s particle life.
