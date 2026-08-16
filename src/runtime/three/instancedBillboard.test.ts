import { Color, Matrix4, PlaneGeometry, Texture, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import {
  canUseInstancedBillboard,
  ThreeInstancedBillboardView,
} from "./instancedBillboard";

function emitterWith(render: Record<string, unknown> = {}) {
  return normalizeParticleEffect({
    id: "instanced-gate",
    targetProfile: "three-world-3d",
    emitters: [{ id: "billboard", maxParticles: 8, render }],
  }).emitters[0]!;
}

function viewFor(render: Record<string, unknown> = {}) {
  return new ThreeInstancedBillboardView(
    new PlaneGeometry(1, 1),
    new Texture(),
    4,
    emitterWith(render),
  );
}

function instancePositionX(
  view: ThreeInstancedBillboardView,
  index: number,
): number {
  const matrix = new Matrix4();
  view.mesh.getMatrixAt(index, matrix);
  return new Vector3().setFromMatrixPosition(matrix).x;
}

describe("canUseInstancedBillboard (F12/F13)", () => {
  it("admits textureless billboards once a procedural texture resolves", () => {
    const texture = new Texture();
    const emitter = emitterWith();
    expect(emitter.render.texture).toBeNull();
    expect(canUseInstancedBillboard(emitter, texture)).toBe(true);
    // No resolved texture at all still demotes to the legacy path.
    expect(canUseInstancedBillboard(emitter, null)).toBe(false);
  });

  it("admits every sort mode", () => {
    const texture = new Texture();
    for (const sortMode of [
      "none",
      "oldestFirst",
      "youngestFirst",
      "distanceFarFirst",
      "distanceNearFirst",
    ] as const) {
      expect(
        canUseInstancedBillboard(emitterWith({ sortMode }), texture),
        `${sortMode} should be instanceable`,
      ).toBe(true);
    }
  });

  it("still demotes genuinely non-instanceable variants", () => {
    const texture = new Texture();
    expect(
      canUseInstancedBillboard(
        emitterWith({ blend: "premultiplied" }),
        texture,
      ),
    ).toBe(false);
    expect(
      canUseInstancedBillboard(emitterWith({ shading: "lit" }), texture),
    ).toBe(false);
    expect(
      canUseInstancedBillboard(emitterWith({ opacityInvert: true }), texture),
    ).toBe(false);
    expect(
      canUseInstancedBillboard(
        emitterWith({ opacitySource: "luminance" }),
        texture,
      ),
    ).toBe(false);
  });
});

describe("ThreeInstancedBillboardView camera-distance sort (F13)", () => {
  it("rewrites instances far-to-near with colors and alphas following", () => {
    const view = viewFor({ sortMode: "distanceFarFirst" });
    // Written in age order; x doubles as the instance's identity.
    view.write(
      0,
      new Matrix4().makeTranslation(1, 0, 0),
      new Color(1, 0, 0),
      0.1,
      1,
    );
    view.write(
      1,
      new Matrix4().makeTranslation(2, 0, 0),
      new Color(0, 1, 0),
      0.2,
      9,
    );
    view.write(
      2,
      new Matrix4().makeTranslation(3, 0, 0),
      new Color(0, 0, 1),
      0.3,
      4,
    );

    view.sortByCameraDistance(3, true);
    view.commit(3);

    expect(instancePositionX(view, 0)).toBe(2); // depth 9 (farthest) first
    expect(instancePositionX(view, 1)).toBe(3); // depth 4
    expect(instancePositionX(view, 2)).toBe(1); // depth 1 (nearest) last

    const colors = view.mesh.geometry.getAttribute("aInstanceColor");
    const alphas = view.mesh.geometry.getAttribute("aInstanceAlpha");
    expect([colors.getX(0), colors.getY(0), colors.getZ(0)]).toEqual([0, 1, 0]);
    expect([colors.getX(2), colors.getY(2), colors.getZ(2)]).toEqual([1, 0, 0]);
    expect(alphas.getX(0)).toBeCloseTo(0.2, 6);
    expect(alphas.getX(2)).toBeCloseTo(0.1, 6);
  });

  it("rewrites instances near-to-far when nearFirst is requested", () => {
    const view = viewFor({ sortMode: "distanceNearFirst" });
    view.write(0, new Matrix4().makeTranslation(1, 0, 0), new Color(), 1, 4);
    view.write(1, new Matrix4().makeTranslation(2, 0, 0), new Color(), 1, 1);
    view.write(2, new Matrix4().makeTranslation(3, 0, 0), new Color(), 1, 9);

    view.sortByCameraDistance(3, false);
    view.commit(3);

    expect(instancePositionX(view, 0)).toBe(2);
    expect(instancePositionX(view, 1)).toBe(1);
    expect(instancePositionX(view, 2)).toBe(3);
  });

  it("leaves an already-ordered frame untouched", () => {
    const view = viewFor({ sortMode: "distanceFarFirst" });
    view.write(0, new Matrix4().makeTranslation(1, 0, 0), new Color(), 1, 9);
    view.write(1, new Matrix4().makeTranslation(2, 0, 0), new Color(), 1, 4);
    view.sortByCameraDistance(2, true);
    view.commit(2);

    expect(instancePositionX(view, 0)).toBe(1);
    expect(instancePositionX(view, 1)).toBe(2);
  });
});

describe("ThreeInstancedBillboardView depth-write gate (I12-A)", () => {
  it("writes depth only while every committed instance is opaque", () => {
    const view = viewFor({ depthWrite: true, blend: "alpha" });
    const matrix = new Matrix4();

    view.write(0, matrix, new Color(), 1, 0);
    view.write(1, matrix, new Color(), 1, 0);
    view.commit(2);
    expect(view.mesh.material.depthWrite).toBe(true);

    view.write(1, matrix, new Color(), 0.5, 0);
    view.commit(2);
    expect(view.mesh.material.depthWrite).toBe(false);

    view.write(1, matrix, new Color(), 1, 0);
    view.commit(2);
    expect(view.mesh.material.depthWrite).toBe(true);
  });

  it("never writes depth for additive batches", () => {
    const view = viewFor({ depthWrite: true, blend: "additive" });
    view.write(0, new Matrix4(), new Color(), 1, 0);
    view.commit(1);
    expect(view.mesh.material.depthWrite).toBe(false);
  });
});
