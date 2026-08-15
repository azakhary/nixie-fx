import {
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type LoadingManager,
} from "three";
import type { ParticleEffectDefinition } from "../../engine/particles";
import {
  collectParticleTextureRefs,
  type CollectParticleTextureRefsOptions,
} from "../assets/textureRefs";
import type { VfxTextureAssetRef } from "../assets/types";
import type { ThreeVfxTextureProvider } from "./types";

export interface ThreeVfxTextureStoreOptions {
  resolveUrl: (path: string) => string;
  loadingManager?: LoadingManager;
  configureTexture?: (texture: Texture, ref: VfxTextureAssetRef) => void;
}

/** Game-facing owner for Three texture loading, configuration, and cleanup. */
export class ThreeVfxTextureStore implements ThreeVfxTextureProvider {
  private readonly loader: TextureLoader;
  private readonly textures = new Map<string, Texture>();
  private readonly pending = new Map<string, Promise<Texture>>();
  private generation = 0;
  private destroyed = false;

  constructor(private readonly options: ThreeVfxTextureStoreOptions) {
    this.loader = new TextureLoader(options.loadingManager);
  }

  preload(refs: readonly VfxTextureAssetRef[]): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error("ThreeVfxTextureStore is destroyed."));
    }
    return Promise.all(refs.map((ref) => this.load(ref))).then(() => undefined);
  }

  preloadEffect(
    effect: ParticleEffectDefinition,
    options: CollectParticleTextureRefsOptions = {},
  ): Promise<void> {
    return this.preload(collectParticleTextureRefs(effect, options));
  }

  getTexture(ref: VfxTextureAssetRef): Texture | undefined {
    return this.textures.get(ref.path);
  }

  resolveUrl(ref: VfxTextureAssetRef): string | undefined {
    if (this.destroyed) return undefined;
    return this.options.resolveUrl(ref.path);
  }

  release(): void {
    this.generation += 1;
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.pending.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.release();
    this.destroyed = true;
  }

  private load(ref: VfxTextureAssetRef): Promise<Texture> {
    const loaded = this.textures.get(ref.path);
    if (loaded) return Promise.resolve(loaded);
    const inFlight = this.pending.get(ref.path);
    if (inFlight) return inFlight;

    const generation = this.generation;
    let url: string;
    try {
      url = this.options.resolveUrl(ref.path);
      if (!url.trim()) throw new Error(`No URL resolved for "${ref.path}".`);
    } catch (error) {
      return Promise.reject(error);
    }
    const request = this.loader
      .loadAsync(url)
      .then((texture) => {
        if (this.destroyed || generation !== this.generation) {
          texture.dispose();
          throw new Error(`Texture load was released: "${ref.path}".`);
        }
        texture.name = ref.path;
        texture.colorSpace = SRGBColorSpace;
        this.options.configureTexture?.(texture, ref);
        texture.needsUpdate = true;
        this.textures.set(ref.path, texture);
        return texture;
      })
      .finally(() => {
        if (this.pending.get(ref.path) === request) {
          this.pending.delete(ref.path);
        }
      });
    this.pending.set(ref.path, request);
    return request;
  }
}
