import { describe, expect, it } from "vitest";
import {
  compileVfxEffect,
  compileVfxExport,
  createVfxSourceHash,
} from "./compiler";
import {
  createMaterialInstance,
  normalizeShaderGraph,
  serializeShaderGraph,
} from "../runtime/schema/materials";
import { compileMaterial } from "../runtime/materials";

describe("vfx export compiler", () => {
  it("strips scalar editor ranges and preserves runtime module data", () => {
    const source = {
      id: "spark-burst",
      name: "Spark Burst",
      emitters: [
        {
          id: "emitter-a",
          modules: {
            velocity: true,
            inheritVelocity: true,
          },
          spawn: {
            rateValue: {
              mode: "constant",
              value: 12,
              editorMin: 0,
              editorMax: 3000,
            },
          },
          advanced: {
            inheritVelocity: {
              mode: "initial",
              multiplier: {
                mode: "constant",
                value: 0.5,
                editorMin: -4,
                editorMax: 4,
              },
            },
          },
          render: {
            texture: "sparks/spark.png",
          },
        },
      ],
    };
    const compiled = compileVfxEffect(source, {
      generatedAt: "2026-06-15T00:00:00.000Z",
      sourceEffectFile: "spark-burst.json",
    });

    const emitter = compiled.effect.emitters[0];
    expect(compiled.effect.generatedAt).toBe("2026-06-15T00:00:00.000Z");
    expect(compiled.effect.sourceEffectFile).toBe("spark-burst.json");
    expect(compiled.effect.sourceEffectId).toBe("spark-burst");
    expect(compiled.effect.sourceHash).toBe(createVfxSourceHash(source));
    expect(emitter?.spawn.rateValue).toMatchObject({
      mode: "constant",
      value: 12,
    });
    expect(emitter?.spawn.rateValue).not.toHaveProperty("editorMin");
    expect(emitter?.spawn.rateValue).not.toHaveProperty("editorMax");
    expect(emitter?.advanced.inheritVelocity.multiplier).toMatchObject({
      mode: "constant",
      value: 0.5,
    });
    expect(emitter?.advanced.inheritVelocity.multiplier).not.toHaveProperty(
      "editorMin",
    );
    expect(emitter?.modules.inheritVelocity).toBe(true);
    expect(emitter?.render.texture).toBe("sparks/spark.png");
    expect(compiled.assets).toEqual([
      { type: "texture", id: "spark", path: "sparks/spark.png" },
    ]);
    expect(compiled.validation.valid).toBe(true);
  });

  it("preserves effect timeline metadata in compiled output", () => {
    const compiled = compileVfxEffect({
      id: "timeline-effect",
      timeline: {
        frameRate: 60,
        duration: 3,
        loop: { enabled: true, start: 0.5, end: 1.5 },
        groups: [{ id: "group-a", name: "Group A", locked: true }],
      },
      emitters: [
        {
          id: "emitter-a",
          duration: 1,
          timeline: { start: 0.25, groupId: "group-a" },
        },
      ],
    });

    expect(compiled.effect.timeline).toMatchObject({
      frameRate: 60,
      duration: 3,
      loop: { enabled: true, start: 0.5, end: 1.5 },
      groups: [{ id: "group-a", name: "Group A", locked: true }],
    });
    expect(compiled.effect.emitters[0]?.timeline).toMatchObject({
      start: 0.25,
      groupId: "group-a",
    });
  });

  it("emits a golden exported effect and manifest shape", () => {
    const source = {
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "golden-spark",
      name: "Golden Spark",
      emitters: [
        {
          id: "spark-main",
          name: "Spark Main",
          modules: { velocity: true },
          spawn: {
            rateValue: {
              mode: "constant",
              value: 4,
              editorMin: 0,
              editorMax: 100,
            },
          },
          render: { texture: "sparks/spark.png", blend: "additive" },
        },
      ],
    };
    const compiled = compileVfxExport(
      [
        {
          effect: source,
          effectPath: "effects/golden-spark.json",
          sourceEffectFile: "golden-spark.json",
        },
      ],
      { generatedAt: "2026-06-15T00:00:00.000Z" },
    );
    const effect = compiled.effects[0]?.effect;
    const emitter = effect?.emitters[0];

    expect({
      effect: {
        kind: effect?.kind,
        version: effect?.version,
        generatedAt: effect?.generatedAt,
        id: effect?.id,
        name: effect?.name,
        sourceEffectFile: effect?.sourceEffectFile,
        sourceEffectId: effect?.sourceEffectId,
        sourceHash: effect?.sourceHash,
        assets: effect?.assets,
        support: effect?.support,
        emitter: {
          id: emitter?.id,
          name: emitter?.name,
          texture: emitter?.render.texture,
          blend: emitter?.render.blend,
          rateValue: {
            mode: emitter?.spawn.rateValue.mode,
            value: emitter?.spawn.rateValue.value,
          },
        },
      },
      manifest: compiled.manifest,
    }).toMatchInlineSnapshot(`
      {
        "effect": {
          "assets": [
            {
              "id": "spark",
              "path": "sparks/spark.png",
              "type": "texture",
            },
          ],
          "emitter": {
            "blend": "additive",
            "id": "spark-main",
            "name": "Spark Main",
            "rateValue": {
              "mode": "constant",
              "value": 4,
            },
            "texture": "sparks/spark.png",
          },
          "generatedAt": "2026-06-15T00:00:00.000Z",
          "id": "golden-spark",
          "kind": "vfx-effect",
          "name": "Golden Spark",
          "sourceEffectFile": "golden-spark.json",
          "sourceEffectId": "golden-spark",
          "sourceHash": "fnv1a32:9ce39c16",
          "support": {
            "backends": {
              "pixi2d": {
                "backend": "pixi2d",
                "blockers": [],
                "status": "supported",
                "warnings": [],
              },
              "three3d": {
                "backend": "three3d",
                "blockers": [],
                "status": "supported",
                "warnings": [],
              },
            },
            "overall": "supported",
            "partialModules": [],
            "portableSubset": true,
            "preferredBackend": "pixi2d",
            "status": "supported",
            "targetProfile": "pixi-ui-2d",
            "unsupportedModules": [],
            "warnings": [],
          },
          "version": 1,
        },
        "manifest": {
          "assets": [
            {
              "id": "spark",
              "path": "sparks/spark.png",
              "type": "texture",
            },
          ],
          "effects": [
            {
              "id": "golden-spark",
              "name": "Golden Spark",
              "path": "effects/golden-spark.json",
              "sourceEffectFile": "golden-spark.json",
              "sourceEffectId": "golden-spark",
              "sourceHash": "fnv1a32:9ce39c16",
              "support": {
                "backends": {
                  "pixi2d": {
                    "backend": "pixi2d",
                    "blockers": [],
                    "status": "supported",
                    "warnings": [],
                  },
                  "three3d": {
                    "backend": "three3d",
                    "blockers": [],
                    "status": "supported",
                    "warnings": [],
                  },
                },
                "overall": "supported",
                "partialModules": [],
                "portableSubset": true,
                "preferredBackend": "pixi2d",
                "status": "supported",
                "targetProfile": "pixi-ui-2d",
                "unsupportedModules": [],
                "warnings": [],
              },
            },
          ],
          "generatedAt": "2026-06-15T00:00:00.000Z",
          "kind": "vfx-manifest",
          "sourceHash": "fnv1a32:dfe2baed",
          "validation": {
            "blockers": [],
            "errors": [],
            "valid": true,
            "warnings": [],
          },
          "version": 1,
        },
      }
    `);
  });

  it("preserves render order in layer in the exported emitter", () => {
    const compiled = compileVfxEffect({
      id: "ordered-effect",
      emitters: [
        { id: "back", render: { orderInLayer: -3 } },
        { id: "front", render: { orderInLayer: 7 } },
      ],
    });

    expect(compiled.effect.emitters[0]?.render.orderInLayer).toBe(-3);
    expect(compiled.effect.emitters[1]?.render.orderInLayer).toBe(7);
  });

  it("preserves render opacity source and invert in the exported emitter", () => {
    const compiled = compileVfxEffect({
      id: "opacity-effect",
      emitters: [
        {
          id: "mask",
          render: {
            texture: "fx/mask.png",
            opacitySource: "luminance",
            opacityInvert: true,
          },
        },
        { id: "bogus", render: { opacitySource: "not-a-channel" } },
      ],
    });

    expect(compiled.effect.emitters[0]?.render.opacitySource).toBe("luminance");
    expect(compiled.effect.emitters[0]?.render.opacityInvert).toBe(true);
    // Unknown channels normalize back to the safe default.
    expect(compiled.effect.emitters[1]?.render.opacitySource).toBe(
      "textureAlpha",
    );
  });

  it("preserves HDR emissive intensity in the exported emitter", () => {
    const compiled = compileVfxEffect({
      id: "hdr-effect",
      emitters: [
        {
          id: "hdr",
          initializeParticle: {
            color: { intensity: { mode: "constant", value: 8 } },
          },
        },
      ],
    });

    expect(
      compiled.effect.emitters[0]?.initializeParticle.color.intensity.value,
    ).toBe(8);
  });

  it("preserves large typed HDR emissive intensity without validation warnings", () => {
    const compiled = compileVfxEffect({
      id: "hdr-effect-50",
      emitters: [
        {
          id: "hdr",
          initializeParticle: {
            color: { intensity: { mode: "constant", value: 2 ** 50 } },
          },
        },
      ],
    });

    expect(
      compiled.effect.emitters[0]?.initializeParticle.color.intensity.value,
    ).toBeCloseTo(2 ** 50);
    expect(compiled.validation.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "clamped-value",
          path: expect.stringContaining("initializeParticle.color.intensity"),
        }),
      ]),
    );
  });

  it("dedupes texture refs in the generated manifest", () => {
    const compiled = compileVfxExport(
      [
        {
          effect: {
            id: "first-effect",
            name: "First",
            emitters: [{ id: "first", render: { texture: "fx/spark.png" } }],
          },
          effectPath: "effects/first.json",
        },
        {
          effect: {
            id: "second-effect",
            name: "Second",
            emitters: [{ id: "second", render: { texture: "fx/spark.png" } }],
          },
          effectPath: "effects/second.json",
        },
      ],
      { generatedAt: "2026-06-15T00:00:00.000Z" },
    );

    expect(compiled.manifest).toMatchObject({
      kind: "vfx-manifest",
      version: 1,
      generatedAt: "2026-06-15T00:00:00.000Z",
      effects: [
        { id: "first-effect", path: "effects/first.json" },
        { id: "second-effect", path: "effects/second.json" },
      ],
      assets: [{ id: "spark", type: "texture", path: "fx/spark.png" }],
    });
    expect(compiled.validation.valid).toBe(true);
  });

  it("exports align-to-direction and uniform grid texture sheet animation as partial (no blockers)", () => {
    const compiled = compileVfxEffect(
      {
        id: "sheet-align",
        name: "Sheet Align",
        emitters: [
          {
            id: "sheet-emitter",
            modules: {
              velocity: true,
              noise: true,
              textureSheetAnimation: true,
            },
            spawn: {
              alignToDirection: true,
            },
            render: {
              texture: "fx/sheet.png",
            },
            advanced: {
              textureSheetAnimation: {
                mode: "grid",
                tiles: [4, 2],
                startFrame: 1,
                endFrame: 8,
                frameOverTime: { mode: "constant", value: 3 },
                cycles: 2,
                randomStartFrame: true,
              },
            },
          },
        ],
      },
      { generatedAt: "2026-06-15T00:00:00.000Z" },
    );
    const emitter = compiled.effect.emitters[0];

    expect(compiled.effect.support.status).toBe("partial");
    expect(compiled.effect.support.unsupportedModules).toEqual([]);
    expect(compiled.effect.support.partialModules).toEqual(
      expect.arrayContaining([
        "emitters.0.modules.noise",
        "emitters.0.modules.textureSheetAnimation",
      ]),
    );
    expect(compiled.effect.support.warnings.length).toBeGreaterThan(0);
    expect(compiled.validation.valid).toBe(true);
    expect(compiled.validation.blockers).toEqual([]);
    expect(compiled.validation.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "emitters.0.modules.noise" }),
        expect.objectContaining({
          path: "emitters.0.modules.textureSheetAnimation",
        }),
      ]),
    );
    expect(emitter?.spawn.alignToDirection).toBe(true);
    expect(emitter?.modules.textureSheetAnimation).toBe(true);
    expect(emitter?.advanced.textureSheetAnimation).toMatchObject({
      tiles: [4, 2],
      startFrame: 1,
      endFrame: 8,
      cycles: 2,
      randomStartFrame: true,
    });
  });

  it("marks warning-only partial modules as partial support in effect and manifest", () => {
    const compiled = compileVfxExport(
      [
        {
          effect: {
            id: "partial-effect",
            name: "Partial",
            emitters: [
              {
                id: "partial-emitter",
                modules: { velocity: true, trails: true },
              },
            ],
          },
          effectPath: "effects/partial.json",
        },
      ],
      { generatedAt: "2026-06-15T00:00:00.000Z" },
    );
    const effect = compiled.effects[0]?.effect;

    expect(effect?.support.status).toBe("partial");
    expect(effect?.support.unsupportedModules).toEqual([]);
    expect(effect?.support.partialModules).toEqual(
      expect.arrayContaining(["emitters.0.modules.trails"]),
    );
    expect(effect?.support.warnings.length).toBeGreaterThan(0);
    expect(compiled.manifest.effects[0]?.support.status).toBe("partial");
    expect(compiled.validation.valid).toBe(true);
  });

  it("reports authored settings that runtime export does not support yet", () => {
    const compiled = compileVfxEffect({
      id: "unsupported-effect",
      emitters: [
        {
          id: "unsupported-emitter",
          modules: {
            inheritVelocity: true,
          },
          advanced: {
            inheritVelocity: {
              mode: "current",
            },
          },
        },
      ],
    });

    expect(compiled.effect.support.status).toBe("blocked");
    expect(compiled.validation.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.advanced.inheritVelocity.mode",
        }),
      ]),
    );
  });

  it("blocks unsupported texture sheet animation fields", () => {
    const compiled = compileVfxEffect({
      id: "unsupported-sheet-effect",
      emitters: [
        {
          id: "unsupported-sheet-emitter",
          modules: {
            textureSheetAnimation: true,
          },
          advanced: {
            textureSheetAnimation: {
              mode: "atlas",
              frames: ["spark-a", "spark-b"],
            },
          },
        },
      ],
    });

    expect(compiled.effect.support.status).toBe("blocked");
    expect(compiled.effect.support.unsupportedModules).toEqual(
      expect.arrayContaining([
        "emitters.0.advanced.textureSheetAnimation.mode",
        "emitters.0.advanced.textureSheetAnimation.frames",
      ]),
    );
    expect(compiled.validation.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.advanced.textureSheetAnimation.mode",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.advanced.textureSheetAnimation.frames",
        }),
      ]),
    );
  });

  it("round-trips render.material into the exported emitter and manifest", () => {
    const compiled = compileVfxExport(
      [
        {
          effect: {
            app: "vfx-editor",
            kind: "particle-effect",
            version: 1,
            id: "material-effect",
            name: "Material Effect",
            emitters: [
              {
                id: "mat-emitter",
                render: {
                  blend: "additive",
                  material: {
                    id: "inst-fire",
                    shaderId: "M_Fire",
                    // Deliberately out-of-order keys + a default-equal id so the
                    // serializer's deterministic key order + default-drop shows.
                    mainTex: {
                      type: "texture",
                      id: "fire",
                      path: "fx/fire.png",
                    },
                    paramOverrides: { Tint: [1, 0.5, 0, 1], Emissive: 2 },
                  },
                },
              },
            ],
          },
          effectPath: "effects/material-effect.json",
        },
      ],
      { generatedAt: "2026-06-15T00:00:00.000Z" },
    );
    const emitter = compiled.effects[0]?.effect.emitters[0];
    const material = emitter?.render.material as Record<string, unknown>;

    expect(material).toEqual({
      id: "inst-fire",
      shaderId: "M_Fire",
      // paramOverrides emitted with sorted keys (Emissive before Tint).
      paramOverrides: { Emissive: 2, Tint: [1, 0.5, 0, 1] },
      mainTex: { type: "texture", id: "fire", path: "fx/fire.png" },
    });
    // Deterministic key order: shaderId follows id, paramOverrides keys sorted.
    expect(Object.keys(material)).toEqual([
      "id",
      "shaderId",
      "paramOverrides",
      "mainTex",
    ]);
    expect(Object.keys(material.paramOverrides as object)).toEqual([
      "Emissive",
      "Tint",
    ]);

    // The material asset itself is collected into the manifest alongside its
    // MainTex texture (techspec §9, §3.2).
    expect(compiled.manifest.assets).toEqual(
      expect.arrayContaining([
        { id: "fire", type: "texture", path: "fx/fire.png" },
        { id: "M_Fire", type: "material", path: "M_Fire" },
      ]),
    );
    expect(compiled.validation.valid).toBe(true);
  });

  it("masked/opaque material blends survive export to the standalone runtime (I12-G)", () => {
    for (const blend of ["masked", "opaque"] as const) {
      const authoredGraph = normalizeShaderGraph({
        id: `M_${blend}`,
        name: `M ${blend}`,
        blend,
        nodes: [
          {
            id: "tex",
            type: "textureSample",
            inputs: {},
            params: {},
            position: { x: 0, y: 0 },
          },
        ],
        edges: [
          {
            id: "e1",
            source: "tex",
            sourceHandle: "out",
            target: "out",
            targetHandle: "baseColor",
          },
        ],
        outputs: { baseColor: "e1" },
      });
      // The material asset file is the serialized graph — the exported effect
      // references it, so the blend must survive serialize → normalize →
      // compile on the standalone side.
      const serialized = serializeShaderGraph(authoredGraph);
      expect(serialized.blend).toBe(blend);
      const runtimeGraph = normalizeShaderGraph(
        JSON.parse(JSON.stringify(serialized)),
      );
      expect(runtimeGraph.blend).toBe(blend);
      const artifact = compileMaterial(
        runtimeGraph,
        createMaterialInstance(runtimeGraph, "inst"),
      );
      expect(artifact.blend).toBe(blend);

      const compiled = compileVfxExport(
        [
          {
            effect: {
              id: `${blend}-effect`,
              emitters: [
                {
                  id: "emitter",
                  render: {
                    blend: "additive",
                    texture: "fx/base.png",
                    material: { id: "inst", shaderId: runtimeGraph.id },
                  },
                },
              ],
            },
            effectPath: `effects/${blend}-effect.json`,
          },
        ],
        {
          generatedAt: "2026-06-15T00:00:00.000Z",
          validation: {
            materialGraphs: { [runtimeGraph.id]: serialized },
          },
          materialAssetPaths: {
            [runtimeGraph.id]: `materials/${runtimeGraph.id}.material`,
          },
        },
      );
      expect(compiled.validation.blockers).toEqual([]);
      expect(compiled.manifest.assets).toEqual(
        expect.arrayContaining([
          {
            id: runtimeGraph.id,
            type: "material",
            path: `materials/${runtimeGraph.id}.material`,
          },
        ]),
      );
    }
  });

  it("uses supplied material asset paths in the manifest", () => {
    const compiled = compileVfxExport(
      [
        {
          effect: {
            id: "material-path-effect",
            emitters: [
              {
                id: "mat-emitter",
                render: {
                  material: { id: "inst", shaderId: "M_Fire" },
                },
              },
            ],
          },
          effectPath: "effects/material-path-effect.json",
        },
      ],
      {
        generatedAt: "2026-06-15T00:00:00.000Z",
        validation: { materialGraphs: {} },
        materialAssetPaths: { M_Fire: "materials/Fire.material" },
      },
    );

    expect(compiled.manifest.assets).toEqual([
      { id: "M_Fire", type: "material", path: "materials/Fire.material" },
    ]);
  });

  it("emits backend support metadata and mesh asset refs for Three mesh particles", () => {
    const compiled = compileVfxEffect({
      id: "mesh-effect",
      targetProfile: "three-world-3d",
      emitters: [
        {
          id: "mesh-emitter",
          mode: "mesh",
          mesh: {
            renderMode: "meshAsset",
            asset: { type: "mesh", id: "coin", path: "meshes/coin.glb" },
          },
        },
      ],
    });

    expect(compiled.effect.targetProfile).toBe("three-world-3d");
    expect(compiled.assets).toEqual([
      { type: "mesh", id: "coin", path: "meshes/coin.glb" },
    ]);
    expect(compiled.effect.support).toMatchObject({
      status: "supported",
      overall: "supported",
      targetProfile: "three-world-3d",
      preferredBackend: "three3d",
      portableSubset: false,
      backends: {
        pixi2d: { status: "blocked" },
        three3d: { status: "supported" },
      },
    });
  });

  it("serializes a null render.material for texture-only emitters", () => {
    const compiled = compileVfxEffect({
      id: "texture-only",
      emitters: [{ id: "plain", render: { texture: "fx/spark.png" } }],
    });

    expect(compiled.effect.emitters[0]?.render.material).toBeNull();
  });

  it("does not perturb the source hash when serializing render.material", () => {
    const source = {
      id: "hash-stable",
      emitters: [
        {
          id: "mat",
          render: {
            material: { id: "i", shaderId: "M_X", paramOverrides: { A: 1 } },
          },
        },
      ],
    };
    const compiled = compileVfxEffect(source);

    expect(compiled.effect.sourceHash).toBe(createVfxSourceHash(source));
  });

  it("reuses runtime authoring validation for export blockers", () => {
    const compiled = compileVfxEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "bad-asset-effect",
      emitters: [
        {
          id: "bad-asset-emitter",
          render: {
            texture: "../outside.png",
          },
        },
      ],
    });

    expect(compiled.effect.support.status).toBe("blocked");
    expect(compiled.validation.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-asset-ref",
          path: "emitters.0.render.texture",
        }),
      ]),
    );
  });
});
