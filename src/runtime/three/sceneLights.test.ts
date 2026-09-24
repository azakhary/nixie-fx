import {
  DirectionalLight,
  HemisphereLight,
  AmbientLight,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  ShaderMaterial,
  SpotLight,
} from "three";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import {
  createMaterialInstance,
  normalizeShaderGraph,
  type ShaderGraph,
} from "../schema/materials";
import {
  createDefaultScene,
  createDefaultSceneLight,
  type SceneDefinition,
} from "../schema/scene";
import { createThreeEmitterMaterial } from "./materialAdapter";
import { createThreeSceneLights } from "./sceneLights";

function sceneWith(patch: Partial<SceneDefinition>): SceneDefinition {
  return { ...createDefaultScene(), ...patch };
}

describe("createThreeSceneLights", () => {
  it("reproduces the pre-scene hardcoded preview lights exactly", () => {
    // The editor's Three preview used these before scene files existed.
    const old = {
      hemi: new HemisphereLight(0xf7f9ff, 0x51606f, 1.15),
      key: new DirectionalLight(0xffffff, 2.2),
      fill: new DirectionalLight(0x9fb9ff, 0.55),
    };
    old.key.position.set(3, 6, 5);
    old.fill.position.set(-4, 2.5, -3);
    const lights = createThreeSceneLights(createDefaultScene());
    const hemi = lights.group.children.find(
      (child) => child instanceof HemisphereLight,
    ) as HemisphereLight;
    expect(hemi.color.equals(old.hemi.color)).toBe(true);
    expect(hemi.groundColor.equals(old.hemi.groundColor)).toBe(true);
    expect(hemi.intensity).toBe(old.hemi.intensity);
    expect(hemi.position.toArray()).toEqual(old.hemi.position.toArray());
    for (const [id, reference] of [
      ["key-light", old.key],
      ["fill-light", old.fill],
    ] as const) {
      const light = lights.getLight(id) as DirectionalLight;
      expect(light.color.equals(reference.color)).toBe(true);
      expect(light.intensity).toBe(reference.intensity);
      expect(light.position.toArray()).toEqual(reference.position.toArray());
      const direction = light.position
        .clone()
        .sub(light.target.position)
        .normalize();
      const oldDirection = reference.position
        .clone()
        .sub(reference.target.position)
        .normalize();
      expect(direction.distanceTo(oldDirection)).toBeLessThan(1e-12);
    }
    expect(
      lights.group.children.filter(
        (child) =>
          child instanceof HemisphereLight || child instanceof DirectionalLight,
      ),
    ).toHaveLength(3);
  });

  it("builds the ambient + lights of a definition", () => {
    const scene = sceneWith({
      lights: [
        createDefaultSceneLight("directional", { id: "sun" }),
        createDefaultSceneLight("point", { id: "bulb", range: 5 }),
        createDefaultSceneLight("spot", { id: "spot", spotAngle: 60 }),
        createDefaultSceneLight("point", { id: "off", enabled: false }),
      ],
    });
    const lights = createThreeSceneLights(scene);
    expect(
      lights.group.children.some((c) => c instanceof HemisphereLight),
    ).toBe(true);
    expect(lights.getLight("sun")).toBeInstanceOf(DirectionalLight);
    expect(lights.getLight("bulb")).toBeInstanceOf(PointLight);
    expect((lights.getLight("bulb") as PointLight).distance).toBe(5);
    const spot = lights.getLight("spot") as SpotLight;
    expect(spot).toBeInstanceOf(SpotLight);
    expect(spot.angle).toBeCloseTo(Math.PI / 6);
    expect(lights.getLight("off")).toBeNull();
    lights.dispose();
    expect(lights.group.children).toHaveLength(0);
  });

  it("retunes in place and only rebuilds when the light set changes", () => {
    const scene = createDefaultScene();
    const lights = createThreeSceneLights(scene);
    const key = lights.getLight("key-light");
    lights.update({
      ...scene,
      lights: scene.lights.map((light) =>
        light.id === "key-light" ? { ...light, intensity: 5 } : light,
      ),
    });
    expect(lights.getLight("key-light")).toBe(key);
    expect(key?.intensity).toBe(5);
    lights.update({
      ...scene,
      ambient: { ...scene.ambient, source: "color" },
    });
    expect(lights.group.children.some((c) => c instanceof AmbientLight)).toBe(
      true,
    );
    expect(lights.getLight("key-light")).not.toBe(key);
  });
});

