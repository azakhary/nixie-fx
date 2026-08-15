# NixieFX

NixieFX is the open-source runtime for particle effects authored with the
[NixieFX editor](https://nixiefx.com/editor/). It provides one shared,
deterministic simulation with renderer adapters for PixiJS and Three.js.

The editor project and the exported game bundle are intentionally different:
games consume the generated `out/vfx` directory, not the editable `.prj`
workspace.

## Install

Install NixieFX with the renderer used by your game:

```sh
npm install nixie-fx pixi.js
```

```sh
npm install nixie-fx three
```

PixiJS and Three.js are optional peer dependencies. Importing the core or
export APIs does not load either renderer.

## Public entrypoints

```ts
import {
  ParticleEffectRunner,
  normalizeParticleEffect,
  validateVfxAuthoringEffect,
} from "nixie-fx";
import { compileMaterial, normalizeShaderGraph } from "nixie-fx/materials";
import { PixiVfxRenderer } from "nixie-fx/pixi";
import { ThreeVfxRenderer } from "nixie-fx/three";
import { loadVfxExportBundle, writeVfxExportWithIo } from "nixie-fx/export";
import { parseEditorProjectFile } from "nixie-fx/project";
```

`nixie-fx/export` is browser-safe. Node filesystem helpers are isolated at
`nixie-fx/export/node`.

## Authoring CLI

The package also installs the `nixie-fx` command. Run it from a folder that
contains `vfx-editor.prj`, or pass the project folder explicitly:

```sh
npx nixie-fx effect create --project ./my-vfx --name "Fire Burst" --profile pixi-ui-2d
npx nixie-fx validate ./my-vfx
npx nixie-fx export ./my-vfx
```

`effect create` refuses to overwrite an existing effect. `validate` is
read-only, while `export` writes the project's configured `out/vfx` bundle.

## Runtime integration

Load the exported `manifest.json` and effect JSON files with
`loadVfxExportBundle`, provide host-owned texture/material/mesh resources, then
create an effect with the selected renderer. Advance the renderer exactly once
per host frame, using seconds:

```ts
const runtime = new PixiVfxRenderer({
  parent: app.stage,
  textureProvider,
});

runtime.createEffect(effect, { seed: 0xdecafbad });

app.ticker.add((ticker) => {
  runtime.update(ticker.deltaMS / 1000);
});

// When the owning scene is released:
runtime.destroy();
textureProvider.release?.();
```

The Three.js adapter follows the same lifecycle: construct with a camera and
scene or parent, call `update(deltaSeconds)` once per frame, and call
`destroy()` on teardown.

Always inspect the exported backend support report. A blocked effect must not
be silently treated as supported, and a partial effect can contain deliberate
backend approximations.

## Agent skills

Install the repository's NixieFX skills with:

```sh
npx skills add https://github.com/azakhary/nixie-fx
```

The runtime skill covers game integration. The authoring skill covers project
layout, effect creation, validation, export, and real-editor visual review.

## Development

```sh
npm ci
npm run check
npm run pack:check
npm run test:consumers
```

`test:consumers` packs the real npm artifact and verifies four clean installs:
core/export without renderer peers, PixiJS without Three.js, Three.js without
PixiJS, and the Node export adapter.

## License

[MIT](./LICENSE)
