import { Particle, ParticleContainer, Texture } from "pixi.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeShaderGraph, type ShaderGraph } from "../schema/materials";
import { createPixiVfx2dProjection } from "./projection";
import { PixiVfxEffectInstance } from "./renderer";
import type { PixiVfxFallbackTextures } from "./types";

const { bakeTextureRef, createMaterialBakeTextureMock } = vi.hoisted(() => {
  const bakeTextureRef: { current: unknown } = { current: null };
  return {
    bakeTextureRef,
    createMaterialBakeTextureMock: vi.fn(() => bakeTextureRef.current),
  };
});

vi.mock("./material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./material")>();
  return {
    ...actual,
    createMaterialBakeTexture: createMaterialBakeTextureMock,
  };
});

describe("Pixi renderer material fallback bakes", () => {
  beforeEach(() => {
    bakeTextureRef.current = null;
    createMaterialBakeTextureMock.mockClear();
  });

  it("applies a Tier-0 material bake to the fallback texture when MainTex is empty", () => {
    const graph = sphericalOpacityGraph();
    const fallbackTexture = Texture.EMPTY;
    const bakedTexture = Texture.WHITE;
    bakeTextureRef.current = bakedTexture;

    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect({
        id: "mi-round-fallback",
        shaderId: graph.id,
      }),
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      fallbackTextures: fallbackTextures(fallbackTexture),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);

    expect(createMaterialBakeTextureMock).toHaveBeenCalledWith(
      fallbackTexture,
      graph,
      expect.objectContaining({ shaderId: graph.id }),
      expect.objectContaining({ samplerForPath: expect.any(Function) }),
    );
    expect(firstParticle(instance).texture).toBe(bakedTexture);

    instance.destroy();
  });
});

describe("Pixi renderer material blend modes (I12-G)", () => {
  it("masked/opaque override the emitter blend and fork the container key", () => {
    // Tier-1 graph (animated UV pan): shaderId stays "sprite-master" and no
    // bakeHash exists, so only the effective-blend key axis can fork the view.
    const graph = pannerTier1Graph();
    const provider = (shaderId: string): ShaderGraph | undefined =>
      shaderId === graph.id ? graph : undefined;
    const instance = new PixiVfxEffectInstance({
      effect: materialEmitterEffect(
        { id: "mi-blend", shaderId: graph.id },
        { blend: "additive" },
      ),
      materialGraphProvider: provider,
      fallbackTextures: fallbackTextures(Texture.WHITE),
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });

    instance.update(0.01, 0.01);
    const normalContainer = particleContainer(instance);
    // normal/add graph blends keep the emitter's additive blend authoritative.
    expect(normalContainer.blendMode).toBe("add");

    graph.blend = "opaque";
    instance.setMaterialGraphProvider(provider);
    instance.update(0.01, 0.02);
    const opaqueContainer = particleContainer(instance);
    expect(opaqueContainer).not.toBe(normalContainer);
    expect(opaqueContainer.blendMode).toBe("none");

    graph.blend = "masked";
    instance.setMaterialGraphProvider(provider);
    instance.update(0.01, 0.03);
    const maskedContainer = particleContainer(instance);
    expect(maskedContainer).not.toBe(opaqueContainer);
    expect(maskedContainer.blendMode).toBe("normal");

    instance.destroy();
  });
});

/** Tier-1 graph: animated panner feeding only a texture-sample UV pin. */
function pannerTier1Graph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "panner-tier1-material",
    name: "Panner Tier1 Material",
    blend: "normal",
    nodes: [
      matNode("uv", "uv"),
      matNode("time", "time"),
      matNode(
        "pan",
        "panner",
        { uv: "e-uv", time: "e-time" },
        { speed: [0.1, 0] },
      ),
      matNode("tex", "textureSample", { uv: "e-pan" }),
    ],
    edges: [
      matEdge("e-uv", "uv", "pan", "uv"),
      matEdge("e-time", "time", "pan", "time"),
      matEdge("e-pan", "pan", "tex", "uv"),
      matEdge("e-base", "tex", "out", "baseColor", "RGB"),
    ],
    outputs: { baseColor: "e-base" },
  });
}

function sphericalOpacityGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "round-fallback-material",
    name: "Round Fallback Material",
    blend: "normal",
    nodes: [
      matNode(
        "spherical",
        "sphericalParticleOpacity",
        {},
        { density: 0.32, center: [0.5, 0.5, 0, 0], radius: 0.4 },
      ),
    ],
    edges: [
      matEdge("e-base", "spherical", "out", "baseColor", "Opacity"),
      matEdge("e-opacity", "spherical", "out", "opacity", "Opacity"),
    ],
    outputs: { baseColor: "e-base", opacity: "e-opacity" },
  });
}

function materialEmitterEffect(
  material: unknown,
  render: Record<string, unknown> = {},
): unknown {
  return {
    id: "material-fallback-effect",
    emitters: [
      {
        id: "material-fallback-emitter",
        maxParticles: 1,
        duration: 1,
        loop: false,
        modules: { color: false, rotation: false, velocity: false },
        spawn: {
          rate: 0,
          rateValue: { mode: "constant", value: 0 },
          bursts: [
            { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
          ],
          shape: "point",
        },
        initializeParticle: {
          lifetime: { mode: "constant", value: 1 },
          color: {
            mode: "constant",
            color: [1, 1, 1, 1],
            intensity: { mode: "constant", value: 1 },
          },
        },
        billboard: { sizeValue: { mode: "constant", value: 0.5 } },
        render: { depthInk: false, material, ...render },
      },
    ],
  };
}

function matNode(
  id: string,
  type: ShaderGraph["nodes"][number]["type"],
  inputs: Record<string, string | null> = {},
  params: Record<string, unknown> = {},
): ShaderGraph["nodes"][number] {
  return { id, type, inputs, params, position: { x: 0, y: 0 } };
}

function matEdge(
  id: string,
  source: string,
  target: string,
  targetHandle: string,
  sourceHandle = "out",
): ShaderGraph["edges"][number] {
  return { id, source, target, targetHandle, sourceHandle };
}

function fallbackTextures(texture: Texture): PixiVfxFallbackTextures {
  return {
    circle: texture,
    square: texture,
    triangleShard: texture,
    quadShard: texture,
    grassShard: texture,
  };
}

function firstParticle(instance: PixiVfxEffectInstance): Particle {
  const particle = particleContainer(instance).particleChildren[0] as
    Particle | undefined;
  if (!particle) throw new Error("Expected one rendered particle");
  return particle;
}

/** The emitter's main particle container (trail container precedes it). */
function particleContainer(instance: PixiVfxEffectInstance): ParticleContainer {
  const containers = instance.root.children.filter(
    (child): child is ParticleContainer => child instanceof ParticleContainer,
  );
  const container = containers[1] ?? containers[0];
  if (!container) throw new Error("Expected a particle container");
  return container;
}
