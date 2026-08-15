import { describe, expect, it } from "vitest";
import { normalizeVfxAssetPath, validateVfxTextureAssetPath } from "./paths";
import type { VfxRawTextureAssetRef, VfxTextureAssetRef } from "./types";

describe("vfx asset paths", () => {
  it("normalizes raw texture paths relative to the project asset root", () => {
    expect(normalizeVfxAssetPath("./particles//spark.png")).toBe(
      "particles/spark.png",
    );
    expect(validateVfxTextureAssetPath("particles/spark.png")).toMatchObject({
      valid: true,
      path: "particles/spark.png",
    });
  });

  it("rejects paths that cannot safely resolve inside the asset root", () => {
    expect(validateVfxTextureAssetPath("../spark.png")).toMatchObject({
      valid: false,
      reason: "traversal",
    });
    expect(validateVfxTextureAssetPath("https://cdn/spark.png")).toMatchObject({
      valid: false,
      reason: "url",
    });
    expect(validateVfxTextureAssetPath("particles\\spark.png")).toMatchObject({
      valid: false,
      reason: "backslash",
    });
  });

  it("keeps the v1 raw texture ref compatible with texture providers", () => {
    const rawRef = {
      type: "texture",
      id: "spark",
      path: "particles/spark.png",
    } satisfies VfxRawTextureAssetRef;
    const textureRef: VfxTextureAssetRef = rawRef;

    expect(textureRef).toEqual({
      type: "texture",
      id: "spark",
      path: "particles/spark.png",
    });
  });
});
