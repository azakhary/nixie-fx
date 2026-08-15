import { Application, Rectangle, Texture } from "pixi.js";
import { normalizeShaderGraph } from "../../src/runtime/schema/materials";
import { createPixiVfx2dProjection } from "../../src/runtime/pixi/projection";
import { PixiVfxRenderer } from "../../src/runtime/pixi/renderer";

interface Tier2PixelSmokeResult {
  plainColorSum: number;
  plainAlphaSum: number;
  plainVisibleParticles: number;
  tier2ColorSum: number;
  tier2AlphaSum: number;
  tier2VisibleParticles: number;
  differs: boolean;
  error?: string;
}

declare global {
  interface Window {
    __tier2PixelResult?: Tier2PixelSmokeResult;
  }
}

const fallbackTextures = {
  circle: Texture.WHITE,
  square: Texture.WHITE,
  triangleShard: Texture.WHITE,
  quadShard: Texture.WHITE,
  grassShard: Texture.WHITE,
};

const materialGraph = normalizeShaderGraph({
  id: "tier2-pixel-material",
  name: "Tier 2 Pixel Material",
  blend: "normal",
  nodes: [
    {
      id: "uv",
      type: "uv",
      inputs: {},
      params: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "pan",
      type: "panner",
      inputs: { uv: "e-uv" },
      params: { speed: [0.25, 0, 0, 0] },
      position: { x: 0, y: 0 },
    },
    {
      id: "noise",
      type: "noise",
      inputs: { Position: "e-pan" },
      params: {
        function: "voronoi",
        scale: 4,
        outputMin: 0,
        outputMax: 1,
      },
      position: { x: 0, y: 0 },
    },
    {
      id: "ramp",
      type: "gradientRamp",
      inputs: {},
      params: {
        stops: [
          { position: 0, color: [1, 0, 0, 1] },
          { position: 1, color: [0, 0, 1, 1] },
        ],
      },
      position: { x: 0, y: 0 },
    },
    {
      id: "mul",
      type: "multiply",
      inputs: { a: "e-noise", b: "e-ramp" },
      params: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "opacity",
      type: "sphericalParticleOpacity",
      inputs: {},
      params: {
        density: 1,
        center: [0.5, 0.5, 0, 0],
        radius: 0.8,
      },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [
    {
      id: "e-uv",
      source: "uv",
      sourceHandle: "out",
      target: "pan",
      targetHandle: "uv",
    },
    {
      id: "e-pan",
      source: "pan",
      sourceHandle: "out",
      target: "noise",
      targetHandle: "Position",
    },
    {
      id: "e-noise",
      source: "noise",
      sourceHandle: "out",
      target: "mul",
      targetHandle: "a",
    },
    {
      id: "e-ramp",
      source: "ramp",
      sourceHandle: "out",
      target: "mul",
      targetHandle: "b",
    },
    {
      id: "e-base",
      source: "mul",
      sourceHandle: "out",
      target: "out",
      targetHandle: "baseColor",
    },
    {
      id: "e-opacity",
      source: "opacity",
      sourceHandle: "Opacity",
      target: "out",
      targetHandle: "opacity",
    },
  ],
  outputs: { baseColor: "e-base", opacity: "e-opacity" },
});

function makeEffect(material: unknown): unknown {
  return {
    id: material ? "tier2-effect" : "plain-effect",
    emitters: [
      {
        id: "emitter",
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
        billboard: { sizeValue: { mode: "constant", value: 0.6 } },
        render: { depthInk: false, material },
      },
    ],
  };
}

interface PixelSample {
  colorSum: number;
  alphaSum: number;
  visibleParticles: number;
  pixels: Uint8ClampedArray;
}

async function sample(material: unknown): Promise<PixelSample> {
  const app = new Application();
  await app.init({
    width: 64,
    height: 64,
    backgroundAlpha: 0,
    antialias: false,
    autoStart: false,
    preference: "webgl",
  });
  const renderer = new PixiVfxRenderer({
    parent: app.stage,
    fallbackTextures,
    materialGraphProvider: (shaderId) =>
      shaderId === materialGraph.id ? materialGraph : undefined,
    projection: createPixiVfx2dProjection({
      originX: 32,
      originY: 32,
      pixelsPerUnit: 48,
      yAxis: "down",
    }),
  });

  renderer.createEffect(makeEffect(material), { seed: 1, timeSeconds: 0 });
  const stats = renderer.update(0.01, 0.5);
  const visibleParticles = stats.visibleParticles;
  app.renderer.render({
    container: app.stage,
    clear: true,
    clearColor: 0x00000000,
  });
  const output = app.renderer.extract.pixels({
    target: app.stage,
    frame: new Rectangle(0, 0, 64, 64),
  });
  let colorSum = 0;
  let alphaSum = 0;
  for (let i = 0; i < output.pixels.length; i += 4) {
    colorSum +=
      output.pixels[i]! + output.pixels[i + 1]! + output.pixels[i + 2]!;
    alphaSum += output.pixels[i + 3]!;
  }
  renderer.destroy();
  app.destroy({ removeView: true, releaseGlobalResources: true });
  return {
    colorSum,
    alphaSum,
    visibleParticles,
    pixels: output.pixels,
  };
}

async function run(): Promise<void> {
  const plain = await sample(null);
  const tier2 = await sample({ id: "mi-tier2", shaderId: materialGraph.id });
  window.__tier2PixelResult = {
    plainColorSum: plain.colorSum,
    plainAlphaSum: plain.alphaSum,
    plainVisibleParticles: plain.visibleParticles,
    tier2ColorSum: tier2.colorSum,
    tier2AlphaSum: tier2.alphaSum,
    tier2VisibleParticles: tier2.visibleParticles,
    differs:
      JSON.stringify(Array.from(plain.pixels)) !==
      JSON.stringify(Array.from(tier2.pixels)),
  };
}

void run().catch((error: unknown) => {
  window.__tier2PixelResult = {
    plainColorSum: 0,
    plainAlphaSum: 0,
    plainVisibleParticles: 0,
    tier2ColorSum: 0,
    tier2AlphaSum: 0,
    tier2VisibleParticles: 0,
    differs: false,
    error: error instanceof Error ? error.message : String(error),
  };
});
