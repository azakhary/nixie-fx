# Alpha compositing contract (#1221)

Particle simulation, gradient sampling, and renderer CPU color composition use
straight RGBA: initial alpha and lifetime alpha multiply A, independently of RGB.
The bake evaluator also reads and writes straight RGBA. Those stages were not the
cause of the fade darkening.

## Root cause

The live Tier-2 material vertex shaders premultiplied particle RGB before exposing
`vColor` to the graph. The shared fragment compiler then multiplied the graph's
result by `vColor` again, even when the graph already connected Particle Color RGB
and A to its outputs. A direct Particle Color graph therefore squared opacity and
also applied tint twice. Three's normal `SRC_ALPHA / ONE_MINUS_SRC_ALPHA` blending
multiplied the already-darkened RGB by alpha once more.

Pixi normally samples premultiplied textures and blends with
`ONE / ONE_MINUS_SRC_ALPHA`. The shared graph compiler treated sampled RGB as
straight, while its old output premultiplication included particle alpha but not
all graph/material opacity contributions. Consequently it could both square
particle opacity and mismatch the final RGB/alpha representation. Copying Pixi's
stock particle vertex premultiplication into a general material graph was unsafe.

A headed GPU test against the original source reproduces this: at lifetime alpha
0.75, a white Three particle over white reads `(192,192,192)` instead of
`(255,255,255)`. On black, Pixi reads `(143,143,143)` instead of `(191,191,191)`.

## Boundaries after the fix

- Graph particle inputs and intermediate values are straight RGBA. Custom graphs
  own their explicit Particle Color/Alpha connections; the final output does not
  apply them again. The implicit Sprite Master graph retains its particle factor.
- Three passes `uParticleColor` unchanged to the fragment stage. Its normal and
  additive shaders output straight RGBA. Three's `PREMULTIPLIED_ALPHA` material
  define enables premultiplication of the completed output for premultiplied mode.
  Texture upload flags and renderer/canvas context settings are unchanged.
- Pixi decodes premultiplied texture samples before graph evaluation and encodes
  the completed output exactly once. Its texture source alpha mode determines
  encoding, matching ParticleContainerPipe's automatic `normal`/`normal-npm` and
  `add`/`add-npm` blend selection. Sources are never mutated. Current per-node
  particle samplers all bind the same main source, so they use the same decode.
- Pixi container tint/world alpha is separated from particle graph inputs and
  applied once at the output boundary, before final premultiplication.
- Texture-only, baked, fixed-function, instanced billboard, and trail rendering
  keep their existing paths. Opaque ignores opacity; masked retains its graph
  opacity cutoff and opaque surviving fragments. Supported emitter modes are
  alpha, additive, and premultiplied; multiply is not an emitter mode.

## Regression verification

Run `npm run check`, then `node scripts/test-alpha-browser.mjs` from the runtime
repository. The latter uses the installed Playwright Chromium in headed mode;
install it with `npx playwright install chromium` if necessary. It captures no
screenshots or recordings.

The GPU suite draws the actual Three material adapter and Pixi ParticleContainer
shader and compares framebuffer pixels against the alpha-compositing equation.
It includes white/red, tinted and RGBA textures, combined material tint/opacity,
white/black/grey/colored backgrounds, constant/fade-out/fade-in/pulse curves,
three texture alpha representations, and alpha/additive/premultiplied/opaque/
masked blends. All 12,000 comparisons pass with no GPU shader errors. The test
isolates blending from host tone mapping and color-space presentation; it does
not assert pixel identity between differently tone-mapped editor previews.

The editor also refreshes material graphs after initial preview creation and
backend switches so the Three adapter rebuilds initially unresolved material
views after the project cache loads. The real project launcher is smoke-tested
separately from the GPU suite.
