import { describe, expect, it } from "vitest";
import {
  PARTICLE_EMITTER_MODULE_KEYS,
  PARTICLE_MODULE_SUPPORT,
} from "../../engine/particleModuleSettings";
import { validateVfxTextureAssetPath } from "../assets/paths";
import { validateVfxAuthoringEffect } from "./validation";

function createValidEffect(): unknown {
  return {
    app: "vfx-editor",
    kind: "particle-effect",
    version: 1,
    id: "spark-burst",
    name: "Spark Burst",
    emitters: [
      {
        id: "spark-emitter",
        modules: {
          velocity: true,
          color: true,
          size: true,
          rotation: true,
        },
        render: {
          texture: "sparks/spark.png",
        },
      },
    ],
  };
}

describe("vfx authoring validation", () => {
  it("accepts a supported authoring effect", () => {
    const result = validateVfxAuthoringEffect(createValidEffect());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it("reports bad envelope values and clamped numeric values without throwing", () => {
    const result = validateVfxAuthoringEffect({
      app: "other-editor",
      kind: "wrong-kind",
      version: 2,
      id: "bad-effect",
      emitters: [
        {
          id: "bad-emitter",
          duration: Infinity,
          spawn: {
            rate: 9000,
          },
        },
      ],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "bad-kind", path: "app" }),
        expect.objectContaining({ code: "bad-kind", path: "kind" }),
        expect.objectContaining({ code: "bad-version", path: "version" }),
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "clamped-value",
          path: "emitters.0.duration",
        }),
        expect.objectContaining({
          code: "clamped-value",
          path: "emitters.0.spawn.rate",
        }),
      ]),
    );
  });

  it("accepts long timing values without legacy clamp warnings", () => {
    const result = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "long-timing",
      timeline: {
        duration: 120,
        loop: { enabled: true, start: 15, end: 110 },
      },
      emitters: [
        {
          id: "long-emitter",
          timeline: { start: 90 },
          duration: 240,
          initializeParticle: {
            lifetime: {
              mode: "constant",
              value: 75,
            },
          },
        },
      ],
    });

    expect(result.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "clamped-value" }),
      ]),
    );
  });

  it("blocks missing and duplicate emitter ids", () => {
    const result = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "dupes",
      emitters: [{ id: "Smoke Trail" }, { id: "smoke-trail" }, {}],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate-id",
          path: "emitters.1.id",
        }),
        expect.objectContaining({
          code: "missing-id",
          path: "emitters.2.id",
        }),
      ]),
    );
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-id" }),
        expect.objectContaining({ code: "missing-id" }),
      ]),
    );
  });

  it("blocks unsafe or unsupported texture refs", () => {
    const result = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "bad-assets",
      emitters: [
        { id: "absolute", render: { texture: "/tmp/spark.png" } },
        { id: "traversal", render: { texture: "../spark.png" } },
        { id: "backslash", render: { texture: "fx\\spark.png" } },
        { id: "url", render: { texture: "https://example.com/spark.png" } },
        { id: "extension", render: { texture: "fx/readme.txt" } },
        {
          id: "bad-trail",
          modules: { trails: true },
          advanced: { trails: { texture: "../trail.png" } },
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.filter((issue) => issue.code === "invalid-asset-ref"),
    ).toHaveLength(6);
    expect(
      result.blockers.filter((blocker) => blocker.code === "invalid-asset-ref"),
    ).toHaveLength(6);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        path: "emitters.5.advanced.trails.texture",
      }),
    );
  });

  it("allows supported render-time modules, align-to-direction, and grid texture sheets", () => {
    const result = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "supported-runtime-modules",
      emitters: [
        {
          id: "module-emitter",
          modules: {
            forceOverLifetime: true,
            colorBySpeed: true,
            sizeBySpeed: true,
            rotationBySpeed: true,
            externalForces: true,
            noise: true,
            textureSheetAnimation: true,
          },
          spawn: {
            alignToDirection: true,
          },
          render: {
            texture: "sparks/sheet.png",
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
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "emitters.0.advanced.textureSheetAnimation.endFrame",
        }),
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.forceOverLifetime",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.noise",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.textureSheetAnimation",
        }),
      ]),
    );
  });

  it("warns for specialized runtime modules and blocks unsupported subfields", () => {
    const result = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "unsupported-modules",
      emitters: [
        {
          id: "module-emitter",
          modules: {
            collision: true,
            triggers: true,
            subEmitters: true,
            lights: true,
            trails: true,
            customData: true,
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

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.advanced.inheritVelocity.mode",
        }),
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.collision",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.subEmitters",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.lights",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.trails",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.customData",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.modules.inheritVelocity",
        }),
      ]),
    );
  });

  it("blocks unsupported texture sheet animation variants", () => {
    const result = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "atlas-sheet",
      emitters: [
        {
          id: "sheet-emitter",
          modules: {
            textureSheetAnimation: true,
          },
          advanced: {
            textureSheetAnimation: {
              mode: "atlas",
              tiles: [4, 2],
              frames: ["spark-a", "spark-b"],
              frameDurations: [0.1, 0.2],
            },
          },
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.advanced.textureSheetAnimation.mode",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.advanced.textureSheetAnimation.frames",
        }),
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.advanced.textureSheetAnimation.frameDurations",
        }),
      ]),
    );
    expect(result.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "emitters.0.modules.textureSheetAnimation",
        }),
      ]),
    );
  });

  it("allows endFrame but still blocks unknown texture sheet range keys", () => {
    const result = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "range-sheet",
      emitters: [
        {
          id: "sheet-emitter",
          modules: {
            textureSheetAnimation: true,
          },
          advanced: {
            textureSheetAnimation: {
              tiles: [4, 4],
              startFrame: 0,
              endFrame: 8,
              frameRange: [0, 8],
            },
          },
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-module",
          path: "emitters.0.advanced.textureSheetAnimation.frameRange",
        }),
      ]),
    );
    expect(result.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "emitters.0.advanced.textureSheetAnimation.endFrame",
        }),
      ]),
    );
  });

  it("derives partial-support warnings from the engine module support map", () => {
    for (const moduleKey of PARTICLE_EMITTER_MODULE_KEYS) {
      const result = validateVfxAuthoringEffect({
        app: "vfx-editor",
        kind: "particle-effect",
        version: 1,
        id: `support-${moduleKey}`,
        emitters: [{ id: "support-emitter", modules: { [moduleKey]: true } }],
      });
      const warnedHere = result.warnings.some(
        (issue) =>
          issue.code === "unsupported-module" &&
          issue.path === `emitters.0.modules.${moduleKey}`,
      );
      if (PARTICLE_MODULE_SUPPORT[moduleKey] === "partial") {
        expect(warnedHere, `${moduleKey} should warn as partial`).toBe(true);
      } else {
        expect(warnedHere, `${moduleKey} should not warn as full`).toBe(false);
      }
    }
  });

  it("warns for authored depth render flags while allowing explicit disabled flags", () => {
    const warned = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "depth-flags",
      emitters: [
        {
          id: "depth-emitter",
          render: {
            depthTest: true,
            depthWrite: true,
            depthInk: true,
          },
        },
      ],
    });
    const disabled = validateVfxAuthoringEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "depth-disabled",
      emitters: [
        {
          id: "depth-emitter",
          render: {
            depthTest: false,
            depthWrite: false,
            depthInk: false,
          },
        },
      ],
    });

    expect(warned.valid).toBe(true);
    expect(warned.blockers).toEqual([]);
    expect(warned.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "emitters.0.render.depthTest" }),
        expect.objectContaining({ path: "emitters.0.render.depthWrite" }),
        expect.objectContaining({ path: "emitters.0.render.depthInk" }),
      ]),
    );
    expect(disabled.valid).toBe(true);
    expect(disabled.blockers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Material validation (techspec §9, §12)
// ---------------------------------------------------------------------------

interface MaterialNodeSpec {
  id: string;
  type: string;
  inputs?: Record<string, string | null>;
  params?: Record<string, unknown>;
}

/**
 * Build a minimal ShaderGraph whose `baseColor` output reaches every supplied
 * node via a single fan-in `combine` node (so the structural reachability walk
 * visits them all). Each spec node is wired through its own edge into `combine`.
 */
function makeGraph(
  id: string,
  nodes: MaterialNodeSpec[],
  params: unknown[] = [],
): unknown {
  const combineInputs: Record<string, string | null> = {};
  const edges: unknown[] = [];
  const graphNodes: unknown[] = [];
  nodes.forEach((node, index) => {
    const edgeId = `e-${node.id}`;
    combineInputs[`in${index}`] = edgeId;
    edges.push({
      id: edgeId,
      source: node.id,
      sourceHandle: "out",
      target: "combine",
      targetHandle: `in${index}`,
    });
    graphNodes.push({
      id: node.id,
      type: node.type,
      inputs: node.inputs ?? {},
      params: node.params ?? {},
      position: { x: index * 100, y: 0 },
    });
  });
  graphNodes.push({
    id: "combine",
    type: "combine",
    inputs: combineInputs,
    params: {},
    position: { x: 0, y: 0 },
  });
  edges.push({
    id: "e-output",
    source: "combine",
    sourceHandle: "out",
    target: "output",
    targetHandle: "baseColor",
  });
  return {
    id,
    name: id,
    blend: "normal",
    nodes: graphNodes,
    edges,
    params,
    outputs: { baseColor: "e-output" },
  };
}

function materialEmitter(
  shaderId: string,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    id: "mat-emitter",
    render: {
      material: {
        id: "mat-inst",
        shaderId,
        ...extra,
      },
    },
  };
}

