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
```

## Providers

Preload exported textures before spawning effects and make `getTexture` synchronous. Resolve mesh references to prepared `BufferGeometry`; raw FBX or other authoring formats are not runtime inputs. Load exported `.material` JSON into a graph registry and resolve it by shader ID.

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
