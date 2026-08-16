# Three.js runtime

Install and import only the Three adapter:

```sh
npm install nixie-fx three
```

```ts
import {
  ThreeVfxRenderer,
  type ThreeVfxMeshProvider,
  type ThreeVfxTextureProvider,
} from "nixie-fx/three";
import type { ShaderGraph } from "nixie-fx/materials";
```

## Providers (all optional)

Every provider is OPTIONAL: an effect that references no file assets — for example the CLI default, whose billboards use the built-in procedural shape — renders with `new ThreeVfxRenderer({ scene, camera })` and nothing else. Add a provider only when the effect's manifest assets need it:

- `textureProvider` when effects reference texture files. Preload before spawning; `getTexture` must be synchronous.
- `meshProvider` when mesh-mode emitters reference prepared mesh assets. Resolve to `BufferGeometry`; raw FBX or other authoring formats are not runtime inputs.
- `materialGraphProvider` when emitters use non-default materials. Parse exported `.material` JSON into `ShaderGraph` objects keyed by graph ID and return them by shader ID.

```ts
const textureProvider: ThreeVfxTextureProvider = {
  async preload(refs) {
    await Promise.all(refs.map(loadTextureIntoCache));
  },
  getTexture(ref) {
    return textureCache.get(ref.path);
  },
};

const meshProvider: ThreeVfxMeshProvider = {
  getMeshGeometry(ref) {
    return geometryCache.get(ref.path) ?? null;
  },
};

// Parsed .material JSON from the bundle, keyed by graph id.
const materialGraphs = new Map<string, ShaderGraph>();
const materialGraphProvider = (shaderId: string) =>
  materialGraphs.get(shaderId);
```

## Mount and update

```ts
const effect = bundle.effectsById.get("world-impact");
if (!effect) throw new Error("Missing world-impact effect");

await textureProvider.preload?.(
  effect.assets.filter((asset) => asset.type === "texture"),
);

const vfx = new ThreeVfxRenderer({
  scene,
  camera,
  // The complete provider form; each is optional (see Providers above).
  textureProvider,
  meshProvider,
  materialGraphProvider,
});
const instance = vfx.createEffect(effect, {
  position: [0, 0, 0],
  seed: 42,
});

function frame(deltaSeconds: number) {
  vfx.update(deltaSeconds);
  renderer.render(scene, camera);
}
```

Call `vfx.setCamera(nextCamera)` when the host replaces its camera. Do not call both renderer and instance updates in one frame.

Use the instance for lifecycle, transforms, runtime parameters, render order, and visibility. Let NixieFX own only the group and particle objects it creates; keep scene, camera, clock, post-processing, URLs, and caches host-owned.

## Diagnostics and cleanup

Inspect `vfx.stats` for missing mesh or material references and unsupported features. Confirm the manifest's `three3d` support before creating the effect.

Remove the host frame callback, call `vfx.destroy()`, and release provider-owned textures and geometries. Update or destroy runtimes explicitly when scenes become inactive.
