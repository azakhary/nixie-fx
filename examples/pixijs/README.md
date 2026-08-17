# NixieFX + PixiJS v8

A minimal, standalone PixiJS v8 integration for the NixieFX runtime. It loads
the compiled `opening-engine` export, preloads its texture, maps its world
coordinates into a responsive 2D viewport, and advances NixieFX from Pixi's
own ticker.

The sibling [`examples/threejs`](../threejs) demo intentionally showcases the
website's `digit-embers` effect instead. Each folder carries its own compiled
bundle so it can run independently in CodeSandbox.

## Run locally

```sh
npm install
npm run dev
```

Open the URL printed by Vite. To verify the production build:

```sh
npm run build
npm run preview
```

Node.js 20.19 or newer is required by this Vite version.

## Integration map

The complete integration lives in [`src/main.ts`](./src/main.ts):

1. Create and initialize a PixiJS v8 `Application`.
2. Fetch the editor-generated `public/vfx/manifest.json` and effect JSON.
3. Validate the bundle for the `pixi2d` backend with
   `loadVfxExportBundle`.
4. Preload every declared texture through a synchronous NixieFX texture
   provider.
5. Create `PixiVfxRenderer` under `app.stage` and spawn `opening-engine`.
6. Call `vfx.update(ticker.deltaMS / 1000)` once per Pixi ticker frame.
7. Rebuild the 2D projection on resize and release both runtimes on teardown.

The FPS and particle labels are ordinary DOM elements refreshed four times per
second. They do not add another Pixi render pass.

## Effect files

Games consume the compiled export under `public/vfx`, not the editable
NixieFX project JSON. This bundle contains one effect and one texture, and its
manifest reports `supported` for both PixiJS and Three.js.

## CodeSandbox

[Open the runnable PixiJS v8 example in CodeSandbox](https://codesandbox.io/p/sandbox/xw6h74).
The sandbox is a standalone snapshot of this folder, including the compiled
`opening-engine` export and its texture.
