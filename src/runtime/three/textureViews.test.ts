import {
  NoColorSpace,
  SRGBColorSpace,
  ShaderMaterial,
  Texture,
  Vector4,
} from "three";
import { describe, expect, it } from "vitest";
import {
  cloneShaderMaterialSharingTextures,
  cloneTextureView,
  rawColorSpaceTextureView,
} from "./textureViews";

function loadedTexture(): Texture {
  const texture = new Texture({ width: 4, height: 4 });
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

describe("texture views", () => {
  it("clones a view without marking the shared image dirty", () => {
    const source = loadedTexture();
    const sourceVersion = source.source.version;
    const view = cloneTextureView(source);
    expect(view).not.toBe(source);
    expect(view.source).toBe(source.source);
    expect(source.source.version).toBe(sourceVersion);
    // The view still has a pending version so three binds it on first use.
    expect(view.version).toBeGreaterThan(0);
  });

  it("shares one raw-colorspace view per source until the source is disposed", () => {
    const source = loadedTexture();
    const view = rawColorSpaceTextureView(source);
    expect(view).not.toBe(source);
    expect(view.colorSpace).toBe(NoColorSpace);
    expect(source.colorSpace).toBe(SRGBColorSpace);
    expect(rawColorSpaceTextureView(source)).toBe(view);
    let viewDisposed = false;
    view.addEventListener("dispose", () => {
      viewDisposed = true;
    });
    source.dispose();
    expect(viewDisposed).toBe(true);
    expect(rawColorSpaceTextureView(source)).not.toBe(view);
  });

  it("returns a raw-colorspace source as-is", () => {
    const source = loadedTexture();
    source.colorSpace = NoColorSpace;
    expect(rawColorSpaceTextureView(source)).toBe(source);
  });

  it("clones particle shader materials without cloning their textures", () => {
    const map = loadedTexture();
    const mask = loadedTexture();
    const sourceVersions = [map.source.version, mask.source.version];
    const material = new ShaderMaterial({
      uniforms: {
        uTexture: { value: map },
        uTex0: { value: mask },
        uEmpty: { value: null },
        uParticleColor: { value: new Vector4(1, 2, 3, 4) },
      },
    });
    const clone = cloneShaderMaterialSharingTextures(material);
    expect(clone.uniforms.uTexture!.value).toBe(map);
    expect(clone.uniforms.uTex0!.value).toBe(mask);
    expect(clone.uniforms.uEmpty!.value).toBeNull();
    // Per-particle uniforms are still independent copies.
    expect(clone.uniforms.uParticleColor!.value).not.toBe(
      material.uniforms.uParticleColor!.value,
    );
    expect(clone.uniforms.uParticleColor!.value).toEqual(
      new Vector4(1, 2, 3, 4),
    );
    // The source material keeps its textures and no image was marked dirty.
    expect(material.uniforms.uTexture!.value).toBe(map);
    expect(material.uniforms.uTex0!.value).toBe(mask);
    expect([map.source.version, mask.source.version]).toEqual(sourceVersions);
  });
});
