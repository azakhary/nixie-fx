# PixiJS runtime

Install and import only the Pixi adapter:

```sh
npm install nixie-fx pixi.js
```

```ts
import { Assets, type Texture } from "pixi.js";
import { PixiVfxRenderer, type PixiVfxTextureProvider } from "nixie-fx/pixi";
import type { VfxTextureAssetRef } from "nixie-fx";
```

## Texture provider

Preload asynchronously, then return synchronously during rendering:

```ts
function createTextureProvider(baseUrl: string): PixiVfxTextureProvider {
  const cache = new Map<string, Texture>();
  const loadedUrls = new Set<string>();

  return {
    async preload(refs) {
      await Promise.all(
        refs.map(async (ref) => {
          const src = `${baseUrl.replace(/\/+$/, "")}/${ref.path}`;
          cache.set(ref.path, await Assets.load<Texture>(src));
          loadedUrls.add(src);
        }),
      );
    },
    getTexture(ref: VfxTextureAssetRef) {
      return cache.get(ref.path);
    },
    resolveUrl(ref) {
      return `${baseUrl.replace(/\/+$/, "")}/${ref.path}`;
    },
    release() {
      for (const src of loadedUrls)
        void Assets.unload(src).catch(() => undefined);
      loadedUrls.clear();
      cache.clear();
    },
  };
}
```

For atlases, keep `ref.path` as the stable key and map it to the host frame name in `getTexture`.

## Mount and update

```ts
const effect = bundle.effectsById.get("fire-burst");
if (!effect) throw new Error("Missing fire-burst effect");

const textureProvider = createTextureProvider(bundleBaseUrl);
await textureProvider.preload?.(
  effect.assets.filter((asset) => asset.type === "texture"),
);

const vfx = new PixiVfxRenderer({
  parent: app.stage,
  textureProvider,
  materialGraphProvider,
  effectProvider,
});
const instance = vfx.createEffect(effect, { seed: 42 });

app.ticker.add((ticker) => {
  vfx.update(ticker.deltaMS / 1000);
});
```

Provide `effectProvider` when authored sub-emitters reference other exported effects. Sub-emitter `effectFile` values retain their authoring-relative key, while `bundle.effectsByPath` uses compiled output paths. Index loaded effects by `sourceEffectFile`:

```ts
const effectsBySourceFile = new Map(
  [...bundle.effectsById.values()].flatMap((loadedEffect) =>
    loadedEffect.sourceEffectFile
      ? [[loadedEffect.sourceEffectFile, loadedEffect] as const]
      : [],
  ),
);
const effectProvider = {
  getEffect(effectFile: string) {
    return effectsBySourceFile.get(effectFile);
  },
};
```

Provide `materialGraphProvider` when an emitter uses a non-default material. Inject a projection when world coordinates do not match the default 2D projection.

Do not call `instance.update` from the same ticker. The Pixi instance exposes `spawn`, `reset`, `stop`, `setPosition`, and `destroy`; its `root.visible` controls visibility. Pause by stopping the owning ticker/update call. Do not assume the Three-only lifecycle methods exist on Pixi instances.

## Diagnostics and cleanup

Inspect `vfx.stats` for missing texture, material, or sub-emitter references and unsupported modules or features. Treat these as integration failures unless they are explicitly accepted.

Remove the ticker callback, call `vfx.destroy()`, then release provider-owned assets. Pause or destroy the renderer whenever its owning pane or scene is inactive.
