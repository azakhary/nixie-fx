import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../engine/particles";
import { validateVfxAuthoringEffect } from "./schema/validation";
import { collectVfxBackendSupportReports } from "./support";

describe("backend-aware VFX support reports", () => {
  it("keeps old Pixi shard mesh partial while blocking it from true Three mesh semantics", () => {
    const effect = normalizeParticleEffect({
      id: "shards",
      emitters: [{ id: "shard-emitter", mode: "mesh" }],
    });
    const validation = validateVfxAuthoringEffect(effect);
    const reports = collectVfxBackendSupportReports(effect, validation);

    expect(reports.pixi2d.status).toBe("partial");
    expect(reports.pixi2d.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mode.mesh" })]),
    );
    expect(reports.three3d.status).toBe("partial");
    expect(reports.three3d.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "mode.mesh.pixiShard" }),
      ]),
    );
  });

  it("blocks prepared mesh particles in Pixi and allows the Three mesh contract", () => {
    const effect = normalizeParticleEffect({
      id: "mesh-asset",
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
    const validation = validateVfxAuthoringEffect(effect);
    const reports = collectVfxBackendSupportReports(effect, validation);

    expect(validation.valid).toBe(true);
    expect(reports.pixi2d.status).toBe("blocked");
    expect(reports.pixi2d.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "mode.meshAsset" }),
      ]),
    );
    expect(reports.three3d.status).toBe("supported");
  });

  it("warns that lit particle shading is Three-only", () => {
    const effect = normalizeParticleEffect({
      id: "lit-particles",
      targetProfile: "three-world-3d",
      emitters: [{ id: "lit", render: { shading: "lit" } }],
    });
    const validation = validateVfxAuthoringEffect(effect);
    const reports = collectVfxBackendSupportReports(effect, validation);

    expect(reports.pixi2d.status).toBe("partial");
    expect(reports.pixi2d.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "render.shading.lit" }),
      ]),
    );
    expect(reports.three3d.status).toBe("supported");
  });

  it("allows Three custom data while warning that Pixi uses representative dynamic params", () => {
    const effect = normalizeParticleEffect({
      id: "custom-data-dynamic-params",
      targetProfile: "three-world-3d",
      emitters: [
        {
          id: "dyn",
          modules: { customData: true },
          advanced: {
            customData: {
              channels: [
                {
                  mode: "curve",
                  curve: [
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    const validation = validateVfxAuthoringEffect(effect);
    const reports = collectVfxBackendSupportReports(effect, validation);

    expect(reports.pixi2d.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "module.customData.dynamicParameters",
        }),
      ]),
    );
    expect(reports.three3d.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "module.customData" }),
      ]),
    );
  });

  it("allows Three particle-history trails after the backend owns the draw path", () => {
    const effect = normalizeParticleEffect({
      id: "three-trails",
      targetProfile: "three-world-3d",
      emitters: [
        {
          id: "trail",
          modules: { trails: true },
        },
      ],
    });
    const validation = validateVfxAuthoringEffect(effect);
    const reports = collectVfxBackendSupportReports(effect, validation);

    expect(reports.three3d.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "module.trails" }),
      ]),
    );
  });
});
