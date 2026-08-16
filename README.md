# NixieFX

NixieFX is the open-source runtime for particle effects authored with the
[NixieFX editor](https://nixiefx.com/editor/). It provides one shared,
deterministic simulation with renderer adapters for PixiJS and Three.js.

[Website](https://nixiefx.com/) ·
[Quick start](https://nixiefx.com/quick-start/) ·
[Documentation](https://nixiefx.com/docs/) ·
[Agent skills](https://nixiefx.com/skills/) ·
[npm](https://www.npmjs.com/package/nixie-fx)

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

Three.js is the canonical backend. Load the exported `manifest.json` and
effect JSON files with `loadVfxExportBundle`, create effects with
`ThreeVfxRenderer`, and advance the renderer exactly once per host frame,
using seconds:

```ts
import { loadVfxExportBundle } from "nixie-fx/export";
import { ThreeVfxRenderer } from "nixie-fx/three";

const bundle = loadVfxExportBundle(
  { manifest, effectsByPath },
  { requiredBackend: "three3d" },
);
const effect = bundle.effectsById.get("world-impact");
if (!effect) throw new Error("Missing world-impact effect");

// Providers are the complete form and every one of them is OPTIONAL:
// effects without file assets need none of them.
const vfx = new ThreeVfxRenderer({
  scene,
  camera,
  textureProvider, // exported texture paths -> THREE.Texture (preload first)
  meshProvider, // prepared mesh refs -> BufferGeometry
  materialGraphProvider, // .material graph ids -> ShaderGraph
});
const instance = vfx.createEffect(effect, { position: [0, 0, 0], seed: 42 });

// Once per host frame:
vfx.update(deltaSeconds);

// When the owning scene is released:
vfx.destroy();
```

The PixiJS adapter follows the same lifecycle for UI and 2D scenes:
construct `PixiVfxRenderer` with a parent container (plus the same optional
providers), call `update(deltaSeconds)` once per frame, and call `destroy()`
on teardown.

Always inspect the exported backend support report. A blocked effect must not
be silently treated as supported, and a partial effect can contain deliberate
backend approximations.

## Other engines

The export format is engine-neutral JSON: `manifest.json` plus per-effect
files describing emitters, modules, and asset references — no renderer types
anywhere. Official runtimes exist for Three.js and PixiJS. For another
engine, the deterministic simulation (`src/engine/particles.ts`) is shared
and renderer-agnostic, and the Three adapter (`src/runtime/three/`) is
compact enough to serve as a reference implementation for a port — including
one written with the help of an AI assistant.

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
