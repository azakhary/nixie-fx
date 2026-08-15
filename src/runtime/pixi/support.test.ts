import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import {
  collectPixiVfxMaterialRefs,
  collectPixiVfxMaterialSupport,
  PIXI_VFX_MATERIAL_SUPPORT,
  PIXI_VFX_MATERIAL_TIER_REASON,
} from "./support";

function effectWithMaterials(): ReturnType<typeof normalizeParticleEffect> {
  return normalizeParticleEffect({
    id: "material-support",
    emitters: [
      {
        id: "tier1",
        render: {
          material: {
            id: "inst-a",
            shaderId: "M_Fixed",
            mainTex: { type: "texture", id: "a", path: "fx/a.png" },
          },
        },
      },
      {
        id: "tier2",
        render: {
          material: { id: "inst-b", shaderId: "M_Uber" },
        },
      },
      {
        id: "tier3",
        render: {
          material: { id: "inst-c", shaderId: "M_Scene" },
        },
      },
      {
        id: "sprite-master-emitter",
        render: {
          material: { id: "inst-d", shaderId: "sprite-master" },
        },
      },
      // A texture-only emitter contributes no material support entry.
      { id: "plain", render: { texture: "fx/plain.png" } },
    ],
  });
}

describe("pixi vfx material support reporting (techspec §9)", () => {
  it("reports a material support entry for each emitter carrying render.material", () => {
    const effect = effectWithMaterials();
    const features = collectPixiVfxMaterialSupport(effect);

    // 4 of the 5 emitters carry a material (the plain one does not).
    expect(features).toHaveLength(4);
    expect(features.map((feature) => feature.emitterId)).toEqual([
      "tier1",
      "tier2",
      "tier3",
      "sprite-master-emitter",
    ]);
  });

  it("defaults instance-only materials to full (tier1) support", () => {
    const effect = effectWithMaterials();
    const features = collectPixiVfxMaterialSupport(effect);

    for (const feature of features) {
      expect(feature.tier).toBe("tier1");
      expect(feature.support).toBe("full");
      expect(feature.reason).toBeUndefined();
    }
  });

  it("marks Tier-2 as fully supported and Tier-3 as data-only partial", () => {
    const effect = effectWithMaterials();
    const features = collectPixiVfxMaterialSupport(effect, (shaderId) =>
      shaderId === "M_Scene"
        ? "tier3"
        : shaderId === "M_Uber"
          ? "tier2"
          : "tier1",
    );
    const byShader = new Map(features.map((f) => [f.shaderId, f]));

    expect(byShader.get("M_Fixed")?.support).toBe("full");
    expect(byShader.get("M_Fixed")?.reason).toBeUndefined();
    const uber = byShader.get("M_Uber");
    expect(uber?.support).toBe("full");
    expect(uber?.reason).toBeUndefined();
    // Tier 3 is data-only / not rendered in preview at all.
    const scene = byShader.get("M_Scene");
    expect(scene?.support).toBe("partial");
    expect(scene?.reason).toContain("not rendered in preview");
  });

  it("exposes the tier→support table with Tier 2 full and Tier 3 partial", () => {
    expect(PIXI_VFX_MATERIAL_SUPPORT).toEqual({
      tier0: "full",
      tier1: "full",
      tier2: "full",
      tier3: "partial",
    });
  });

  it("documents an honest reason for Tier 3 only", () => {
    expect(PIXI_VFX_MATERIAL_TIER_REASON.tier0).toBeUndefined();
    expect(PIXI_VFX_MATERIAL_TIER_REASON.tier1).toBeUndefined();
    expect(PIXI_VFX_MATERIAL_TIER_REASON.tier2).toBeUndefined();
    // Tier 3 stays data-only / not-rendered-in-preview.
    expect(PIXI_VFX_MATERIAL_TIER_REASON.tier3).toContain(
      "not rendered in preview",
    );
  });

  it("collects distinct material asset refs, skipping the built-in Sprite Master", () => {
    const effect = effectWithMaterials();
    const refs = collectPixiVfxMaterialRefs(effect);

    expect(refs).toEqual([
      { type: "material", id: "M_Fixed", path: "M_Fixed" },
      { type: "material", id: "M_Uber", path: "M_Uber" },
      { type: "material", id: "M_Scene", path: "M_Scene" },
    ]);
  });
});
