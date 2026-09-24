import { NoColorSpace, type ShaderMaterial, type Texture } from "three";

/**
 * Clones `texture` as another sampling view of the same image.
 *
 * `Texture.clone()` sets `needsUpdate`, which bumps the *shared* `Source`
 * version, and three.js then re-uploads the full image (a 2048x4096 atlas is
 * ~32MB) the next time any texture on that source is bound. The pixels did not
 * change, so the source version is restored. The view's own version stays
 * above 0, so it still binds; it only uploads when three needs a new GL
 * texture for it (different colorSpace/filtering) or the image never was.
 */
export function cloneTextureView(texture: Texture): Texture {
  const sourceVersion = texture.source.version;
  const view = texture.clone();
  view.source.version = sourceVersion;
  return view;
}

const rawTextureViews = new WeakMap<Texture, Texture>();

/**
 * The shared NoColorSpace view of `source` for graph shaders, which do math on
 * raw texel channels. Cached per source for its lifetime, so respawning an
 * effect never re-creates (and re-uploads) it; disposed with the source.
 */
export function rawColorSpaceTextureView(source: Texture): Texture {
  if (source.colorSpace === NoColorSpace) return source;
  const cached = rawTextureViews.get(source);
  if (cached) return cached;
  const view = cloneTextureView(source);
  view.colorSpace = NoColorSpace;
  rawTextureViews.set(source, view);
  source.addEventListener("dispose", () => {
    rawTextureViews.delete(source);
    view.dispose();
  });
  return view;
}

/**
 * Clones a particle ShaderMaterial for per-particle uniforms while sharing its
 * textures. `ShaderMaterial.clone()` deep-clones texture uniforms, which made
 * every newly drawn particle re-upload all of its material's textures.
 */
export function cloneShaderMaterialSharingTextures(
  material: ShaderMaterial,
): ShaderMaterial {
  const textures: Array<[string, Texture]> = [];
  for (const name in material.uniforms) {
    const value = material.uniforms[name]!.value as unknown;
    if ((value as Texture | null)?.isTexture) {
      textures.push([name, value as Texture]);
      material.uniforms[name]!.value = null;
    }
  }
  let clone: ShaderMaterial;
  try {
    clone = material.clone();
  } finally {
    for (const [name, texture] of textures) {
      material.uniforms[name]!.value = texture;
    }
  }
  for (const [name, texture] of textures) clone.uniforms[name]!.value = texture;
  return clone;
}
