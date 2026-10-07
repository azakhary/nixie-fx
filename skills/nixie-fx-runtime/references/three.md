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

## Host-controlled cross-emitter batching

Use `ThreeVfxBatcher` from `nixie-fx/three` when compatible stock billboard
emitters should share submissions. Keep emitters separate in authored data.

1. Create one batcher per host render scope, with the scene parent and a fragment
   sampler budget (`maxTextures`, default 4; supported 1–8).
2. Call `batcher.beginFrame()` before visibility changes and the single VFX update.
3. Build the host's final culled/sorted transparent list, including all external
   objects as barriers; exclude previously derived batch meshes.
4. Pass that list to `batcher.prepare(orderedObjects)`.
5. Give each returned `batch.mesh` the complete final sort key of
   `batch.firstSource`. The batcher copies renderOrder/layers, but the host must
   preserve group/depth/tie-break ordering as well. A merged bounding sphere is
   not an equivalent sort key.
6. Render once. For another camera, beginFrame/prepare again without a second
   simulation update. Dispose the batcher before provider textures and effects.

The batcher uses the existing textures, transforms, colors and alphas. It neither
resimulates nor globally reorders particles: both emitter and intra-emitter order
remain intact. Different textures use per-instance selection in one shader;
state incompatibility, intervening external objects and texture-budget overflow
split batches. Source visibility is restored by beginFrame/dispose. Pooled GPU
buffers persist until disposal. Host compile hooks must be equivalent for equal
program keys; do not double-install those hooks on derived materials.

Use `batcher.stats.savedDrawCalls` to compare with emitter-level `vfx.stats` and
validate actual renderer submissions. Check same-seed, frozen-time images from
multiple cameras, including a transparent blocker between emitters. Preserve
artist edits and do not reduce particle counts, DPR or diagnostics to claim a
batching improvement. See the README for a complete host integration sketch.
