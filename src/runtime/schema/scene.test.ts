import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
  createDefaultSceneBloom,
  createDefaultSceneLight,
  normalizeSceneDefinition,
  parseSceneDefinition,
  sceneAimRotation,
  sceneLightDirection,
  serializeSceneDefinition,
} from "./scene";

describe("scene definition", () => {
  it("aims a light's -Z axis at the target", () => {
    for (const position of [
      [3, 6, 5],
      [-4, 2.5, -3],
      [0, 5, 0.001],
      [2, -1, 0],
    ] as const) {
      const direction = sceneLightDirection(sceneAimRotation([...position]));
      const length = Math.hypot(...position);
      expect(direction[0]).toBeCloseTo(-position[0] / length, 2);
      expect(direction[1]).toBeCloseTo(-position[1] / length, 2);
      expect(direction[2]).toBeCloseTo(-position[2] / length, 2);
    }
  });

  it("defaults to the stock gradient + key/fill preview lighting", () => {
    const scene = createDefaultScene();
    expect(scene.ambient).toMatchObject({
      source: "gradient",
      skyColor: "#f7f9ff",
      groundColor: "#51606f",
      intensity: 1.15,
    });
    expect(scene.lights.map((light) => [light.type, light.intensity])).toEqual([
      ["directional", 2.2],
      ["directional", 0.55],
    ]);
  });

  it("round-trips through serialize/parse", () => {
    const scene = createDefaultScene("Sunset");
    scene.lights.push(
      createDefaultSceneLight("spot", { id: "spot", color: "#FFAA00" }),
    );
    scene.props.push({
      id: "hero",
      name: "Hero",
      mesh: "meshes/hero.glb",
      visible: true,
      position: [1, 0, 0],
      rotation: [0, 90, 0],
      scale: [2, 2, 2],
    });
    const parsed = parseSceneDefinition(serializeSceneDefinition(scene));
    expect(parsed.name).toBe("Sunset");
    expect(parsed.lights[2]).toMatchObject({ id: "spot", color: "#ffaa00" });
    expect(parsed.props[0]).toMatchObject({ mesh: "meshes/hero.glb" });
  });

  it("drops invalid entries and de-duplicates ids", () => {
    const scene = normalizeSceneDefinition({
      kind: "scene",
      ambient: { source: "nope", color: "red", intensity: -3 },
      lights: [
        { type: "point", id: "a" },
        { type: "point", id: "a" },
        { type: "area" },
        null,
      ],
      props: [{ mesh: "" }, { mesh: "m.glb" }],
    });
    expect(scene.ambient.source).toBe("gradient");
    expect(scene.ambient.intensity).toBe(0);
    expect(scene.lights.map((light) => light.id)).toEqual(["a", "a-2"]);
    expect(scene.props).toHaveLength(1);
  });

  it("rejects non-scene JSON", () => {
    expect(() => parseSceneDefinition('{"kind":"particle-effect"}')).toThrow();
  });

  it("reads a scene without bloom as the editor's stock bloom", () => {
    const scene = normalizeSceneDefinition({ kind: "scene", lights: [] });
    expect(scene.bloom).toEqual(createDefaultSceneBloom());
    expect(scene.bloom).toMatchObject({
      enabled: true,
      threshold: 1,
      intensity: 4,
      exposure: 0,
      scatter: 0.7,
    });
  });

  it("clamps and round-trips authored bloom", () => {
    const scene = normalizeSceneDefinition({
      kind: "scene",
      bloom: {
        enabled: false,
        threshold: 42,
        intensity: -1,
        exposure: 9,
        scatter: 0.25,
        highQualityFiltering: true,
        downscale: "half",
      },
    });
    expect(scene.bloom).toEqual({
      enabled: false,
      threshold: 10,
      intensity: 0,
      exposure: 2,
      scatter: 0.25,
      highQualityFiltering: true,
      downscale: "half",
    });
    expect(parseSceneDefinition(serializeSceneDefinition(scene)).bloom).toEqual(
      scene.bloom,
    );
  });
});
