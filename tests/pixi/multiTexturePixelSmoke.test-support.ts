import { Application, Rectangle, Texture } from "pixi.js";
import {
  createMaterialInstance,
  normalizeShaderGraph,
} from "../../src/runtime/schema/materials";
import { createPixiVfx2dProjection } from "../../src/runtime/pixi/projection";
import { PixiVfxRenderer } from "../../src/runtime/pixi/renderer";

function solid(rgb: number[]): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 8;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `rgb(${rgb.join(",")})`;
  ctx.fillRect(0, 0, 8, 8);
  return Texture.from(canvas);
}

export async function sampleMultipleTextures() {
  const app = new Application();
  await app.init({
    width: 64,
    height: 64,
    backgroundAlpha: 0,
    autoStart: false,
    preference: "webgl",
  });
  const colors = { a: [128, 64, 32], b: [64, 128, 192], c: [32, 192, 64] };
  const a = solid(colors.a),
    b = solid(colors.b),
    c = solid(colors.c),
    main = solid([8, 16, 24]);
  const fallbackTextures = {
    circle: main,
    square: main,
    triangleShard: main,
    quadShard: main,
    grassShard: main,
  };
  const results: {
    operation: string;
    stage: string;
    actual: number[];
    expected: number[];
  }[] = [];
  let readbacks = 0;
  const originalRead = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (
    ...args: Parameters<typeof originalRead>
  ) {
    readbacks++;
    return originalRead.apply(this, args);
  };
  try {
    for (const operation of ["add", "multiply", "subtract", "lerp"] as const) {
      const graph = normalizeShaderGraph({
        id: "static-images",
        name: "Static images",
        blend: "opaque",
        params: [{ name: "Second", type: "texture", default: "b.png" }],
        nodes: [
          {
            id: "a",
            type: "textureSample",
            inputs: {},
            params: { tex: "a.png" },
          },
          { id: "p", type: "param", inputs: {}, params: { name: "Second" } },
          {
            id: "b",
            type: "textureSample",
            inputs: { tex: "p-b" },
            params: {},
          },
          {
            id: "op",
            type: operation,
            inputs: { a: "a-op", b: "b-op" },
            params: { t: 0.5 },
          },
        ],
        edges: [
          {
            id: "p-b",
            source: "p",
            sourceHandle: "out",
            target: "b",
            targetHandle: "tex",
          },
          {
            id: "a-op",
            source: "a",
            sourceHandle: "RGB",
            target: "op",
            targetHandle: "a",
          },
          {
            id: "b-op",
            source: "b",
            sourceHandle: "RGB",
            target: "op",
            targetHandle: "b",
          },
          {
            id: "out",
            source: "op",
            sourceHandle: "RGB",
            target: "output",
            targetHandle: "baseColor",
          },
        ],
        outputs: { baseColor: "out" },
      });
      const material = createMaterialInstance(graph, "mi");
      material.mainTex = { type: "texture", id: "main", path: "main.png" };
      const textures = new Map([
        ["main.png", main],
        ["a.png", a],
      ]);
      const renderer = new PixiVfxRenderer({
        parent: app.stage,
        fallbackTextures,
        materialGraphProvider: () => graph,
        textureProvider: { getTexture: (ref) => textures.get(ref.path) },
        projection: createPixiVfx2dProjection({
          originX: 32,
          originY: 32,
          pixelsPerUnit: 48,
          yAxis: "down",
        }),
      });
      const effect = {
        id: "static-test",
        emitters: [
          {
            id: "e",
            maxParticles: 1,
            duration: 5,
            loop: false,
            spawn: {
              rate: 0,
              rateValue: { mode: "constant", value: 0 },
              shape: "point",
              bursts: [
                { time: 0, count: 1, cycles: 1, interval: 0, probability: 1 },
              ],
            },
            initializeParticle: { lifetime: { mode: "constant", value: 5 } },
            modules: { color: false, velocity: false, rotation: false },
            render: { material, depthInk: false },
          },
        ],
      };
      const instance = renderer.createEffect(effect);
      const sample = (stage: string, second: number[]) => {
        renderer.update(0.01, 0.1);
        const pixel = app.renderer.extract.pixels({
          target: app.stage,
          frame: new Rectangle(32, 32, 1, 1),
        }).pixels;
        const expected = colors.a.map((v, i) =>
          Math.round(
            Math.max(
              0,
              Math.min(
                255,
                operation === "add"
                  ? v + second[i]!
                  : operation === "multiply"
                    ? (v * second[i]!) / 255
                    : operation === "subtract"
                      ? v - second[i]!
                      : (v + second[i]!) / 2,
              ),
            ),
          ),
        );
        results.push({
          operation,
          stage,
          actual: Array.from(pixel.slice(0, 3)),
          expected,
        });
      };
      sample("pending", [255, 255, 255]);
      textures.set("b.png", b);
      sample("loaded", colors.b);
      textures.set("b.png", c);
      sample("replaced", colors.c);
      material.paramOverrides.Second = "new.png";
      instance.updateDefinition(effect);
      sample("override pending", [255, 255, 255]);
      textures.set("new.png", b);
      sample("override loaded", colors.b);
      renderer.destroy();
    }
  } finally {
    CanvasRenderingContext2D.prototype.getImageData = originalRead;
    app.destroy({ removeView: true, releaseGlobalResources: true });
    for (const texture of [a, b, c, main]) texture.destroy(true);
  }
  return { results, readbacks };
}
