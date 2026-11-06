# PixiJS smoke puff

This standalone PixiJS 8 example loads a compiled NixieFX export and replays a
small smoke puff at an exhaust port. It demonstrates the complete boundary
between authoring data and the files a game actually consumes.

## Run the example

```sh
npm install
npm run test
npm run build
npm run dev
```

Node.js 20.19 or newer is required by this Vite version.

## What is included

- `effects/smoke-puff.json`: editable NixieFX authoring data.
- `assets/smoke-disc.svg`: the editable source for the soft particle texture.
- `assets/smoke-disc.png`: the exported texture used by the runtime.
- `public/vfx`: the generated bundle loaded by the browser.
- `src/main.ts`: bundle loading, texture preloading, one update per Pixi ticker
  frame, replay handling, resize behavior, and teardown.
- `tests/smoke-puff.test.mjs`: source and export-contract checks.

The example pins PixiJS `8.19.0` and NixieFX `0.1.17`. If you want to change
the puff rather than the integration code, open this folder in NixieFX, edit
the source effect, validate it, and export again. The full editor-to-runtime
sequence is documented in the [pixi js particle editor](https://nixiefx.com/pixijs-particle-effects/) guide.

## Runtime behavior

The effect is a deterministic one-shot burst of 18 particles. The particles
use alpha blending, drift upward, expand, and fade. The demo preloads the
single SVG texture before creating the renderer and rejects missing textures
or unsupported runtime features instead of silently hiding them.

## Honest limits

This is a visual integration example, not a benchmark. It does not establish
mobile frame budgets, battery cost, atlas behavior, or suitable art direction
for a production game. The SVG texture is deliberately small and neutral so
teams can replace it with their own texture or atlas frame.

Disclosure: this example was prepared for the NixieFX project with AI-assisted
coding and documentation. A maintainer should review the visual result and the
repository diff before merging it.
