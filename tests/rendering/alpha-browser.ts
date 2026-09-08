import {
  Application,
  CanvasSource,
  Particle,
  ParticleContainer,
  Texture as PixiTexture,
} from "pixi.js";
import {
  CanvasTexture,
  Color,
  LinearSRGBColorSpace,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector4,
  WebGLRenderer,
} from "three";
import { normalizeParticleEffect } from "../../src/engine/particles";
import { sampleParticleModuleColor } from "../../src/runtime/modules/advancedEvaluators";
import { compileMaterial } from "../../src/runtime/materials/compileMaterial";
import {
  createMaterialInstance,
  normalizeShaderGraph,
  type MaterialNode,
  type ShaderGraph,
} from "../../src/runtime/schema/materials";
import { createTier2ParticleMaterialShader } from "../../src/runtime/pixi/materialShader";
import { createThreeEmitterMaterial } from "../../src/runtime/three/materialAdapter";

type RGB = [number, number, number];
const failures: string[] = [];
let checks = 0;
declare global {
  interface Window {
    alphaRegressionResult?: { checks: number; failures: string[] };
  }
}

function graph(textured: boolean, blend: ShaderGraph["blend"]): ShaderGraph {
  const node = (
    id: string,
    type: MaterialNode["type"],
    inputs = {},
  ): MaterialNode => ({
    id,
    type,
    inputs,
    params: {},
    position: { x: 0, y: 0 },
  });
  return normalizeShaderGraph({
    id: "alpha-regression",
    name: "Alpha regression",
    blend,
    nodes: [
      node("particle", "particleColor"),
      ...(textured
        ? [
            node("texture", "textureSample"),
            node("product", "multiply", { a: "pc", b: "tex" }),
          ]
        : []),
    ],
    edges: [
      {
        id: "pc",
        source: "particle",
        sourceHandle: "out",
        target: "product",
        targetHandle: "a",
      },
      {
        id: "tex",
        source: "texture",
        sourceHandle: "out",
        target: "product",
        targetHandle: "b",
      },
      {
        id: "rgb",
        source: textured ? "product" : "particle",
        sourceHandle: "RGB",
        target: "output",
        targetHandle: "baseColor",
      },
      {
        id: "alpha",
        source: textured ? "product" : "particle",
        sourceHandle: "A",
        target: "output",
        targetHandle: "opacity",
      },
    ],
    outputs: { baseColor: "rgb", opacity: "alpha" },
  });
}

function textureCanvas(
  rgb: RGB,
  alpha: number,
  premultiply: boolean,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 4;
  const context = canvas.getContext("2d")!;
  const data = context.createImageData(4, 4);
  for (let i = 0; i < data.data.length; i += 4) {
    for (let c = 0; c < 3; c++)
      data.data[i + c] = Math.round(rgb[c]! * (premultiply ? alpha : 1) * 255);
    data.data[i + 3] = Math.round(alpha * 255);
  }
  context.putImageData(data, 0, 0);
  return canvas;
}

function check(label: string, actual: Uint8Array, expected: number[]) {
  checks++;
  if (
    expected.some(
      (value, index) => Math.abs(actual[index]! - Math.round(value * 255)) > 4,
    )
  ) {
    if (failures.length < 30)
      failures.push(
        `${label}: got ${[...actual]}, expected ${expected.map((v) => Math.round(v * 255))}`,
      );
  }
}

