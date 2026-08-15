import { describe, expect, it } from "vitest";
import {
  createEmptyAssetRedirectMap,
  normalizeAssetRedirectMap,
  recordAssetRedirect,
  resolveAssetRedirectPath,
  rewriteAssetRedirectPaths,
} from "./assetRedirects";

describe("asset redirects", () => {
  it("resolves chained redirects to the live path", () => {
    let map = createEmptyAssetRedirectMap();
    map = recordAssetRedirect(
      map,
      "TEXTURES/spark.png",
      "Textures/spark.png",
      1,
    );
    map = recordAssetRedirect(map, "Textures/spark.png", "FX/spark.png", 2);

    expect(resolveAssetRedirectPath("TEXTURES/spark.png", map)).toBe(
      "FX/spark.png",
    );
    expect(resolveAssetRedirectPath("Textures/spark.png", map)).toBe(
      "FX/spark.png",
    );
  });

  it("normalizes malformed redirect maps without throwing", () => {
    expect(
      normalizeAssetRedirectMap({
        redirects: [
          { from: "a.png", to: "b.png", at: 10 },
          { from: "", to: "c.png" },
          { from: "same.png", to: "same.png" },
        ],
      }).redirects,
    ).toEqual([{ from: "a.png", to: "b.png", at: 10 }]);
  });

  it("rewrites asset reference paths inside source JSON", () => {
    const map = recordAssetRedirect(
      createEmptyAssetRedirectMap(),
      "old/spark.png",
      "new/spark.png",
      1,
    );

    expect(
      rewriteAssetRedirectPaths(
        {
          render: { texture: "old/spark.png" },
          node: { tex: "old/spark.png" },
          param: { type: "texture", default: "old/spark.png" },
          textParam: { type: "float", default: "old/spark.png" },
          mesh: { type: "mesh", path: "old/spark.png" },
          untouched: "old/spark.png",
        },
        map,
      ),
    ).toEqual({
      render: { texture: "new/spark.png" },
      node: { tex: "new/spark.png" },
      param: { type: "texture", default: "new/spark.png" },
      textParam: { type: "float", default: "old/spark.png" },
      mesh: { type: "mesh", path: "new/spark.png" },
      untouched: "old/spark.png",
    });
  });
});
