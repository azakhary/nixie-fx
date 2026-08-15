import { Assets, type Container, type Texture } from "pixi.js";
import { type VfxTextureAssetRef } from "nixie-fx";
import { PixiVfxRenderer, type PixiVfxTextureProvider } from "nixie-fx/pixi";
import type { VfxExportManifest, VfxExportedEffect } from "nixie-fx/export";

export interface LoadedVfxBundle {
  manifest: VfxExportManifest;
  effects: Map<string, VfxExportedEffect>;
}

export async function loadVfxBundle(baseUrl: string): Promise<LoadedVfxBundle> {
  const root = baseUrl.replace(/\/+$/, "");
  const manifest = (await fetchJson(
    `${root}/manifest.json`,
  )) as VfxExportManifest;

  if (manifest.kind !== "vfx-manifest" || manifest.version !== 1) {
    throw new Error("Unsupported VFX manifest");
  }
  if (!manifest.validation.valid) {
    throw new Error("VFX manifest has export validation blockers");
  }

  const effects = new Map<string, VfxExportedEffect>();
  await Promise.all(
    manifest.effects.map(async (entry) => {
      if (entry.support.status === "blocked") return;
      const effect = (await fetchJson(
        `${root}/${entry.path}`,
      )) as VfxExportedEffect;
      effects.set(entry.id, effect);
    }),
  );

  return { manifest, effects };
}

export function createRawPixiAssetsProvider(
  rawAssetBaseUrl: string,
): PixiVfxTextureProvider {
  const root = rawAssetBaseUrl.replace(/\/+$/, "");
  const cache = new Map<string, Texture>();
  const urlFor = (ref: VfxTextureAssetRef) => `${root}/${ref.path}`;

  return {
    async preload(refs) {
      await Promise.all(
        refs.map(async (ref) => {
          const texture = await Assets.load<Texture>({
            alias: aliasFor(ref),
            src: urlFor(ref),
            parser: "texture",
          });
          cache.set(ref.path, texture);
        }),
      );
    },
    getTexture(ref) {
      return cache.get(ref.path);
    },
    resolveUrl(ref) {
      return urlFor(ref);
    },
    release() {
      for (const refPath of cache.keys()) {
        void Assets.unload(`vfx:${refPath}`).catch(() => undefined);
      }
      cache.clear();
    },
  };
}

export function createAtlasTextureProvider(
  frameTextures: Readonly<Record<string, Texture>>,
  rawPathToFrame: Readonly<Record<string, string>>,
): PixiVfxTextureProvider {
  return {
    getTexture(ref) {
      const frameName = rawPathToFrame[ref.path] ?? ref.path;
      return frameTextures[frameName];
    },
  };
}

export async function spawnVfxEffect(
  stage: Container,
  effect: VfxExportedEffect,
  textureProvider: PixiVfxTextureProvider,
): Promise<PixiVfxRenderer> {
  await textureProvider.preload?.(
    effect.assets.filter(
      (asset): asset is VfxTextureAssetRef => asset.type === "texture",
    ),
  );

  const renderer = new PixiVfxRenderer({
    parent: stage,
    textureProvider,
  });
  renderer.createEffect(effect, {
    position: [0, 0, 0],
    seed: 0xdecafbad,
  });
  return renderer;
}

export const atlasPathExample = {
  "particles/spark.png": "vfx/spark_01",
  "particles/smoke.png": "vfx/smoke_soft",
} as const;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}`);
  return response.json() as Promise<unknown>;
}

function aliasFor(ref: VfxTextureAssetRef): string {
  return `vfx:${ref.path}`;
}
