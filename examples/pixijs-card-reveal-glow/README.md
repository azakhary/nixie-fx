# PixiJS card reveal glow

An original PixiJS 8 example prepared for `examples/pixijs-card-reveal-glow` in `azakhary/nixie-fx`. Revealing the Aurora card plays a one-shot border cue from a NixieFX effect exported for the PixiJS adapter. HTML and CSS provide the card, reveal state, keyboard interaction, and static glow; NixieFX provides the gold and violet particles. The card remains readable with reduced motion enabled.

The authored effect uses four narrow box emitters, one per card edge, with staggered bursts and 48 total motes. It is separate from the repository's engine example and from the button-edge and inventory-icon effects prepared earlier. There are no downloaded textures or external runtime assets. The original vector sigil is included in `public/card-sigil.svg`.

## Run

Requires Node.js 20.19 or newer for the pinned Vite version.

```sh
npm install
npm run effect:validate
npm run effect:export
rm -rf public/vfx && cp -R vfx-project/out/vfx public/vfx
npm test
npm run build
npm run dev
```

Open the Vite URL. Activate **Reveal Aurora card** with a pointer, Enter, or Space. The card face appears, a border glow remains, and small particles play briefly around its edges. Activate it again to hide, then reveal again to replay. At narrow viewport widths, the CSS scales the card while the particle positions stay based on the canvas and card rectangles. With system reduced motion enabled, the card face and border still change without spawning particles.

## Files and verification

- `vfx-project/particle-data/effects/card-reveal-glow.json` is the editable source effect.
- `public/vfx/` is the committed export loaded at runtime. The app does not load the source project.
- `public/card-sigil.svg` is the original card art asset.
- `src/main.js` loads the export, places and updates the PixiJS effect, handles reveal and cleanup, and resizes the renderer.
- `tests/export.test.mjs` checks source/export freshness and PixiJS support in the manifest.
- `assets/visual-proof.jpg` shows the actual local browser after revealing the card.

Local verification on October 2, 2026: NixieFX validation reported 0 errors and 0 warnings, export succeeded, the source/export test passed, and `vite build` succeeded. In Chromium, clicking the card changed `aria-pressed` to true, showed the face, and visibly played particles around the border. Reduced-motion behavior follows the code path and should be checked on a device with that preference before merging.

For the pixi js particle editor authoring and export workflow, see the [NixieFX PixiJS particle effects guide](https://nixiefx.com/pixijs-particle-effects/). That is the sole contextual product link in this example.

## Limits

This demonstrates one UI cue, not a mobile performance benchmark. The glow around the card border is CSS, while the visible small motes are rendered by PixiJS through NixieFX. A browser without a working PixiJS renderer may fail to start the particle layer. The card text is example content, not a game asset or product claim. The exported effect may render differently under other graphics drivers or display densities.

## Repository placement

This example is published on the author’s public fork for maintainer review. Repository checks required by `AGENTS.md` passed locally. Merge into `azakhary/nixie-fx` remains subject to maintainer approval.
