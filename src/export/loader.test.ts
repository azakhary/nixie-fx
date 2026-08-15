import { describe, expect, it } from "vitest";
import { compileVfxExport } from "./compiler";
import { loadVfxExportBundle } from "./loader";

function createBundleInput() {
  const compiled = compileVfxExport(
    [
      {
        effect: {
          id: "spark",
          name: "Spark",
          targetProfile: "three-world-3d",
          emitters: [{ id: "main", render: { texture: "textures/spark.png" } }],
        },
        effectPath: "effects/spark.json",
        sourceEffectFile: "spark.json",
      },
    ],
    { generatedAt: "2026-07-10T00:00:00.000Z" },
  );
  return {
    manifest: compiled.manifest,
    effect: compiled.effects[0]!.effect,
  };
}

describe("official VFX export loader", () => {
  it("loads a complete supported bundle by manifest path", () => {
    const { manifest, effect } = createBundleInput();
    const bundle = loadVfxExportBundle(
      {
        manifest,
        effectsByPath: { "effects/spark.json": effect },
        assetPaths: ["textures/spark.png"],
      },
      {
        requiredBackend: "three3d",
        requiredEffectIds: ["spark"],
        requireEveryAsset: true,
      },
    );

    expect(bundle.effectsById.get("spark")).toBe(effect);
    expect(bundle.effectsByPath.get("effects/spark.json")).toBe(effect);
  });

  it("rejects a missing effect file", () => {
    const { manifest } = createBundleInput();
    expect(() => loadVfxExportBundle({ manifest, effectsByPath: {} })).toThrow(
      "missing effects/spark.json",
    );
  });

  it("rejects a stale manifest/effect pair", () => {
    const { manifest, effect } = createBundleInput();
    expect(() =>
      loadVfxExportBundle({
        manifest,
        effectsByPath: {
          "effects/spark.json": { ...effect, sourceHash: "fnv1a32:stale" },
        },
      }),
    ).toThrow("does not match its manifest entry (sourceHash)");
  });

  it("rejects a stale manifest aggregate hash", () => {
    const { manifest, effect } = createBundleInput();
    expect(() =>
      loadVfxExportBundle({
        manifest: { ...manifest, sourceHash: "fnv1a32:stale" },
        effectsByPath: { "effects/spark.json": effect },
      }),
    ).toThrow("manifest source hash is stale");
  });

  it("rejects missing exported assets when completeness is required", () => {
    const { manifest, effect } = createBundleInput();
    expect(() =>
      loadVfxExportBundle(
        {
          manifest,
          effectsByPath: { "effects/spark.json": effect },
          assetPaths: [],
        },
        { requireEveryAsset: true },
      ),
    ).toThrow("missing asset textures/spark.png");
  });
});