async function run() {
  const app = new Application();
  await app.init({
    width: 32,
    height: 32,
    preference: "webgl",
    antialias: false,
    autoStart: false,
    backgroundAlpha: 1,
  });
  document.body.append(app.canvas);
  const three = new WebGLRenderer({ antialias: false, alpha: false });
  three.setSize(32, 32);
  // Isolate alpha compositing from the host preview tone/color-space pipeline.
  three.outputColorSpace = LinearSRGBColorSpace;
  document.body.append(three.domElement);
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const geometry = new PlaneGeometry(2, 2);
  const backgrounds: RGB[] = [
    [1, 1, 1],
    [0, 0, 0],
    [0.5, 0.5, 0.5],
    [0.2, 0.6, 0.8],
  ];
  const cases: {
    name: string;
    tint: RGB;
    tex: RGB;
    textureAlpha: number;
    textured: boolean;
    materialTint?: RGB;
    materialOpacity?: number;
  }[] = [
    {
      name: "white",
      tint: [1, 1, 1],
      tex: [1, 1, 1],
      textureAlpha: 1,
      textured: false,
    },
    {
      name: "red",
      tint: [1, 0, 0],
      tex: [1, 1, 1],
      textureAlpha: 1,
      textured: false,
    },
    {
      name: "tinted texture",
      tint: [0.5, 1, 0.25],
      tex: [1, 0.5, 1],
      textureAlpha: 1,
      textured: true,
    },
    {
      name: "RGBA texture",
      tint: [1, 1, 1],
      tex: [1, 1, 1],
      textureAlpha: 0.5,
      textured: true,
    },
  ];
  cases.push({
    name: "material tint and opacity",
    tint: [1, 1, 1],
    tex: [1, 1, 1],
    textureAlpha: 0.5,
    textured: true,
    materialTint: [0.5, 1, 0.25],
    materialOpacity: 0.5,
  });
  const curves = [
    [1, 1],
    [1, 0],
    [0, 1],
    [0, 1, 0],
  ];
  const pixels = new Uint8Array(4);
  for (const mode of [
    "alpha",
    "additive",
    "premultiplied",
    "opaque",
    "masked",
  ] as const) {
    for (const sample of cases) {
      const g = graph(
        sample.textured,
        mode === "opaque" || mode === "masked" ? mode : "normal",
      );
      const instance = createMaterialInstance(g, "alpha-test");
      const artifact = compileMaterial(g, instance);
      const canvas = textureCanvas(sample.tex, sample.textureAlpha, false);
      const threeTexture = new CanvasTexture(canvas);
      const emitter = normalizeParticleEffect({
        emitters: [
          {
            render: {
              material: instance,
              blend: mode === "opaque" || mode === "masked" ? "alpha" : mode,
              texture: "test.png",
            },
          },
        ],
      }).emitters[0]!;
      const resolved = createThreeEmitterMaterial(emitter, {
        camera,
        effect: normalizeParticleEffect({ emitters: [emitter] }),
        materialGraphProvider: () => g,
        textureProvider: { getTexture: () => threeTexture },
      });
      const material = resolved.material;
      if (!(material instanceof ShaderMaterial))
        throw new Error("Expected actual Tier-2 Three shader");
      const fixedTint = sample.materialTint ?? [1, 1, 1];
      const fixedOpacity = sample.materialOpacity ?? 1;
      (material.uniforms.uFixedTint!.value as Vector4).set(...fixedTint, 1);
      material.uniforms.uFixedOpacity!.value = fixedOpacity;
      const mesh = new Mesh(geometry, material);
      scene.add(mesh);
      for (const sourceMode of [
        "premultiply-alpha-on-upload",
        "no-premultiply-alpha",
        "premultiplied-alpha",
      ] as const) {
        const pixiTexture = new PixiTexture({
          source: new CanvasSource({
            resource:
              sourceMode === "premultiplied-alpha"
                ? textureCanvas(sample.tex, sample.textureAlpha, true)
                : canvas,
            alphaMode: sourceMode,
          }),
        });
        const shader = createTier2ParticleMaterialShader({
          graph: g,
          instance,
          artifact,
          texture: pixiTexture,
        })!;
        shader.resources.materialUniforms.uniforms.uFixedTint =
          new Float32Array([...fixedTint, 1]);
        shader.resources.materialUniforms.uniforms.uFixedOpacity = fixedOpacity;
        const container = new ParticleContainer({
          texture: pixiTexture,
          shader,
          dynamicProperties: { color: true },
        });
        container.blendMode =
          mode === "additive" ? "add" : mode === "opaque" ? "none" : "normal";
        const particle = new Particle({
          texture: pixiTexture,
          x: 16,
          y: 16,
          anchorX: 0.5,
          anchorY: 0.5,
          scaleX: 8,
          scaleY: 8,
        });
        container.addParticle(particle);
        app.stage.addChild(container);
        for (const curve of curves) {
          const curveEmitter = normalizeParticleEffect({
            emitters: [
              {
                modules: { color: true },
                color: {
                  gradient: {
                    colorStops: [
                      { position: 0, color: sample.tint },
                      { position: 1, color: sample.tint },
                    ],
                    alphaStops: curve.map((alpha, i) => ({
                      position: i / (curve.length - 1),
                      alpha,
                    })),
                  },
                },
              },
            ],
          }).emitters[0]!;
          for (const age of [0, 0.25, 0.5, 0.75, 1]) {
            const color = sampleParticleModuleColor(curveEmitter, age, 0, 0.5);
            const alpha = color[3] * sample.textureAlpha * fixedOpacity;
            particle.tint =
              (Math.round(color[0] * 255) << 16) |
              (Math.round(color[1] * 255) << 8) |
              Math.round(color[2] * 255);
            particle.alpha = color[3];
            (material.uniforms.uParticleColor!.value as Vector4).set(...color);
            for (const bg of backgrounds) {
              const effectiveAlpha =
                mode === "opaque"
                  ? 1
                  : mode === "masked"
                    ? color[3] * sample.textureAlpha < 0.333
                      ? 0
                      : 1
                    : alpha;
              const rgb = sample.tint.map(
                (value, i) =>
                  value *
                  fixedTint[i]! *
                  (sample.textured ? sample.tex[i]! : 1),
              );
              const expected = [
                ...bg.map((value, i) =>
                  Math.min(
                    1,
                    rgb[i]! * effectiveAlpha +
                      value * (mode === "additive" ? 1 : 1 - effectiveAlpha),
                  ),
                ),
                1,
              ];
              const label = `${mode}/${sample.name}/${sourceMode}/curve=${curve}/age=${age}/bg=${bg}`;
              app.renderer.background.color = bg;
              app.render();
              const gl = (
                app.renderer as unknown as { gl: WebGLRenderingContext }
              ).gl;
              gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              check(`Pixi ${label}`, pixels, expected);
              three.setClearColor(new Color(...bg), 1);
              three.render(scene, camera);
              const gl3 = three.getContext();
              gl3.readPixels(16, 16, 1, 1, gl3.RGBA, gl3.UNSIGNED_BYTE, pixels);
              check(`Three ${label}`, pixels, expected);
            }
          }
        }
        app.stage.removeChild(container);
        container.destroy();
        shader.destroy();
        pixiTexture.destroy(true);
      }
      scene.remove(mesh);
      material.dispose();
      threeTexture.dispose();
      resolved.ownedTextures.forEach((texture) => texture.dispose());
    }
  }
  geometry.dispose();
  three.dispose();
  app.destroy(true);
}
run()
  .catch((error) => failures.push(String(error)))
  .finally(() => {
    window.alphaRegressionResult = { checks, failures };
  });
