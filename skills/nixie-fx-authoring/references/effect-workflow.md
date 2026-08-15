# Effect workflow

## Create from canonical defaults

Choose the intended target deliberately:

- `pixi-ui-2d` for PixiJS UI or 2D scenes.
- `three-world-3d` for Three.js world effects.
- `portable` only when the effect must stay inside the common backend subset.

Run:

```sh
npx nixie-fx effect create \
  --project /absolute/path/to/project \
  --name "Fire Burst" \
  --profile pixi-ui-2d
```

Read the CLI output to learn the created path. Inspect the generated JSON before editing. The generated effect is the schema reference; do not construct every nested module from memory.

## Edit safely

- Preserve `app`, `kind`, and `version`.
- Keep effect IDs unique within the project and emitter IDs unique within an effect.
- Use finite numeric values and preserve generated scalar-value envelopes unless intentionally changing their mode.
- Enable a module only when its generated settings are present.
- Make one coherent visual change at a time, validate it, then inspect it in the editor.
- Preserve unknown fields so newer editor versions do not lose data.

## Reference assets

- Store textures below `assetRootPath` and persist their paths relative to that root.
- Store `.material` JSON below the configured materials folder. Keep graph IDs aligned with emitter material shader IDs.
- Store prepared runtime meshes below the asset root. Do not point runtime refs at raw source assets that need importer-specific processing.
- Keep asset paths stable when packing textures into an atlas; the game maps raw paths to atlas frames.

## Visual review

Open [nixiefx.com/editor](https://nixiefx.com/editor/) in a Chromium-compatible browser, choose **Open Folder**, and select the folder containing `vfx-editor.prj`. Select the intended Pixi or Three preview and observe startup, loop/completion, motion, blend, material, and bounds behavior. The folder remains local to the browser; validation proves structural/runtime support, not visual quality.

For performance-sensitive effects, inspect the real project rather than a synthetic JSON-only harness. Do not hide a performance issue by reducing authoring affordances or changing renderer quality defaults.