function litGraph(partial: Partial<ShaderGraph> = {}): ShaderGraph {
  return normalizeShaderGraph({
    id: "lit",
    name: "Lit",
    blend: "normal",
    shadingModel: "lit",
    nodes: [
      { id: "tex", type: "textureSample", inputs: {}, params: {} },
      { id: "pc", type: "particleColor", inputs: {}, params: {} },
      { id: "mul", type: "multiply", inputs: { a: "e1", b: "e2" }, params: {} },
    ],
    edges: [
      {
        id: "e1",
        source: "tex",
        sourceHandle: "out",
        target: "mul",
        targetHandle: "a",
      },
      {
        id: "e2",
        source: "pc",
        sourceHandle: "out",
        target: "mul",
        targetHandle: "b",
      },
      {
        id: "base",
        source: "mul",
        sourceHandle: "out",
        target: "output",
        targetHandle: "baseColor",
      },
    ],
    params: [],
    outputs: { baseColor: "base" },
    ...partial,
  });
}

function resolve(graph: ShaderGraph, shading: "lit" | "unlit" = "unlit") {
  const instance = createMaterialInstance(graph, "lit");
  const effect = normalizeParticleEffect({
    emitters: [{ render: { material: instance, shading } }],
  });
  return createThreeEmitterMaterial(effect.emitters[0]!, {
    effect,
    camera: new PerspectiveCamera(),
    materialGraphProvider: () => graph,
  });
}

describe("lit particle materials on Three", () => {
  it("renders a lit Tier-2 graph with scene lights bound", () => {
    const resolution = resolve(litGraph());
    const material = resolution.material as ShaderMaterial;
    expect(material).toBeInstanceOf(ShaderMaterial);
    expect(material.lights).toBe(true);
    expect(material.uniforms.directionalLights).toBeDefined();
    expect(material.fragmentShader).toContain("#define NFX_SCENE_LIGHTS");
    expect(material.fragmentShader).toContain("nfxShadeLit(");
    expect(material.vertexShader).toContain("vNfxViewNormal");
  });

  it("keeps unlit Tier-2 graphs free of lighting code", () => {
    const resolution = resolve(litGraph({ shadingModel: undefined }));
    const material = resolution.material as ShaderMaterial;
    expect(material.lights).toBe(false);
    expect(material.fragmentShader).not.toContain("nfx");
  });

  it("keeps an unlit Tier-2 graph unlit even when the emitter's Shading is Lit", () => {
    // Pre-scene-lighting effects: the emitter toggle never reached shader
    // graphs, so they must keep rendering exactly as before.
    const resolution = resolve(litGraph({ shadingModel: undefined }), "lit");
    const material = resolution.material as ShaderMaterial;
    expect(material.lights).toBe(false);
    expect(material.fragmentShader).not.toContain("nfx");
  });

  it("uses MeshStandardMaterial for a lit fixed-function graph", () => {
    const graph = normalizeShaderGraph({
      id: "fixed",
      name: "Fixed",
      blend: "normal",
      shadingModel: "lit",
      nodes: [{ id: "tex", type: "textureSample", inputs: {}, params: {} }],
      edges: [
        {
          id: "base",
          source: "tex",
          sourceHandle: "out",
          target: "output",
          targetHandle: "baseColor",
        },
      ],
      params: [],
      outputs: { baseColor: "base" },
    });
    expect(resolve(graph).material).toBeInstanceOf(MeshStandardMaterial);
    expect(
      resolve({ ...graph, shadingModel: undefined }).material,
    ).not.toBeInstanceOf(MeshStandardMaterial);
  });

  it("binds scene lights for an unlit graph that reads a light node", () => {
    const graph = normalizeShaderGraph({
      id: "toon",
      name: "Toon",
      blend: "normal",
      nodes: [
        { id: "diffuse", type: "sceneDiffuseLighting", inputs: {}, params: {} },
      ],
      edges: [
        {
          id: "base",
          source: "diffuse",
          sourceHandle: "out",
          target: "output",
          targetHandle: "baseColor",
        },
      ],
      params: [],
      outputs: { baseColor: "base" },
    });
    const material = resolve(graph).material as ShaderMaterial;
    expect(material.lights).toBe(true);
    expect(material.fragmentShader).toContain("nfxDiffuseLighting()");
  });
});