function materialEffect(emitter: unknown): unknown {
  return {
    app: "vfx-editor",
    kind: "particle-effect",
    version: 1,
    id: "mat-effect",
    name: "Material Effect",
    emitters: [emitter],
  };
}

describe("vfx material validation", () => {
  it("blocks a material with no resolvable MainTex and no fallback texture", () => {
    const result = validateVfxAuthoringEffect(
      materialEffect(materialEmitter("sprite-master")),
    );

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-material",
          path: "emitters.0.render.material.mainTex",
        }),
      ]),
    );
  });

  it("accepts a textureless procedural material with no MainTex fallback", () => {
    const graph = makeGraph("M_Procedural", [
      { id: "uv", type: "uv" },
      {
        id: "noise",
        type: "noise",
        params: { function: "voronoi", scale: 4 },
      },
      {
        id: "ramp",
        type: "gradientRamp",
        params: {
          stops: [
            { position: 0, color: [1, 0, 0, 1] },
            { position: 1, color: [0, 0, 1, 1] },
          ],
        },
      },
      {
        id: "opacity",
        type: "sphericalParticleOpacity",
        params: { radius: 0.8 },
      },
    ]);
    const result = validateVfxAuthoringEffect(
      materialEffect(materialEmitter("M_Procedural")),
      { materialGraphs: { M_Procedural: graph } },
    );

    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("blocks a texture-sampling material with no MainTex fallback", () => {
    const graph = makeGraph("M_Texture", [
      { id: "tex", type: "textureSample" },
    ]);
    const result = validateVfxAuthoringEffect(
      materialEffect(materialEmitter("M_Texture")),
      { materialGraphs: { M_Texture: graph } },
    );

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-material",
          path: "emitters.0.render.material.mainTex",
        }),
      ]),
    );
  });

  it("accepts a material that resolves MainTex via its own ref", () => {
    const result = validateVfxAuthoringEffect(
      materialEffect(
        materialEmitter("sprite-master", {
          mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
        }),
      ),
    );

    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("accepts a material that falls back to the emitter render.texture", () => {
    const result = validateVfxAuthoringEffect(
      materialEffect({
        id: "mat-emitter",
        render: {
          texture: "fx/fallback.png",
          material: { id: "mat-inst", shaderId: "sprite-master" },
        },
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("blocks a material referencing an unresolvable ShaderGraph asset", () => {
    const result = validateVfxAuthoringEffect(
      materialEffect(
        materialEmitter("M_Ghost", {
          mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
        }),
      ),
      { materialGraphs: {} },
    );

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-material",
          path: "emitters.0.render.material",
        }),
      ]),
    );
  });

  it("warns at the design sampler budget (uTexture+uRamp+uMask = 3 taps)", () => {
    const graph = makeGraph("M_Tight", [
      { id: "tex", type: "textureSample" },
      { id: "ramp", type: "textureSample" },
      { id: "mask", type: "textureSample" },
    ]);
    const result = validateVfxAuthoringEffect(
      materialEffect(
        materialEmitter("M_Tight", {
          mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
        }),
      ),
      { materialGraphs: { M_Tight: graph } },
    );

    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "material-sampler-cap",
          path: "emitters.0.render.material",
        }),
      ]),
    );
  });

  it("blocks a material that taps more than four textures simultaneously", () => {
    const graph = makeGraph("M_TooMany", [
      { id: "t0", type: "textureSample" },
      { id: "t1", type: "textureSample" },
      { id: "t2", type: "textureSample" },
      { id: "t3", type: "textureSample" },
      { id: "t4", type: "textureSample" },
    ]);
    const result = validateVfxAuthoringEffect(
      materialEffect(
        materialEmitter("M_TooMany", {
          mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
        }),
      ),
      { materialGraphs: { M_TooMany: graph } },
    );

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "material-sampler-cap",
          path: "emitters.0.render.material",
        }),
      ]),
    );
  });

  it("blocks a per-particle StaticSwitch feeding an honored output", () => {
    const graph = makeGraph("M_Switch", [
      { id: "tex", type: "textureSample" },
      {
        id: "sw",
        type: "step",
        params: { staticSwitch: true, perParticle: true },
      },
    ]);
    const result = validateVfxAuthoringEffect(
      materialEffect(
        materialEmitter("M_Switch", {
          mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
        }),
      ),
      { materialGraphs: { M_Switch: graph } },
    );

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "material-banned-node" }),
      ]),
    );
  });

  it("blocks a node carrying a Custom HLSL/GLSL escape hatch", () => {
    const graph = makeGraph("M_Custom", [
      { id: "tex", type: "textureSample" },
      { id: "hack", type: "multiply", params: { custom: "return vec4(1.0);" } },
    ]);
    const result = validateVfxAuthoringEffect(
      materialEffect(
        materialEmitter("M_Custom", {
          mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
        }),
      ),
      { materialGraphs: { M_Custom: graph } },
    );

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "material-banned-node" }),
      ]),
    );
  });

  it("blocks per-particle tint AND a smuggled per-particle scalar (one 8-bit color)", () => {
    const graph = makeGraph(
      "M_Conflict",
      [
        { id: "tex", type: "textureSample" },
        // A reachable particleColor node = per-particle tint into the one 8-bit
        // color attribute (§3.1).
        { id: "ptint", type: "particleColor" },
      ],
      [
        {
          name: "Dissolve",
          type: "float",
          group: "Params",
          default: 0,
          perParticle: true,
          perParticleFeed: "smuggle-8bit",
        },
      ],
    );
    const result = validateVfxAuthoringEffect(
      materialEffect(
        materialEmitter("M_Conflict", {
          mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
        }),
      ),
      { materialGraphs: { M_Conflict: graph } },
    );

    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "material-channel-conflict",
          path: "emitters.0.render.material",
        }),
      ]),
    );
  });

  it("warns when more than six distinct Tier-2 material programs compile", () => {
    const materialGraphs: Record<string, unknown> = {};
    const emitters: unknown[] = [];
    for (let index = 0; index < 7; index += 1) {
      const shaderId = `M_Tier2_${index}`;
      // A SubUV-blend node forces Tier 2 (second tap + fragment mix, §6.2).
      materialGraphs[shaderId] = makeGraph(shaderId, [
        { id: "tex", type: "textureSample" },
        { id: "subuv", type: "particleSubUV", params: { blend: true } },
      ]);
      emitters.push({
        id: `e-${index}`,
        render: {
          material: {
            id: `inst-${index}`,
            shaderId,
            mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
          },
        },
      });
    }
    const result = validateVfxAuthoringEffect(
      {
        app: "vfx-editor",
        kind: "particle-effect",
        version: 1,
        id: "variant-effect",
        emitters,
      },
      { materialGraphs },
    );

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "material-variant-cap", path: "$" }),
      ]),
    );
  });

  it("does not flag materials when no graph lookup is provided", () => {
    // Instance-only validation (the runtime view): only missing-MainTex applies.
    const result = validateVfxAuthoringEffect(
      materialEffect(
        materialEmitter("M_Unknown", {
          mainTex: { type: "texture", id: "tex", path: "fx/spark.png" },
        }),
      ),
    );

    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
  });
});

describe("vfx asset path validation", () => {
  it("normalizes safe texture asset paths", () => {
    expect(validateVfxTextureAssetPath("./fx//spark.webp")).toMatchObject({
      valid: true,
      path: "fx/spark.webp",
    });
  });
});
