import type { ParticleMeshAssetRef } from "../../engine/particles";

export type VfxAssetKind = "texture" | "material" | "mesh";

/**
 * V1 game-facing texture reference.
 *
 * `path` is intentionally the raw path authored in the editor, relative to
 * the project's configured asset root. Games that pack files into atlases map
 * this raw path to their own frame name inside their provider.
 */
export interface VfxRawTextureAssetRef {
  type: "texture";
  id: string;
  path: string;
}

export type VfxTextureAssetRef = VfxRawTextureAssetRef;

/**
 * First-class material asset reference (techspec §3.2). Materials are stored
 * with a distinct `.material` extension (JSON inside) in a `materials/` folder,
 * created in the Assets navigator like effects and textures. `path` is the raw
 * project-relative path, same convention as {@link VfxRawTextureAssetRef}.
 */
export interface VfxMaterialAssetRef {
  type: "material";
  id: string;
  path: string;
}

export type VfxMeshAssetRef = ParticleMeshAssetRef;

export type VfxAssetRef =
  VfxTextureAssetRef | VfxMaterialAssetRef | VfxMeshAssetRef;

export interface VfxTextureProvider<TTexture = unknown> {
  preload?(refs: readonly VfxTextureAssetRef[]): Promise<void> | void;
  getTexture(ref: VfxTextureAssetRef): TTexture | undefined;
  resolveUrl?(ref: VfxTextureAssetRef): string | undefined;
  release?(scope?: string): void;
}
