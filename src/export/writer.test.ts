import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveProjectExportDirectory,
  resolveProjectOutputDirectory,
} from "./writer";
import { writeVfxExportFromProject } from "./nodeWriter";
import { VFX_ASSET_REDIRECTS_FILE } from "../runtime/assets/assetRedirects";

const tempRoots: string[] = [];

describe("vfx export writer", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute and escaping project-relative paths", () => {
    const projectRoot = createTempProject();

    expect(() =>
      resolveProjectExportDirectory(projectRoot, "../outside", "Output path"),
    ).toThrow("Output path must stay inside the project root");
    expect(() =>
      resolveProjectExportDirectory(projectRoot, "/tmp/out", "Output path"),
    ).toThrow("Output path must be relative to the project root");
  });

  it("allows external output only when explicitly opted in", () => {
    const workspaceRoot = createTempProject();
    const projectRoot = resolve(workspaceRoot, "project");
    mkdirSync(projectRoot, { recursive: true });

    expect(() =>
      resolveProjectOutputDirectory(projectRoot, "../game-vfx", false),
    ).toThrow("Output path must stay inside the project root");
    expect(
      resolveProjectOutputDirectory(projectRoot, "../game-vfx", true),
    ).toMatchObject({
      absolutePath: resolve(workspaceRoot, "game-vfx"),
      relativePath: "../game-vfx",
    });
  });

  it("writes a self-contained export and preserves asset bytes", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "particle-data/effects/spark.json"), {
      id: "spark",
      name: "Spark",
      emitters: [
        {
          id: "emitter",
          modules: { velocity: true },
          spawn: {
            rateValue: {
              mode: "constant",
              value: 12,
              editorMin: 0,
              editorMax: 100,
            },
          },
          render: { texture: "spark.png" },
        },
      ],
    });
    const assetPath = resolve(projectRoot, "assets/spark.png");
    mkdirSync(dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, "raw");

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.effectCount).toBe(1);
    expect(result.assetRootPath).toBe("assets");
    expect(result.writtenFiles.map((file) => file.path).sort()).toEqual([
      "out/vfx/effects/spark.json",
      "out/vfx/manifest.json",
      "out/vfx/spark.png",
    ]);
    expect(existsSync(resolve(projectRoot, "assets/spark.png"))).toBe(true);
    expect(
      readFileSync(resolve(projectRoot, "out/vfx/spark.png"), "utf8"),
    ).toBe("raw");
    expect(
      existsSync(resolve(projectRoot, "out/vfx/export-diagnostics.json")),
    ).toBe(false);

    const effect = JSON.parse(
      readFileSync(resolve(projectRoot, "out/vfx/effects/spark.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(effect.kind).toBe("vfx-effect");
    expect(effect.generatedAt).toBe("2026-06-15T00:00:00.000Z");
    expect(effect.sourceEffectFile).toBe("spark.json");
    expect(effect.sourceEffectId).toBe("spark");
    expect(effect.sourceHash).toEqual(expect.stringMatching(/^fnv1a32:/));
    expect(JSON.stringify(effect)).not.toContain("editorMin");
    expect(JSON.stringify(effect)).not.toContain("editorMax");

    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, "out/vfx/manifest.json"), "utf8"),
    ) as { effects?: { path?: string }[]; assets?: { path?: string }[] };
    expect(manifest.effects?.[0]?.path).toBe("effects/spark.json");
    expect(manifest.effects?.[0]).toMatchObject({
      sourceEffectFile: "spark.json",
      sourceEffectId: "spark",
    });
    expect(manifest.assets?.[0]?.path).toBe("spark.png");
  });

  it("ignores non-effect JSON (prepared meshes, manifests) sharing the effect root", async () => {
    // Unified project layout: effect data path "." holds effects/, meshes/
    // and textures side by side. The mesh JSON must not be mistaken for an
    // effect (it would block the whole export with "Effect id is required").
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "effects/embers.json"), {
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "embers",
      name: "Embers",
      emitters: [
        {
          id: "emitter",
          modules: { velocity: true },
          render: { texture: "glow.png" },
        },
      ],
    });
    writeJson(resolve(projectRoot, "meshes/digit.json"), {
      metadata: { version: 4.7, type: "BufferGeometry" },
      uuid: "not-an-effect",
      type: "BufferGeometry",
      data: { attributes: {} },
    });
    const assetPath = resolve(projectRoot, "glow.png");
    mkdirSync(dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, "png");

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: ".",
      assetRootPath: ".",
      outputPath: "out/vfx",
      generatedAt: "2026-08-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.effectCount).toBe(1);
    expect(result.validation.blockers).toEqual([]);
  });

  it("exports only the requested effect and its referenced assets", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "particle-data/effects/fire.json"), {
      id: "fire",
      name: "Fire",
      emitters: [{ id: "fire-emitter", render: { texture: "fire.png" } }],
    });
    writeJson(resolve(projectRoot, "particle-data/effects/smoke.json"), {
      id: "smoke",
      name: "Smoke",
      emitters: [{ id: "smoke-emitter", render: { texture: "smoke.png" } }],
    });
    mkdirSync(resolve(projectRoot, "assets"), { recursive: true });
    writeFileSync(resolve(projectRoot, "assets/fire.png"), "fire");
    writeFileSync(resolve(projectRoot, "assets/smoke.png"), "smoke");

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      effectFile: "smoke.json",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.effectCount).toBe(1);
    expect(result.manifest?.effects).toEqual([
      expect.objectContaining({
        sourceEffectFile: "smoke.json",
        path: "effects/smoke.json",
      }),
    ]);
    expect(result.writtenFiles.map((file) => file.path).sort()).toEqual([
      "out/vfx/effects/smoke.json",
      "out/vfx/manifest.json",
      "out/vfx/smoke.png",
    ]);
    expect(existsSync(resolve(projectRoot, "out/vfx/fire.png"))).toBe(false);
    expect(existsSync(resolve(projectRoot, "out/vfx/effects/fire.json"))).toBe(
      false,
    );
  });

  it("rejects a requested effect that is outside or missing from the effect root", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "particle-data/effects/spark.json"), {
      id: "spark",
      name: "Spark",
      emitters: [],
    });
    const options = {
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "out/vfx",
    };

    await expect(
      writeVfxExportFromProject({ ...options, effectFile: "../spark.json" }),
    ).rejects.toThrow("Effect file path must stay inside the project root");
    await expect(
      writeVfxExportFromProject({ ...options, effectFile: "missing.json" }),
    ).rejects.toThrow('Effect file "missing.json" was not found');
  });

  it("exports effects and assets from folders outside the project root", async () => {
    const workspaceRoot = createTempProject();
    const projectRoot = resolve(workspaceRoot, "project");
    const effectsRoot = resolve(workspaceRoot, "shared-effects");
    const assetsRoot = resolve(workspaceRoot, "shared-assets");
    mkdirSync(projectRoot, { recursive: true });
    writeJson(resolve(effectsRoot, "nested/spark.json"), {
      id: "external-spark",
      name: "External Spark",
      emitters: [{ id: "emitter", render: { texture: "particles/spark.png" } }],
    });
    const assetPath = resolve(assetsRoot, "particles/spark.png");
    mkdirSync(dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, "raw");

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "../shared-effects",
      assetRootPath: "../shared-assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.effectDataPath).toBe("../shared-effects");
    expect(result.assetRootPath).toBe("../shared-assets");
    expect(result.effectCount).toBe(1);
    expect(result.writtenFiles.map((file) => file.path).sort()).toEqual([
      "out/vfx/effects/nested/spark.json",
      "out/vfx/manifest.json",
      "out/vfx/particles/spark.png",
    ]);

    const effect = JSON.parse(
      readFileSync(
        resolve(projectRoot, "out/vfx/effects/nested/spark.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(effect.sourceEffectFile).toBe("nested/spark.json");
    expect(effect.sourceEffectId).toBe("external-spark");
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, "out/vfx/manifest.json"), "utf8"),
    ) as { assets?: { path?: string }[] };
    expect(manifest.assets?.[0]?.path).toBe("particles/spark.png");
  });

  it("writes export output outside the project when external output is opted in", async () => {
    const workspaceRoot = createTempProject();
    const projectRoot = resolve(workspaceRoot, "project");
    mkdirSync(projectRoot, { recursive: true });
    writeJson(resolve(projectRoot, "particle-data/effects/spark.json"), {
      id: "external-output-spark",
      name: "External Output Spark",
      emitters: [{ id: "emitter" }],
    });

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "../game-vfx",
      allowExternalOutput: true,
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.outputPath).toBe("../game-vfx");
    expect(
      existsSync(resolve(workspaceRoot, "game-vfx/effects/spark.json")),
    ).toBe(true);
    expect(
      existsSync(resolve(projectRoot, "game-vfx/effects/spark.json")),
    ).toBe(false);
  });

  it("does not re-ingest prior output when the effect source root is the project root", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "spark.json"), {
      id: "source-spark",
      name: "Source Spark",
      emitters: [{ id: "emitter" }],
    });
    writeJson(resolve(projectRoot, "out/vfx/effects/old-export.json"), {
      id: "old-export",
      name: "Old Export",
      emitters: [{ id: "stale" }],
    });

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: ".",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.effectCount).toBe(1);
    expect(result.writtenFiles.map((file) => file.path).sort()).toEqual([
      "out/vfx/effects/spark.json",
      "out/vfx/manifest.json",
    ]);
  });

  it("writes diagnostics instead of supported output when raw assets are missing", async () => {
    const projectRoot = createTempProject();
    writeJson(
      resolve(projectRoot, "particle-data/effects/missing-asset.json"),
      {
        id: "missing-asset",
        name: "Missing Asset",
        emitters: [
          {
            id: "emitter",
            render: { texture: "missing/spark.png" },
          },
        ],
      },
    );

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.validation.blockers).toEqual([
      expect.objectContaining({
        code: "invalid-asset-ref",
        path: "missing-asset.json.assets.0.path",
        message:
          'Missing raw texture asset "missing/spark.png" in asset root "assets".',
      }),
    ]);
    expect(result.writtenFiles.map((file) => file.path)).toEqual([
      "out/vfx/export-diagnostics.json",
    ]);
    expect(existsSync(resolve(projectRoot, "out/vfx/manifest.json"))).toBe(
      false,
    );

    const diagnostics = JSON.parse(
      readFileSync(
        resolve(projectRoot, "out/vfx/export-diagnostics.json"),
        "utf8",
      ),
    ) as {
      assetRootPath?: string;
      validation?: { blockers?: unknown[] };
    };
    expect(diagnostics.assetRootPath).toBe("assets");
    expect(diagnostics.validation?.blockers).toHaveLength(1);
  });

  it("rewrites redirected asset paths before export", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "particle-data/effects/redirected.json"), {
      id: "redirected",
      name: "Redirected",
      emitters: [
        {
          id: "emitter",
          render: { texture: "TEXTURES/old.png" },
        },
      ],
    });
    const assetPath = resolve(projectRoot, "assets/Textures/live.png");
    mkdirSync(dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, "raw");
    writeJson(resolve(projectRoot, "assets", VFX_ASSET_REDIRECTS_FILE), {
      version: 1,
      redirects: [{ from: "TEXTURES/old.png", to: "Textures/live.png", at: 1 }],
    });

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.assets).toContainEqual({
      id: "live",
      type: "texture",
      path: "Textures/live.png",
    });
    const effect = JSON.parse(
      readFileSync(
        resolve(projectRoot, "out/vfx/effects/redirected.json"),
        "utf8",
      ),
    ) as { emitters?: { render?: { texture?: string } }[] };
    expect(effect.emitters?.[0]?.render?.texture).toBe("Textures/live.png");
  });

  it("writes diagnostics and removes stale generated output when blocked", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "particle-data/effects/bad-sheet.json"), {
      id: "bad-sheet",
      name: "Bad Sheet",
      emitters: [
        {
          id: "emitter",
          modules: { textureSheetAnimation: true },
          advanced: {
            textureSheetAnimation: {
              mode: "atlas",
              frames: ["spark-a", "spark-b"],
            },
          },
        },
      ],
    });
    writeJson(resolve(projectRoot, "out/vfx/manifest.json"), {
      stale: true,
    });
    writeJson(resolve(projectRoot, "out/vfx/effects/stale.json"), {
      stale: true,
    });

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.validation.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "emitters.0.advanced.textureSheetAnimation.mode",
        }),
      ]),
    );
    expect(result.writtenFiles.map((file) => file.path)).toEqual([
      "out/vfx/export-diagnostics.json",
    ]);
    expect(existsSync(resolve(projectRoot, "out/vfx/manifest.json"))).toBe(
      false,
    );
    expect(existsSync(resolve(projectRoot, "out/vfx/effects/stale.json"))).toBe(
      false,
    );

    const diagnostics = JSON.parse(
      readFileSync(
        resolve(projectRoot, "out/vfx/export-diagnostics.json"),
        "utf8",
      ),
    ) as { validation?: { blockers?: unknown[] } };
    expect(diagnostics.validation?.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "emitters.0.advanced.textureSheetAnimation.mode",
        }),
      ]),
    );
  });

  it("exports material asset refs with real project .material paths", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "assets/materials/gvidon.material"), {
      id: "M_Gvidon",
      name: "Gvidon",
      blend: "normal",
      nodes: [
        {
          id: "round",
          type: "sphericalParticleOpacity",
          inputs: {},
          params: { density: 0.32, center: [0.5, 0.5, 0, 0], radius: 0.4 },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [
        {
          id: "e-base",
          source: "round",
          sourceHandle: "Opacity",
          target: "output",
          targetHandle: "baseColor",
        },
        {
          id: "e-opacity",
          source: "round",
          sourceHandle: "Opacity",
          target: "output",
          targetHandle: "opacity",
        },
      ],
      params: [],
      outputs: { baseColor: "e-base", opacity: "e-opacity" },
    });
    writeJson(resolve(projectRoot, "particle-data/effects/round.json"), {
      id: "round",
      name: "Round",
      emitters: [
        {
          id: "emitter",
          render: {
            material: { id: "inst-gvidon", shaderId: "M_Gvidon" },
          },
        },
      ],
    });

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.assets).toContainEqual({
      id: "M_Gvidon",
      type: "material",
      path: "materials/gvidon.material",
    });

    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, "out/vfx/manifest.json"), "utf8"),
    ) as { assets?: unknown[] };
    expect(manifest.assets).toContainEqual({
      id: "M_Gvidon",
      type: "material",
      path: "materials/gvidon.material",
    });
  });

  it("exports material asset refs from a custom materials folder", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "assets/fx-materials/gvidon.material"), {
      id: "M_CustomFolder",
      name: "Custom Folder Material",
      blend: "normal",
      nodes: [],
      edges: [],
      params: [],
      outputs: {},
    });
    writeJson(resolve(projectRoot, "particle-data/effects/custom-mat.json"), {
      id: "custom-mat",
      name: "Custom Mat",
      emitters: [
        {
          id: "emitter",
          render: {
            material: { id: "inst-custom", shaderId: "M_CustomFolder" },
          },
        },
      ],
    });

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      materialsFolder: "fx-materials",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.assets).toContainEqual({
      id: "M_CustomFolder",
      type: "material",
      path: "fx-materials/gvidon.material",
    });
  });

  it("blocks project export when an effect references a missing material graph", async () => {
    const projectRoot = createTempProject();
    writeJson(resolve(projectRoot, "particle-data/effects/missing-mat.json"), {
      id: "missing-mat",
      name: "Missing Material",
      emitters: [
        {
          id: "emitter",
          render: {
            texture: "spark.png",
            material: {
              id: "inst-missing",
              shaderId: "M_Missing",
              mainTex: { type: "texture", id: "spark", path: "spark.png" },
            },
          },
        },
      ],
    });
    const assetPath = resolve(projectRoot, "assets/spark.png");
    mkdirSync(dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, "raw");

    const result = await writeVfxExportFromProject({
      projectRoot,
      effectDataPath: "particle-data/effects",
      assetRootPath: "assets",
      outputPath: "out/vfx",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.validation.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-material",
          path: "emitters.0.render.material",
        }),
      ]),
    );
    expect(result.writtenFiles.map((file) => file.path)).toEqual([
      "out/vfx/export-diagnostics.json",
    ]);
    expect(existsSync(resolve(projectRoot, "out/vfx/manifest.json"))).toBe(
      false,
    );
  });
});

function createTempProject(): string {
  const root = mkdtempSync(resolve(tmpdir(), "vfx-export-writer-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
