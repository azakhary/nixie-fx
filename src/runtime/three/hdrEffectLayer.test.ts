import { describe, expect, it } from "vitest";
import { createDefaultSceneBloom } from "../schema/scene";
import {
  sceneBloomToThreeVfxOptions,
  sceneBloomToUnrealBloomParameters,
} from "./hdrEffectLayer";

describe("scene bloom mapping", () => {
  it("maps the stock bloom onto the editor's UnrealBloomPass numbers", () => {
    expect(
      sceneBloomToUnrealBloomParameters(createDefaultSceneBloom()),
    ).toEqual({ enabled: true, strength: 1, radius: 0.7, threshold: 1 });
  });

  it("clamps the pass threshold but hands the particle encoder the raw one", () => {
    const bloom = {
      ...createDefaultSceneBloom(),
      threshold: 2.5,
      exposure: -1,
    };
    expect(sceneBloomToUnrealBloomParameters(bloom).threshold).toBe(1);
    expect(sceneBloomToThreeVfxOptions(bloom)).toEqual({
      enabled: true,
      threshold: 2.5,
      exposureStops: -1,
    });
  });

  it("treats zero intensity as bloom off for both the pass and the encoder", () => {
    const bloom = { ...createDefaultSceneBloom(), intensity: 0 };
    expect(sceneBloomToUnrealBloomParameters(bloom).enabled).toBe(false);
    expect(sceneBloomToThreeVfxOptions(bloom).enabled).toBe(false);
  });
});
