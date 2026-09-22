import { describe, expect, it } from "vitest";
import { compileVfxExport } from "./compiler";
import { compareVfxExportToSources } from "./status";

function createSource(id: string, gravity = 0): Record<string, unknown> {
  return {
    app: "vfx-editor",
    kind: "particle-effect",
    version: 1,
    id,
    name: id,
    emitters: [{ id: `${id}-emitter`, forces: { gravity } }],
  };
}

function createManifest(
  sources: readonly { path: string; source: unknown }[],
): unknown {
  return compileVfxExport(
    sources.map((entry) => ({
      effect: entry.source,
      effectPath: `effects/${entry.path}`,
      sourceEffectFile: entry.path,
    })),
    { generatedAt: "2026-09-01T00:00:00.000Z" },
  ).manifest;
}

describe("compareVfxExportToSources", () => {
  it("reports exported, stale, unexported and orphaned effects", () => {
    const manifest = createManifest([
      { path: "fire.json", source: createSource("fire") },
      { path: "nested/smoke.json", source: createSource("smoke") },
      { path: "gone.json", source: createSource("gone") },
    ]);

    const comparison = compareVfxExportToSources(manifest, [
      { path: "fire.json", source: createSource("fire") },
      { path: "nested/smoke.json", source: createSource("smoke", 9) },
      { path: "new.json", source: createSource("new") },
    ]);

    expect(comparison.missingManifest).toBe(false);
    expect(comparison.generatedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(
      comparison.effects.map((entry) => [entry.path, entry.status]),
    ).toEqual([
      ["fire.json", "exported"],
      ["nested/smoke.json", "stale"],
      ["new.json", "unexported"],
    ]);
    expect(comparison.effects[0]?.effectId).toBe("fire");
    expect(comparison.effects[0]?.exportedPath).toBe("effects/fire.json");
    expect(comparison.orphans).toEqual([
      expect.objectContaining({
        effectId: "gone",
        exportedPath: "effects/gone.json",
        sourceEffectFile: "gone.json",
      }),
    ]);
    expect(comparison.counts).toEqual({
      exported: 1,
      stale: 1,
      unexported: 1,
      orphans: 1,
    });
    expect(comparison.outOfDate).toBe(true);
  });

  it("uses the exporter's own source hash so an unchanged source is exact", () => {
    const source = createSource("fire");
    const comparison = compareVfxExportToSources(
      createManifest([{ path: "fire.json", source }]),
      [{ path: "fire.json", source }],
    );

    expect(comparison.effects[0]?.sourceHash).toBe(
      comparison.effects[0]?.exportedSourceHash,
    );
    expect(comparison.outOfDate).toBe(false);
    expect(comparison.counts.exported).toBe(1);
  });

  it("treats an absent or unusable manifest as nothing exported", () => {
    for (const manifest of [
      null,
      undefined,
      "nope",
      { kind: "vfx-manifest" },
    ]) {
      const comparison = compareVfxExportToSources(manifest, [
        { path: "fire.json", source: createSource("fire") },
      ]);
      expect(comparison.missingManifest).toBe(true);
      expect(comparison.effects[0]?.status).toBe("unexported");
      expect(comparison.orphans).toEqual([]);
      expect(comparison.outOfDate).toBe(true);
    }
  });

  it("matches a manifest entry without sourceEffectFile by compiled path", () => {
    const manifest = createManifest([
      { path: "fire.json", source: createSource("fire") },
    ]) as { effects: Record<string, unknown>[] };
    delete manifest.effects[0]!.sourceEffectFile;

    const comparison = compareVfxExportToSources(manifest, [
      { path: "./fire.json", source: createSource("fire") },
    ]);
    expect(comparison.effects[0]?.status).toBe("exported");
    expect(comparison.orphans).toEqual([]);
  });
});
