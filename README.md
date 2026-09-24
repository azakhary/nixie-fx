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
npx nixie-fx export-status ./my-vfx
```

`effect create` refuses to overwrite an existing effect. `validate` is
read-only, while `export` writes the project's configured `out/vfx` bundle.

`export-status` is read-only and always exits 0. It prints one line per
authored effect — `exported`, `stale` (the source changed since the export) or
`unexported` — plus `orphaned` for exported effects whose source is gone:

```text
Export generated 2026-09-01T00:00:00.000Z (out/vfx).
fire.json   exported    fire
smoke.json  stale       smoke
ember.json  unexported  -
1 up to date, 1 stale, 1 unexported, 0 orphaned.
Run "nixie-fx export" to refresh the bundle.
```

The same comparison is available to applications and tools as a pure,
browser-safe function that takes an already-parsed manifest and the authored
JSON the caller has read:

```ts
import { compareVfxExportToSources } from "nixie-fx/export";

const comparison = compareVfxExportToSources(manifest, [
  { path: "fire.json", source: fireJson },
]);
comparison.effects; // [{ path, status, sourceHash, exportedPath, effectId, ... }]
comparison.orphans; // exported effects with no authored source
comparison.outOfDate; // true when anything is stale, unexported or orphaned
```

It reuses the exporter's own per-effect source hash, so `exported` means the
bundle is byte-for-byte current for that effect.

### Exporting a single effect

Exporting one effect (the editor's per-effect export, or `effectFile` in the
writer options) is incremental: it recompiles and re-validates only that
effect and merges the result into the bundle already in the output folder
instead of rewriting it. Other effects keep their compiled files, their
manifest entries and their validation, assets that no effect references any
more are pruned, and the aggregate `sourceHash` is recomputed so
`loadVfxExportBundle` still accepts the bundle. Other effects' files are left
byte-identical and the re-exported entry keeps its place in the manifest. A
bundle keeps its first export's `generatedAt`, so re-exporting unchanged
sources, whole or one effect at a time, rewrites nothing. Problems in
another effect cannot block it, and a blocked single-effect export writes
`export-diagnostics.json` while leaving the existing bundle untouched. A full
export (no `effectFile`) still wipes and rewrites the whole output folder.

A subfolder that contains its own `vfx-editor.prj` is a separate project: the
parent project's export walks past it, along with the parent's own output
folder.

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

## Scene lighting

Particles are unlit by default. A material whose **Shading Model** is `lit`
(or an emitter with `render.shading: "lit"`) is shaded by the Three.js
scene's own lights — any `DirectionalLight`, `PointLight`, `SpotLight`,
`AmbientLight` or `HemisphereLight` you already have. Lit graphs can also
drive Normal (tangent space), Roughness and Metallic, and any material can
read the lights directly through the Lighting nodes (Main Light Direction /
Color, Ambient Color, Scene Diffuse Lighting, World Normal, View Direction,
World Position). PixiJS renders lit materials unlit.

The editor previews effects against `.scene` files: preview-only lighting
setups that effects never reference. Games that want the same lighting can
load one and add its lights to their scene:

```ts
import { parseSceneDefinition } from "nixie-fx";
import { createThreeSceneLights } from "nixie-fx/three";

const lights = createThreeSceneLights(parseSceneDefinition(sceneJsonText));
scene.add(lights.group);
// lights.update(editedDefinition) retunes in place; lights.dispose() removes them.
```

Scene files use Three.js physical light units and glTF conventions (lights
shine along local -Z, rotations are Euler degrees in Unity's Y·X·Z order,
colors are sRGB hex). Their `props` list is editor-only stand-in geometry.

## Examples

- [Three.js digit embers](./examples/threejs) — the NixieFX landing scene as a
  standalone runtime integration. [Open in CodeSandbox](https://codesandbox.io/p/sandbox/y3z3sf).
- [PixiJS v8 opening engine](./examples/pixijs) — a responsive 2D integration
  driven by Pixi's ticker. [Open in CodeSandbox](https://codesandbox.io/p/sandbox/ny2r5y).

## Simulation space

`emitter.spawn.simulationSpace` selects `world` (default) or `local` in both
renderers. Local particles retain emitter-relative positions and motion; live
edits to `spawn.position`, `spawn.rotation` (degrees), and `spawn.scale` transform
existing particles, including after emission ends. The effect position supplies
the outer translation, and the renderer root inherits its scene/container parents.
World particles keep their spawn coordinates when the emitter definition moves.

Simulation space is captured at birth. Changing the setting applies to new
particles; living particles keep their previous mode without jumping. Restart
an effect to apply the new mode to every particle. Local scale is applied at
render time, so even a zero axis can safely expand again. Billboard facing still
follows the selected alignment/facing mode. Trail space is controlled separately
by the Trails module.

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
