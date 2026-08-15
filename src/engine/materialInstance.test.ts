import { describe, expect, it } from "vitest";
import {
  createMaterialInstance,
  normalizeMaterialInstance,
  normalizeOptionalMaterialInstance,
  serializeMaterialInstance,
  SPRITE_MASTER_SHADER_ID,
  type MaterialInstance,
} from "./materialInstance";

describe("normalizeMaterialInstance", () => {
  it("defaults shaderId to sprite-master and keeps typed overrides", () => {
    const inst = normalizeMaterialInstance({
      id: "mi",
      paramOverrides: {
        scalar: 0.5,
        flag: true,
        tex: "fx/a.png",
        vec: [1, 0, 0, 1],
        bogus: { nope: 1 },
        bogusArr: ["a", "b"],
      },
    });
    expect(inst.shaderId).toBe(SPRITE_MASTER_SHADER_ID);
    expect(inst.paramOverrides).toEqual({
      scalar: 0.5,
      flag: true,
      tex: "fx/a.png",
      vec: [1, 0, 0, 1],
    });
  });

  it("pads short numeric override arrays to a Vec4", () => {
    const inst = normalizeMaterialInstance({ paramOverrides: { v: [2, 3] } });
    expect(inst.paramOverrides.v).toEqual([2, 3, 0, 0]);
  });
});

describe("normalizeOptionalMaterialInstance", () => {
  it("returns null for non-objects (the texture branch)", () => {
    expect(normalizeOptionalMaterialInstance(null)).toBeNull();
    expect(normalizeOptionalMaterialInstance(undefined)).toBeNull();
    expect(normalizeOptionalMaterialInstance("x")).toBeNull();
  });

  it("normalizes an object to an instance", () => {
    const inst = normalizeOptionalMaterialInstance({ shaderId: "M_Fire" });
    expect(inst?.shaderId).toBe("M_Fire");
  });
});

describe("serializeMaterialInstance", () => {
  it("omits empty overrides and null mainTex; sorts override keys", () => {
    const inst = createMaterialInstance("M", "mi");
    const empty = serializeMaterialInstance(inst);
    expect(empty.paramOverrides).toBeUndefined();
    expect(empty.mainTex).toBeUndefined();

    const populated: MaterialInstance = {
      id: "mi",
      shaderId: "M",
      paramOverrides: { z: 1, a: 2 },
      mainTex: { type: "texture", id: "fire", path: "fx/fire.png" },
    };
    const out = serializeMaterialInstance(populated);
    expect(Object.keys(out.paramOverrides as object)).toEqual(["a", "z"]);
    expect(out.mainTex).toEqual({
      type: "texture",
      id: "fire",
      path: "fx/fire.png",
    });
  });

  it("round-trips through normalize", () => {
    const inst: MaterialInstance = {
      id: "mi",
      shaderId: "M_Smoke",
      paramOverrides: { tint: [1, 1, 1, 0.5], glow: 2 },
      mainTex: { type: "texture", id: "smoke", path: "fx/smoke.png" },
    };
    expect(normalizeMaterialInstance(serializeMaterialInstance(inst))).toEqual(
      inst,
    );
  });
});
