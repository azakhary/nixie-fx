import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  FrontSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoBlending,
  NormalBlending,
  PerspectiveCamera,
  Quaternion,
  Scene,
  ShaderMaterial,
  Texture,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import {
  Particle as PixiParticle,
  ParticleContainer as PixiParticleContainer,
  Texture as PixiTexture,
} from "pixi.js";
import { describe, expect, it } from "vitest";
import { normalizeParticleEffect, srgbToLinear } from "../../engine/particles";
import {
  createMaterialInstance,
  createSpriteMasterGraph,
  normalizeShaderGraph,
  type ShaderGraph,
} from "../schema/materials";
import { PixiVfxEffectInstance } from "../pixi/renderer";
import { createPixiVfx2dProjection } from "../pixi/projection";
import { canUseInstancedBillboard } from "./instancedBillboard";
import { ThreeVfxRenderer } from "./renderer";

describe("ThreeVfxRenderer transform MVP", () => {
  it("keeps fixed-vector particles ground-aligned instead of facing the camera", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "ground-quad",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "ground",
            ...singleBurstEmitter(),
            render: { alignment: "vector", alignmentVector: [0, 1, 0] },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [quad] = instance.getParticleDebugTransforms();

    expect(quad?.normal).toEqual([0, 1, 0]);
    expect(quad?.mode).toBe("billboard");
  });

  it("uses the camera-facing normal for face-camera billboards", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "camera-facing",
        targetProfile: "three-world-3d",
        emitters: [{ id: "billboard", ...singleBurstEmitter() }],
      }),
    );

    renderer.update(1 / 60);
    const [quad] = instance.getParticleDebugTransforms();

    expect(quad?.normal[0]).toBeCloseTo(0);
    expect(quad?.normal[1]).toBeCloseTo(0);
    expect(quad?.normal[2]).toBeCloseTo(1);
  });

  it("can preserve meshes when only emitter spawn data changes", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const effect = normalizeParticleEffect({
      id: "move-origin",
      targetProfile: "three-world-3d",
      emitters: [{ id: "billboard", ...singleBurstEmitter() }],
    });
    const instance = renderer.createEffect(effect);

    renderer.update(1 / 60);
    const meshBefore = instance.root.children[0];
    expect(meshBefore).toBeInstanceOf(Mesh);

    instance.updateDefinition(
      normalizeParticleEffect({
        ...effect,
        emitters: effect.emitters.map((emitter) => ({
          ...emitter,
          spawn: { ...emitter.spawn, position: [2, 0, 0] },
        })),
      }),
      { preserveViews: true },
    );
    renderer.update(1 / 60);

    expect(instance.root.children[0]).toBe(meshBefore);
  });

  it("aligns velocity particles to the current world velocity", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "velocity-aligned",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "velocity",
            ...singleBurstEmitter(),
            initializeParticle: {
              velocity: { mode: "vector", min: [2, 0, 0], max: [2, 0, 0] },
            },
            render: { alignment: "velocity" },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [quad] = instance.getParticleDebugTransforms();

    expect(quad?.normal[0]).toBeCloseTo(1);
    expect(quad?.normal[1]).toBeCloseTo(0);
    expect(quad?.normal[2]).toBeCloseTo(0);
  });

  it("aligns local up to velocity while the particle still faces the camera plane", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const emitter = singleBurstEmitter();
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "velocity-up-camera-facing",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "velocity-up",
            ...emitter,
            initializeParticle: {
              ...(emitter.initializeParticle as Record<string, unknown>),
              velocity: { mode: "vector", min: [2, 0, 0], max: [2, 0, 0] },
            },
            render: { alignAxis: "velocity", facing: "cameraPlane" },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [quad] = instance.getParticleDebugTransforms();
    const up = upFromMatrix(quad!.matrix);

    expect(quad?.normal[0]).toBeCloseTo(0, 4);
    expect(quad?.normal[1]).toBeCloseTo(0, 4);
    expect(quad?.normal[2]).toBeCloseTo(1, 4);
    expect(up.x).toBeCloseTo(1, 4);
    expect(up.y).toBeCloseTo(0, 4);
    expect(up.z).toBeCloseTo(0, 4);
  });

  it("keeps camera-facing alignment finite when the aligned axis points at the camera", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const emitter = singleBurstEmitter();
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "edge-on-facing",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "edge-on",
            ...emitter,
            initializeParticle: {
              ...(emitter.initializeParticle as Record<string, unknown>),
              velocity: { mode: "vector", min: [0, 0, 2], max: [0, 0, 2] },
            },
            render: { alignAxis: "velocity", facing: "cameraPlane" },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [quad] = instance.getParticleDebugTransforms();

    expect(quad?.matrix.every(Number.isFinite)).toBe(true);
    expect(quad?.normal.every(Number.isFinite)).toBe(true);
  });

  it("re-points a velocity-aligned sprite as noise turns its path (I13-F)", () => {
    const makeInstance = (noise: boolean) => {
      const renderer = new ThreeVfxRenderer({
        scene: new Scene(),
        camera: createCamera(),
      });
      const emitter = singleBurstEmitter();
      return renderer.createEffect(
        normalizeParticleEffect({
          id: `velocity-noise-${noise}`,
          targetProfile: "three-world-3d",
          emitters: [
            {
              id: "velocity-noise",
              ...emitter,
              modules: { color: false, rotation: false, noise },
              initializeParticle: {
                ...(emitter.initializeParticle as Record<string, unknown>),
                velocity: { mode: "vector", min: [1, 0, 0], max: [1, 0, 0] },
              },
              advanced: {
                noise: {
                  strength: { mode: "constant", value: 5 },
                  frequency: 1,
                  speed: 0.5,
                  scroll: [1, 1, 1],
                  octaves: 3,
                  damping: 0.5,
                },
              },
              // facing "off" makes the debug normal the raw aligned axis.
              render: { alignAxis: "velocity", facing: "off" },
            },
          ],
        }),
      );
    };

    const withNoise = makeInstance(true);
    const withoutNoise = makeInstance(false);
    // Advance past the noise spawn ramp (normalizedAge > 0.1, life 1s).
    for (let i = 0; i < 12; i++) {
      withNoise.update(1 / 60);
      withoutNoise.update(1 / 60);
    }

    const noiseNormal = withNoise.getParticleDebugTransforms()[0]!.normal;
    const plainNormal = withoutNoise.getParticleDebugTransforms()[0]!.normal;
    expect(noiseNormal.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...noiseNormal)).toBeCloseTo(1, 4);
    // Noise now steers the alignment axis away from the noise-free direction.
    const dot =
      noiseNormal[0]! * plainNormal[0]! +
      noiseNormal[1]! * plainNormal[1]! +
      noiseNormal[2]! * plainNormal[2]!;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    expect(angle).toBeGreaterThan(0.01);
  });

  it("re-points a collided velocity-aligned sprite up through the bounce (H generalized, I13-F)", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const emitter = singleBurstEmitter();
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "velocity-collision",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "velocity-collision",
            ...emitter,
            modules: {
              color: false,
              rotation: false,
              velocity: true,
              collision: true,
            },
            forces: {
              gravity: 0,
              gravityValue: { mode: "constant", value: 4 },
              drag: 0,
              dragValue: { mode: "constant", value: 0 },
            },
            advanced: {
              collision: {
                mode: "plane",
                planeY: -0.05,
                radius: 0,
                bounce: 0.9,
                dampen: 0,
                killBelow: 100,
              },
            },
            render: { alignAxis: "velocity", facing: "off" },
          },
        ],
      }),
    );

    // Before impact the sprite points straight down; after the bounce the
    // reflected velocity (I13-H, composed via the D7 delta) turns it upward.
    let maxUp = -Infinity;
    for (let i = 0; i < 24; i++) {
      instance.update(1 / 60);
      const normal = instance.getParticleDebugTransforms()[0]?.normal;
      if (normal) {
        expect(normal.every(Number.isFinite)).toBe(true);
        maxUp = Math.max(maxUp, normal[1]!);
      }
    }
    expect(maxUp).toBeGreaterThan(0.3);
  });

  it("separates camera-plane facing from camera-position facing off axis", () => {
    const sampleNormal = (facing: "cameraPlane" | "cameraPosition") => {
      const camera = createCamera();
      camera.position.set(4, 0, 10);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
      const instance = renderer.createEffect(
        normalizeParticleEffect({
          id: `screen-${facing}`,
          targetProfile: "three-world-3d",
          emitters: [
            {
              id: `screen-${facing}-emitter`,
              ...singleBurstEmitter(),
              spawn: { position: [2, 0, 0] },
              render: { alignAxis: "screen", facing },
            },
          ],
        }),
      );

      renderer.update(1 / 60);
      return instance.getParticleDebugTransforms()[0]!.normal;
    };

    const plane = sampleNormal("cameraPlane");
    const position = sampleNormal("cameraPosition");

    expect(plane[0]).not.toBeCloseTo(position[0], 4);
    expect(plane[2]).not.toBeCloseTo(position[2], 4);
  });

  it("spawns prepared mesh particles from the mesh provider", () => {
    const camera = createCamera();
    const scene = new Scene();
    const renderer = new ThreeVfxRenderer({
      scene,
      camera,
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/coin.glb" ? new BoxGeometry(1, 1, 1) : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-particle",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mesh",
            ...singleBurstEmitter(),
            mode: "mesh",
            mesh: {
              renderMode: "meshAsset",
              asset: { type: "mesh", id: "coin", path: "meshes/coin.glb" },
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [mesh] = instance.getParticleDebugTransforms();

    expect(mesh?.mode).toBe("meshAsset");
    expect(renderer.stats.missingMeshRefs).toEqual([]);
    expect(scene.children).toContain(renderer.root);
  });

  it("keeps opaque alpha particles writing depth while disabling translucent and additive writes", () => {
    // Unlit textureless billboards ride the instanced fast path (F13); the
    // per-sample I12-A gate applies there at batch granularity via the
    // committed instance alphas. The `lit` variants pin the legacy
    // per-particle mesh path so its per-sample gate stays covered too.
    const sample = (
      blend: "alpha" | "additive",
      alpha = 1,
      shading: "unlit" | "lit" = "unlit",
    ) => {
      const renderer = new ThreeVfxRenderer({
        scene: new Scene(),
        camera: createCamera(),
      });
      const instance = renderer.createEffect(
        normalizeParticleEffect({
          id: `depth-${blend}-${shading}`,
          targetProfile: "three-world-3d",
          emitters: [
            {
              id: blend,
              ...singleBurstEmitter({ color: [1, 1, 1, alpha] }),
              modules: { color: false },
              render: { blend, depthWrite: true, shading },
            },
          ],
        }),
      );

      renderer.update(1 / 60);
      return shading === "unlit"
        ? (firstInstancedBillboard(instance).material as ShaderMaterial)
        : firstParticleMaterial(instance);
    };

    const opaqueAlpha = sample("alpha");
    expect(opaqueAlpha.depthWrite).toBe(true);
    expect(opaqueAlpha.blending).toBe(NormalBlending);

    const translucentAlpha = sample("alpha", 0.5);
    expect(translucentAlpha.depthWrite).toBe(false);
    expect(translucentAlpha.blending).toBe(NormalBlending);

    const additive = sample("additive");
    expect(additive.depthWrite).toBe(false);
    expect(additive.blending).toBe(AdditiveBlending);

    const legacyOpaque = sample("alpha", 1, "lit");
    expect(legacyOpaque.depthWrite).toBe(true);
    expect(legacyOpaque.blending).toBe(NormalBlending);

    const legacyTranslucent = sample("alpha", 0.5, "lit");
    expect(legacyTranslucent.depthWrite).toBe(false);

    const legacyAdditive = sample("additive", 1, "lit");
    expect(legacyAdditive.depthWrite).toBe(false);
    expect(legacyAdditive.blending).toBe(AdditiveBlending);
  });

  it("renders a premultiplied emitter as a transparent, non-depth-writing normal-blended pass (I13-A)", () => {
    const renderPremultiplied = (alpha: number) => {
      const renderer = new ThreeVfxRenderer({
        scene: new Scene(),
        camera: createCamera(),
      });
      const instance = renderer.createEffect(
        normalizeParticleEffect({
          id: `premultiplied-${alpha}`,
          targetProfile: "three-world-3d",
          emitters: [
            {
              id: "premultiplied",
              ...singleBurstEmitter({ color: [1, 1, 1, alpha] }),
              modules: { color: false },
              render: { blend: "premultiplied", depthWrite: true },
            },
          ],
        }),
      );

      renderer.update(1 / 60);
      return firstParticleMaterial(instance);
    };

    // Fully-opaque alpha is the NoBlending trap stress case: premultiplied must
    // still be transparent + NormalBlending (never NoBlending), and — like
    // additive — must not write depth even though depthWrite:true was authored.
    const opaque = renderPremultiplied(1);
    expect(opaque.blending).toBe(NormalBlending);
    expect(opaque.blending).not.toBe(NoBlending);
    expect(opaque.premultipliedAlpha).toBe(true);
    expect(opaque.transparent).toBe(true);
    expect(opaque.depthWrite).toBe(false);

    const translucent = renderPremultiplied(0.5);
    expect(translucent.premultipliedAlpha).toBe(true);
    expect(translucent.transparent).toBe(true);
    expect(translucent.depthWrite).toBe(false);
  });

  it("sets premultipliedAlpha on a Tier-2 ShaderMaterial premultiplied emitter (I13-A)", () => {
    const graph = particleColorAlphaMaterialGraph();
    const material = createMaterialInstance(graph, "premult-tier2");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "premult-tier2",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "premult-tier2-emitter",
            ...singleBurstEmitter({ color: [1, 1, 1, 1] }),
            modules: { color: false },
            render: { material, blend: "premultiplied", depthWrite: true },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const rendered = firstParticleAnyMaterial(instance);
    expect(rendered).toBeInstanceOf(ShaderMaterial);
    const shader = rendered as ShaderMaterial;
    // Material is `normal` (not authoritative), so the premultiplied emitter
    // blend flows through: normal blending, premultiplied, transparent even at
    // particle alpha 1.
    expect(shader.blending).toBe(NormalBlending);
    expect(shader.premultipliedAlpha).toBe(true);
    expect(shader.transparent).toBe(true);
  });

  it("sets premultipliedAlpha on the trail material of a premultiplied emitter (I13-A)", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "premult-trail",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "premult-trail-emitter",
            ...singleBurstEmitter(),
            modules: {
              color: false,
              rotation: false,
              velocity: true,
              trails: true,
            },
            initializeParticle: {
              velocity: {
                mode: "vector",
                min: [2, 0, 0],
                max: [2, 0, 0],
                speed: { mode: "constant", value: 0 },
              },
            },
            advanced: {
              trails: {
                length: { mode: "constant", value: 0 },
                width: { mode: "constant", value: 0.2 },
                lifetime: { mode: "constant", value: 0.5 },
                ratio: 1,
                inheritColor: true,
                textureMode: "stretch",
                minVertexDistance: 0.001,
                worldSpace: true,
              },
            },
            render: { blend: "premultiplied" },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    renderer.update(1 / 60);
    renderer.update(1 / 60);

    const trail = firstTrailMesh(instance);
    expect((trail.material as MeshBasicMaterial).premultipliedAlpha).toBe(true);
  });

  it("excludes a premultiplied emitter from the instanced billboard fast path (I13-A D6)", () => {
    const texture = new Texture();
    const emitterFor = (blend: "alpha" | "additive" | "premultiplied") =>
      normalizeParticleEffect({
        id: `instanced-${blend}`,
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: `instanced-${blend}-emitter`,
            ...singleBurstEmitter(),
            render: { blend, texture: "particles/spark.png", sortMode: "none" },
          },
        ],
      }).emitters[0]!;

    // alpha/additive keep the one-draw fast path; premultiplied auto-falls back
    // to the per-particle mesh path (its straight-color + discard would kill the
    // low-alpha glow texels premultiplied is for).
    expect(canUseInstancedBillboard(emitterFor("alpha"), texture)).toBe(true);
    expect(canUseInstancedBillboard(emitterFor("additive"), texture)).toBe(
      true,
    );
    expect(canUseInstancedBillboard(emitterFor("premultiplied"), texture)).toBe(
      false,
    );
  });

  it("applies the effective-opacity depth-write gate to Three ShaderMaterials", () => {
    const graph = particleColorAlphaMaterialGraph();
    const material = createMaterialInstance(graph, "shader-depth");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "shader-depth",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "shader-depth-emitter",
            ...singleBurstEmitter({ color: [1, 1, 1, 0.5] }),
            modules: { color: false },
            render: { material, depthWrite: true },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const rendered = firstParticleAnyMaterial(instance);

    expect(rendered).toBeInstanceOf(ShaderMaterial);
    expect((rendered as ShaderMaterial).depthWrite).toBe(false);
  });

  it("keeps a live graph-driven opacity translucent even at particle alpha 1 (I12-A)", () => {
    const constantDriven = renderShaderMaterialAtAlpha(
      constantOpacityMaterialGraph(0.4),
      1,
    );
    expect(constantDriven.transparent).toBe(true);
    expect(constantDriven.depthWrite).toBe(false);

    const textureDriven = renderShaderMaterialAtAlpha(
      textureMaskOpacityMaterialGraph(),
      1,
    );
    expect(textureDriven.transparent).toBe(true);
    expect(textureDriven.depthWrite).toBe(false);
  });

  it("still lets constant-1 and unwired graph opacity go opaque at particle alpha 1 (I11-B/I11-I)", () => {
    const constantOne = renderShaderMaterialAtAlpha(
      constantOpacityMaterialGraph(1),
      1,
    );
    expect(constantOne.transparent).toBe(false);
    expect(constantOne.depthWrite).toBe(true);

    const unwired = renderShaderMaterialAtAlpha(timeOnlyMaterialGraph(), 1);
    expect(unwired.transparent).toBe(false);
    expect(unwired.depthWrite).toBe(true);
  });

  it("keeps depth writes off for a ParabMat-shaped graph at BugShowcase3's ~0.495 alpha", () => {
    const material = renderShaderMaterialAtAlpha(
      textureMaskOpacityMaterialGraph(),
      0.495,
    );
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
  });

  it("an Opaque material forces the opaque pass regardless of particle alpha (I12-G)", () => {
    for (const alpha of [1, 0.5]) {
      const material = renderShaderMaterialAtAlpha(
        opaqueBlendMaterialGraph(),
        alpha,
      );
      expect(material.blending).toBe(NoBlending);
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
      expect(material.fragmentShader).not.toContain("discard");
      expect(material.fragmentShader).toContain("outColor.a = 1.0;");
    }
  });

  it("a Masked material renders as a depth-written cutout pass (I12-G)", () => {
    const material = renderShaderMaterialAtAlpha(
      maskedBlendMaterialGraph(),
      0.495,
    );
    expect(material.blending).toBe(NormalBlending);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
    expect(material.fragmentShader).toContain(
      "if (maskValue < uClipValue) discard;",
    );
  });

  it("an Opaque material overrides an additive emitter on the fixed-function path", () => {
    const graph = { ...createSpriteMasterGraph(), blend: "opaque" as const };
    const material = createMaterialInstance(graph, "opaque-fixed");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "opaque-fixed",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "opaque-fixed-emitter",
            ...singleBurstEmitter({ color: [1, 1, 1, 0.5] }),
            modules: { color: false },
            render: { material, blend: "additive" },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const rendered = firstParticleMaterial(instance);

    expect(rendered.blending).toBe(NoBlending);
    expect(rendered.transparent).toBe(false);
    expect(rendered.depthWrite).toBe(true);
    expect(rendered.opacity).toBe(1);
  });

  it("rebuilds live Three emitter views when only the material blend changes", () => {
    const graph = createSpriteMasterGraph();
    const material = createMaterialInstance(graph, "blend-toggle");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "blend-toggle",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "blend-toggle-emitter",
            ...singleBurstEmitter(),
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const firstMesh = instance.root.children[0];
    expect(firstParticleMaterial(instance).blending).toBe(NormalBlending);

    graph.blend = "opaque";
    renderer.update(0);

    expect(instance.root.children[0]).not.toBe(firstMesh);
    expect(firstParticleMaterial(instance).blending).toBe(NoBlending);
  });

  it("bands cross-emitter render order by Order in Layer before particle sorting", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "order-band",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "higher-layer",
            ...singleBurstEmitter(),
            render: { orderInLayer: 10, sortMode: "distanceNearFirst" },
          },
          {
            id: "lower-layer",
            ...singleBurstEmitter(),
            render: { orderInLayer: -10, sortMode: "distanceNearFirst" },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const meshes = particleMeshes(instance);

    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.renderOrder).toBeGreaterThan(meshes[1]!.renderOrder);
    expect(meshes[0]!.renderOrder - meshes[1]!.renderOrder).toBeCloseTo(1, 5);
  });

  it("keeps same-layer emitters in the same render-order band", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "same-order-band",
        targetProfile: "three-world-3d",
        emitters: [
          positionedBurstEmitter("near", [0, 0, 8], {
            orderInLayer: 0,
            sortMode: "distanceFarFirst",
          }),
          positionedBurstEmitter("far", [0, 0, 0], {
            orderInLayer: 0,
            sortMode: "distanceFarFirst",
          }),
        ],
      }),
    );

    renderer.update(1 / 60);
    const meshes = particleMeshes(instance);

    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.renderOrder).toBe(meshes[1]!.renderOrder);
  });

  it("orders distanceNearFirst particles before farther particles inside a layer", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "near-first",
        targetProfile: "three-world-3d",
        emitters: [
          positionedBurstEmitter("near", [0, 0, 8], {
            orderInLayer: 0,
            sortMode: "distanceNearFirst",
          }),
          positionedBurstEmitter("far", [0, 0, 0], {
            orderInLayer: 0,
            sortMode: "distanceNearFirst",
          }),
        ],
      }),
    );

    renderer.update(1 / 60);
    const meshes = particleMeshes(instance);

    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.renderOrder).toBeLessThan(meshes[1]!.renderOrder);
  });

  it("flips mesh asset winding on a cloned geometry when opted in", () => {
    const sourceGeometry = triangleGeometry();
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/triangle.glb" ? sourceGeometry : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-flip-winding",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "flip",
            ...singleBurstEmitter(),
            mode: "mesh",
            mesh: {
              renderMode: "meshAsset",
              asset: {
                type: "mesh",
                id: "triangle",
                path: "meshes/triangle.glb",
              },
              flipWinding: true,
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const mesh = firstParticleMesh(instance);

    expect(mesh.geometry).not.toBe(sourceGeometry);
    expect(indexValues(mesh.geometry)).toEqual([0, 2, 1]);
    expect(indexValues(sourceGeometry)).toEqual([0, 1, 2]);
  });

  it("applies normalized mesh pivot against imported mesh bounds on XYZ", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/pivot.glb" ? new BoxGeometry(2, 4, 6) : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-normalized-pivot",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "pivot",
            ...singleBurstEmitter(),
            mode: "mesh",
            modules: { velocity: false, rotation: false, size: false },
            render: { alignment: "vector", alignmentVector: [0, 0, 1] },
            mesh: {
              renderMode: "meshAsset",
              asset: { type: "mesh", id: "pivot", path: "meshes/pivot.glb" },
              pivot: [0.5, -0.25, 0.25],
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [debug] = instance.getParticleDebugTransforms();
    const position = positionFromMatrix(debug!.matrix);

    expect(position.x).toBeCloseTo(-1, 5);
    expect(position.y).toBeCloseTo(1, 5);
    expect(position.z).toBeCloseTo(-1.5, 5);
  });

  const billboardPivotThreeEffect = (
    id: string,
    pivot: [number, number] | undefined,
    extraRender: Record<string, unknown> = {},
  ) =>
    normalizeParticleEffect({
      id,
      targetProfile: "three-world-3d",
      emitters: [
        {
          id: "billboard-pivot",
          ...singleBurstEmitter(),
          mode: "billboard",
          modules: { velocity: false, rotation: false, size: false },
          render: {
            alignment: "vector",
            alignmentVector: [0, 0, 1],
            facing: "off",
            ...extraRender,
          },
          billboard: {
            sizeValue: { mode: "constant", value: 1 },
            ...(pivot ? { pivot } : {}),
          },
        },
      ],
    });

  it("applies billboard pivot in Y-up quad space with no sign flip (I13-B T8)", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(
      billboardPivotThreeEffect("billboard-pivot-matrix", [0.5, 0.5]),
    );

    renderer.update(1 / 60);
    const [debug] = instance.getParticleDebugTransforms();
    const position = positionFromMatrix(debug!.matrix);
    const scale = scaleFromMatrix(debug!.matrix);

    // pivotBoundsSize=[1,1,0] for the unit quad → pivotX=0.5, pivotY=0.5,
    // pivotZ=0. Translate(-pivot) is innermost, so translation = -scale·pivot
    // with +pivot on X and Y (no flip); Z is inert (Vec2).
    expect(position.x).toBeCloseTo(-0.5 * scale.x, 5);
    expect(position.y).toBeCloseTo(-0.5 * scale.y, 5);
    expect(position.z).toBeCloseTo(0, 5);
  });

  it("keeps billboard pivot Y-parity across Three and Pixi (I13-B T9, LOAD-BEARING)", () => {
    // Canonical Y = Three. For pivot Y = +0.5 both previews must shift content
    // the SAME screen direction (down): Three translation y < 0 and Pixi
    // anchorY = 0.0 (pinned at the top → content hangs down). A naive un-gate
    // that reused mesh's Pixi +Y convention would make anchorY = 1.0 and fail.
    const three = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const threeInstance = three.createEffect(
      billboardPivotThreeEffect("billboard-pivot-parity-three", [0, 0.5]),
    );
    three.update(1 / 60);
    const [debug] = threeInstance.getParticleDebugTransforms();
    const position = positionFromMatrix(debug!.matrix);
    const scale = scaleFromMatrix(debug!.matrix);
    expect(position.y).toBeCloseTo(-0.5 * scale.y, 5);
    expect(position.y).toBeLessThan(0);

    const pixi = new PixiVfxEffectInstance({
      effect: {
        id: "billboard-pivot-parity-pixi",
        emitters: [
          {
            id: "parity",
            mode: "billboard",
            maxParticles: 1,
            duration: 1,
            loop: false,
            modules: {
              color: false,
              rotation: false,
              size: false,
              velocity: false,
            },
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
              rotation: { mode: "constant", value: 0 },
              angularVelocity: { mode: "constant", value: 0 },
            },
            billboard: {
              sizeValue: { mode: "constant", value: 1 },
              pivot: [0, 0.5],
            },
          },
        ],
      },
      fallbackTextures: {
        circle: PixiTexture.EMPTY,
        square: PixiTexture.EMPTY,
        triangleShard: PixiTexture.EMPTY,
        quadShard: PixiTexture.EMPTY,
        grassShard: PixiTexture.EMPTY,
      },
      projection: createPixiVfx2dProjection({ pixelsPerUnit: 100 }),
      seed: 1,
      timeSeconds: 0,
    });
    pixi.update(0.01, 0.01);
    const pixiParticle = firstPixiParticle(pixi);
    expect(pixiParticle.anchorY).toBeCloseTo(0, 5);

    pixi.destroy();
  });

  it("keeps billboard pivot=0 byte-identical to a no-pivot billboard (I13-B T10)", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const withZero = renderer.createEffect(
      billboardPivotThreeEffect("billboard-pivot-zero", [0, 0]),
    );
    renderer.update(1 / 60);
    const zeroMatrix = [...withZero.getParticleDebugTransforms()[0]!.matrix];

    const renderer2 = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const noPivot = renderer2.createEffect(
      billboardPivotThreeEffect("billboard-pivot-none", undefined),
    );
    renderer2.update(1 / 60);
    const noPivotMatrix = [...noPivot.getParticleDebugTransforms()[0]!.matrix];

    expect(zeroMatrix).toEqual(noPivotMatrix);
  });

  it("flows billboard pivot through the instanced fast path without demotion (I13-B T11)", () => {
    const texture = new Texture();
    const makeRenderer = () =>
      new ThreeVfxRenderer({
        scene: new Scene(),
        camera: createCamera(),
        textureProvider: {
          getTexture: (ref) =>
            ref.path === "fx/main.png" ? texture : undefined,
        },
      });

    const instancedRenderer = makeRenderer();
    const instanced = instancedRenderer.createEffect(
      billboardPivotThreeEffect("billboard-pivot-instanced", [0.3, -0.2], {
        texture: "fx/main.png",
        sortMode: "none",
      }),
    );
    instancedRenderer.update(1 / 60);
    expect(instanced.stats.instancedDrawCalls).toBe(1);
    expect(instanced.stats.legacyParticleDrawCalls).toBe(0);
    const instancedMatrix = [
      ...instanced.getParticleDebugTransforms()[0]!.matrix,
    ];

    // Same emitter but lit → retained path (canUseInstancedBillboard=false);
    // the transform matrix must be identical (both call writeSampleMatrix).
    const retainedRenderer = makeRenderer();
    const retained = retainedRenderer.createEffect(
      billboardPivotThreeEffect("billboard-pivot-retained", [0.3, -0.2], {
        texture: "fx/main.png",
        sortMode: "none",
        shading: "lit",
      }),
    );
    retainedRenderer.update(1 / 60);
    expect(retained.stats.instancedDrawCalls).toBe(0);
    const retainedMatrix = [
      ...retained.getParticleDebugTransforms()[0]!.matrix,
    ];

    expect(instancedMatrix).toEqual(retainedMatrix);

    // The pivot really flows through the instanced write: a zero-pivot instanced
    // billboard yields a different (un-offset) matrix, proving no free demotion
    // AND that the pivot is applied on the fast path (not silently dropped).
    const zeroRenderer = makeRenderer();
    const zero = zeroRenderer.createEffect(
      billboardPivotThreeEffect("billboard-pivot-instanced-zero", [0, 0], {
        texture: "fx/main.png",
        sortMode: "none",
      }),
    );
    zeroRenderer.update(1 / 60);
    expect(zero.stats.instancedDrawCalls).toBe(1);
    const zeroMatrix = [...zero.getParticleDebugTransforms()[0]!.matrix];
    expect(instancedMatrix).not.toEqual(zeroMatrix);
  });

  it("applies mesh XYZ start rotation in Three", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-xyz-start-rotation",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mesh-xyz",
            ...singleBurstEmitter(),
            mode: "mesh",
            modules: { velocity: false, rotation: false },
            render: { alignment: "vector", alignmentVector: [0, 0, 1] },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              size3D: {
                x: { mode: "constant", value: 1 },
                y: { mode: "constant", value: 1 },
                z: { mode: "constant", value: 1 },
              },
              velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
              rotation3D: {
                x: { mode: "constant", value: 0.2 },
                y: { mode: "constant", value: 0.3 },
                z: { mode: "constant", value: 0.4 },
              },
              color: {
                color: [1, 1, 1, 1],
                intensity: { mode: "constant", value: 1 },
              },
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [mesh] = instance.getParticleDebugTransforms();
    const euler = eulerFromMatrix(mesh!.matrix);

    expect(mesh?.mode).toBe("pixiShard");
    expect(euler.x).toBeCloseTo(0.2, 4);
    expect(euler.y).toBeCloseTo(0.3, 4);
    expect(euler.z).toBeCloseTo(0.4, 4);
  });

  it("applies enabled billboard XYZ start rotation in Three", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "billboard-xyz-start-rotation",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "billboard-xyz",
            ...singleBurstEmitter(),
            mode: "billboard",
            modules: { velocity: false, rotation: false },
            render: {
              alignAxis: "vector",
              alignmentVector: [0, 0, 1],
              facing: "off",
            },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              startRotationSeparateAxes: true,
              rotation3D: {
                x: { mode: "constant", value: 0.2 },
                y: { mode: "constant", value: 0.3 },
                z: { mode: "constant", value: 0.4 },
              },
              velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [billboard] = instance.getParticleDebugTransforms();
    const euler = eulerFromMatrix(billboard!.matrix);

    expect(billboard?.mode).toBe("billboard");
    expect(euler.x).toBeCloseTo(0.2, 4);
    expect(euler.y).toBeCloseTo(0.3, 4);
    expect(euler.z).toBeCloseTo(0.4, 4);
  });

  it("applies mesh start scale and size over lifetime on XYZ in Three", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/scale.glb" ? new BoxGeometry(1, 1, 1) : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-xyz-size",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mesh-xyz-size-emitter",
            ...singleBurstEmitter(),
            mode: "mesh",
            modules: { velocity: false, rotation: false, size: true },
            render: { alignment: "vector", alignmentVector: [0, 0, 1] },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              size3D: {
                x: { mode: "constant", value: 2 },
                y: { mode: "constant", value: 3 },
                z: { mode: "constant", value: 4 },
              },
              velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
            },
            mesh: {
              renderMode: "meshAsset",
              asset: { type: "mesh", id: "scale", path: "meshes/scale.glb" },
              sizeValue: { mode: "constant", value: 0.5 },
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [mesh] = instance.getParticleDebugTransforms();
    const scale = scaleFromMatrix(mesh!.matrix);

    expect(mesh?.mode).toBe("meshAsset");
    expect(scale.x).toBeCloseTo(1, 4);
    expect(scale.y).toBeCloseTo(1.5, 4);
    expect(scale.z).toBeCloseTo(2, 4);
  });

  it("applies mesh size-over-lifetime curves independently per axis", () => {
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/split.glb" ? new BoxGeometry(1, 1, 1) : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-axis-size",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mesh-axis-size-emitter",
            ...singleBurstEmitter(),
            mode: "mesh",
            modules: { velocity: false, rotation: false, size: true },
            render: { alignment: "vector", alignmentVector: [0, 0, 1] },
            initializeParticle: {
              lifetime: { mode: "constant", value: 1 },
              size3D: {
                x: { mode: "constant", value: 1 },
                y: { mode: "constant", value: 1 },
                z: { mode: "constant", value: 1 },
              },
              velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
            },
            mesh: {
              renderMode: "meshAsset",
              asset: { type: "mesh", id: "split", path: "meshes/split.glb" },
              separateAxes: true,
              sizeValue: { mode: "constant", value: 0.5 },
              sizeValueY: { mode: "constant", value: 1.5 },
              sizeValueZ: { mode: "constant", value: 2.5 },
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [mesh] = instance.getParticleDebugTransforms();
    const scale = scaleFromMatrix(mesh!.matrix);

    expect(mesh?.mode).toBe("meshAsset");
    expect(scale.x).toBeCloseTo(0.5, 4);
    expect(scale.y).toBeCloseTo(1.5, 4);
    expect(scale.z).toBeCloseTo(2.5, 4);
  });

  it("uses a lit Three material when renderer shading is Lit", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "lit-mesh-particle",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "lit",
            ...singleBurstEmitter({ intensity: 4 }),
            render: { shading: "lit" },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const material = firstParticleMaterial(instance);

    expect(material).toBeInstanceOf(MeshStandardMaterial);
    expect((material as MeshStandardMaterial).roughness).toBeGreaterThan(0);
    expect(
      (material as MeshStandardMaterial).emissiveIntensity,
    ).toBeGreaterThan(0);
  });

  it("feeds exposed HDR particle color into the bloom preview path", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      previewBloomEnabled: true,
      previewBloomThreshold: 1,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "hdr-preview",
        targetProfile: "three-world-3d",
        emitters: [{ id: "hdr", ...singleBurstEmitter({ intensity: 8 }) }],
      }),
    );

    renderer.update(1 / 60);
    expect(instance.stats.bloomSourceParticles).toBe(1);
    expect(instancedColorPeak(firstInstancedBillboard(instance))).toBeGreaterThan(
      1,
    );

    renderer.setPreviewBloomOptions({ enabled: false });
    expect(
      instancedColorPeak(firstInstancedBillboard(instance)),
    ).toBeLessThanOrEqual(1);
  });

  it("does not crush LDR particle colors to white under default preview bloom", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      previewBloomEnabled: true,
      previewBloomThreshold: 1,
    });
    // Stand-ins for a white->black color-over-life gradient sampled at
    // different ages: none of these are HDR (peak <= 1), so bloom must never
    // stamp them to a shared white.
    const nearWhite = 0xe0 / 255;
    const midGray = 0x83 / 255;
    const darkGray = 0x40 / 255;
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "ldr-preview",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "near-white",
            ...singleBurstEmitter({
              color: [nearWhite, nearWhite, nearWhite, 1],
            }),
          },
          {
            id: "mid-gray",
            ...singleBurstEmitter({ color: [midGray, midGray, midGray, 1] }),
          },
          {
            id: "dark-gray",
            ...singleBurstEmitter({ color: [darkGray, darkGray, darkGray, 1] }),
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const [nearWhiteMesh, midGrayMesh, darkGrayMesh] =
      instancedBillboards(instance);
    const nearWhitePeak = instancedColorPeak(nearWhiteMesh!);
    const midGrayPeak = instancedColorPeak(midGrayMesh!);
    const darkGrayPeak = instancedColorPeak(darkGrayMesh!);

    // The bug renormalized every peak >= threshold-knee (0.5 at defaults) up
    // to ~1.0, so mid-gray and near-white both read as white.
    expect(midGrayPeak).toBeLessThan(0.9);
    expect(midGrayPeak).toBeCloseTo(srgbToLinear(midGray), 5);

    // Brightness ordering across "ages" must survive bloom being enabled.
    expect(darkGrayPeak).toBeLessThan(midGrayPeak);
    expect(midGrayPeak).toBeLessThan(nearWhitePeak);
  });

  it("does not crush an LDR mid-gray uParticleColor to ~1.0 under default preview bloom on the Tier-2 shader path (I12-E gap)", () => {
    // Mirrors "does not crush LDR particle colors to white under default
    // preview bloom" above, but through a Tier-2 ShaderMaterial (a graph that
    // wires Particle Color -> baseColor, so emitter RGB stays live) instead of
    // the fixed-function MeshBasicMaterial path, since applyThreeShaderSample's
    // uParticleColor uses the same bloom-tone-mapped sample.shaderColor and had
    // no coverage. Unlike the fixed-function `color` (a THREE Color that
    // decodes SRGBColorSpace -> linear internally), uParticleColor carries the
    // encoded value as-is (see "feeds ShaderMaterial particle color as sRGB"
    // below), so the assertion compares against the encoded midGray, not its
    // linear decode.
    const camera = createCamera();
    const graph = particleColorMaterialGraph();
    const material = createMaterialInstance(graph, "mat-tier2-ldr-bloom");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      previewBloomEnabled: true,
      previewBloomThreshold: 1,
    });
    const midGray = 0x83 / 255;
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "tier2-ldr-bloom",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mid-gray",
            ...singleBurstEmitter({ color: [midGray, midGray, midGray, 1] }),
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const rendered = firstParticleAnyMaterial(instance);
    expect(rendered).toBeInstanceOf(ShaderMaterial);
    const color = particleUniform(rendered as ShaderMaterial);
    const peak = Math.max(color.x, color.y, color.z);

    // The bug renormalized every peak >= threshold-knee up to ~1.0, which
    // would stamp this LDR mid-gray sample to white on the shader path too.
    expect(peak).toBeLessThan(0.9);
    expect(peak).toBeCloseTo(midGray, 5);
  });

  it("applies fixed material tint and opacity in Three", () => {
    const camera = createCamera();
    const graph = createSpriteMasterGraph();
    const material = createMaterialInstance(graph, "mat");
    material.paramOverrides.Tint = [0.2, 0.5, 1, 0.8];
    material.paramOverrides.Emissive = 0;
    material.paramOverrides.Opacity = 0.5;
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "fixed-material",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "fixed",
            ...singleBurstEmitter(),
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const rendered = firstParticleMaterial(instance);

    expect(rendered.color.g).toBeGreaterThan(rendered.color.r);
    expect(rendered.opacity).toBeGreaterThan(0.35);
    expect(rendered.opacity).toBeLessThan(0.5);
    expect(renderer.stats.missingMaterialRefs).toEqual([]);
  });

  it("rebuilds live Three emitter views when only material Render Faces changes", () => {
    const camera = createCamera();
    const graph = createSpriteMasterGraph();
    const material = createMaterialInstance(graph, "mat-side-toggle");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "side-toggle",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "side",
            ...singleBurstEmitter(),
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const firstMesh = instance.root.children[0];
    expect(firstParticleMaterial(instance).side).toBe(DoubleSide);

    graph.side = "front";
    renderer.update(0);

    expect(instance.root.children[0]).not.toBe(firstMesh);
    expect(firstParticleMaterial(instance).side).toBe(FrontSide);
  });

  it("keeps meshAsset-mode particles two-sided when Render Faces is unset", () => {
    const camera = createCamera();
    const graph = createSpriteMasterGraph();
    const material = createMaterialInstance(graph, "mat-mesh-side-unset");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/coin.glb" ? new BoxGeometry(1, 1, 1) : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-side-unset",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mesh",
            ...singleBurstEmitter(),
            mode: "mesh",
            mesh: {
              renderMode: "meshAsset",
              asset: { type: "mesh", id: "coin", path: "meshes/coin.glb" },
            },
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);

    expect(firstParticleMaterial(instance).side).toBe(DoubleSide);
  });

  it("honors explicit Front Only on a meshAsset emitter", () => {
    const camera = createCamera();
    const graph = createSpriteMasterGraph();
    graph.side = "front";
    const material = createMaterialInstance(graph, "mat-mesh-side-front");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/coin.glb" ? new BoxGeometry(1, 1, 1) : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-side-front",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mesh",
            ...singleBurstEmitter(),
            mode: "mesh",
            mesh: {
              renderMode: "meshAsset",
              asset: { type: "mesh", id: "coin", path: "meshes/coin.glb" },
            },
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);

    expect(firstParticleMaterial(instance).side).toBe(FrontSide);
  });

  it("stays two-sided on a meshAsset emitter with flipWinding regardless of side", () => {
    const camera = createCamera();
    const graph = createSpriteMasterGraph();
    const material = createMaterialInstance(graph, "mat-mesh-flip-winding");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/coin.glb" ? new BoxGeometry(1, 1, 1) : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-flip-winding",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mesh",
            ...singleBurstEmitter(),
            mode: "mesh",
            mesh: {
              renderMode: "meshAsset",
              asset: { type: "mesh", id: "coin", path: "meshes/coin.glb" },
              flipWinding: true,
            },
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);

    expect(firstParticleMaterial(instance).side).toBe(DoubleSide);
  });

  it("keeps a Tier-2 shader-material meshAsset emitter two-sided when Render Faces is unset (I12-B gap: fixed-function-only coverage)", () => {
    const camera = createCamera();
    const graph = textureMaskOpacityMaterialGraph();
    const material = createMaterialInstance(graph, "mat-mesh-tier2-side-unset");
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
      meshProvider: {
        getMeshGeometry: (ref) =>
          ref.path === "meshes/coin.glb" ? new BoxGeometry(1, 1, 1) : null,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "mesh-tier2-side-unset",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "mesh",
            ...singleBurstEmitter(),
            mode: "mesh",
            mesh: {
              renderMode: "meshAsset",
              asset: { type: "mesh", id: "coin", path: "meshes/coin.glb" },
            },
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const rendered = firstParticleAnyMaterial(instance);

    expect(rendered).toBeInstanceOf(ShaderMaterial);
    expect((rendered as ShaderMaterial).side).toBe(DoubleSide);
  });

  it("decodes authored sRGB particle colors into Three working color space", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "srgb-particle-color",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "srgb",
            ...singleBurstEmitter({ color: [0.5, 0, 0, 1] }),
            modules: { color: false },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const rendered = instancedParticleColor(firstInstancedBillboard(instance));

    expect(rendered.r).toBeCloseTo(srgbToLinear(0.5), 5);
    expect(rendered.g).toBeCloseTo(0, 5);
    expect(rendered.b).toBeCloseTo(0, 5);
  });

  it("renders camera-facing history trails in Three with length 0 lifetime semantics", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "three-trails",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "trail",
            ...singleBurstEmitter(),
            modules: {
              color: false,
              rotation: false,
              velocity: true,
              trails: true,
            },
            initializeParticle: {
              velocity: {
                mode: "vector",
                min: [2, 0, 0],
                max: [2, 0, 0],
                speed: { mode: "constant", value: 0 },
              },
            },
            advanced: {
              trails: {
                length: { mode: "constant", value: 0 },
                width: { mode: "constant", value: 0.2 },
                lifetime: { mode: "constant", value: 0.5 },
                ratio: 1,
                inheritColor: true,
                textureMode: "stretch",
                minVertexDistance: 0.001,
                worldSpace: true,
              },
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    renderer.update(1 / 60);
    renderer.update(1 / 60);

    const trail = firstTrailMesh(instance);
    expect(trail.visible).toBe(true);
    expect(trail.geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(trail.geometry.getAttribute("color").itemSize).toBe(4);
  });

  it("honors Three trail ratio 0 without leaving stale trail geometry", () => {
    const camera = createCamera();
    const renderer = new ThreeVfxRenderer({ scene: new Scene(), camera });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "three-trail-ratio",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "trail-ratio",
            ...singleBurstEmitter(),
            modules: {
              color: false,
              rotation: false,
              velocity: true,
              trails: true,
            },
            initializeParticle: {
              velocity: {
                mode: "vector",
                min: [2, 0, 0],
                max: [2, 0, 0],
                speed: { mode: "constant", value: 0 },
              },
            },
            advanced: {
              trails: {
                length: { mode: "constant", value: 0 },
                width: { mode: "constant", value: 0.2 },
                lifetime: { mode: "constant", value: 0.5 },
                ratio: 0,
                inheritColor: true,
                textureMode: "stretch",
                minVertexDistance: 0.001,
                worldSpace: true,
              },
            },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    renderer.update(1 / 60);
    renderer.update(1 / 60);

    const trail = firstTrailMesh(instance);
    expect(trail.visible).toBe(false);
    expect(trail.geometry.getAttribute("position")).toBeUndefined();
  });

  it("selects texture sheet grid frames as per-particle map transforms in Three", () => {
    const camera = createCamera();
    const texture = new Texture();
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      textureProvider: {
        getTexture: (ref) =>
          ref.path === "fx/sheet.png" ? texture : undefined,
      },
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "three-sheet",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "sheet",
            ...singleBurstEmitter(),
            modules: {
              color: false,
              rotation: false,
              textureSheetAnimation: true,
            },
            render: { texture: "fx/sheet.png" },
            advanced: {
              textureSheetAnimation: {
                tiles: [2, 2],
                startFrame: 0,
                frameOverTime: { mode: "constant", value: 3 },
                cycles: 1,
                randomStartFrame: false,
              },
            },
          },
        ],
      }),
    );

    renderer.update(0.5);
    const rendered = firstParticleMaterial(instance);

    expect(rendered.map).not.toBe(texture);
    expect(rendered.map?.repeat.x).toBeCloseTo(0.5);
    expect(rendered.map?.repeat.y).toBeCloseTo(0.5);
    expect(rendered.map?.offset.x).toBeCloseTo(0.5);
    expect(rendered.map?.offset.y).toBeCloseTo(0);
  });

  it("feeds texture sheet frames into Three ShaderMaterial sub-UV uniforms", () => {
    const camera = createCamera();
    const texture = new Texture();
    const graph = particleColorMaterialGraph();
    const material = createMaterialInstance(graph, "mat-sheet-shader");
    material.mainTex = {
      type: "texture",
      id: "sheet",
      path: "fx/sheet.png",
    };
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      textureProvider: {
        getTexture: (ref) =>
          ref.path === "fx/sheet.png" ? texture : undefined,
      },
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "three-material-sheet",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "sheet",
            ...singleBurstEmitter(),
            modules: {
              color: false,
              rotation: false,
              textureSheetAnimation: true,
            },
            render: { material },
            advanced: {
              textureSheetAnimation: {
                tiles: [2, 2],
                startFrame: 0,
                frameOverTime: { mode: "constant", value: 3 },
                cycles: 1,
                randomStartFrame: false,
              },
            },
          },
        ],
      }),
    );

    renderer.update(0.5);
    const rendered = firstParticleAnyMaterial(instance) as ShaderMaterial;
    const subUv = subUvUniform(rendered);

    expect(rendered).toBeInstanceOf(ShaderMaterial);
    expect(rendered.uniforms.uTexture?.value).toBe(texture);
    expect(subUv.x).toBeCloseTo(0.5);
    expect(subUv.y).toBeCloseTo(0);
    expect(subUv.z).toBeCloseTo(0.5);
    expect(subUv.w).toBeCloseTo(0.5);
  });

  it("applies Tier-1 material UV panning to Three particle maps", () => {
    const camera = createCamera();
    const texture = new Texture();
    const graph = scrollingTextureGraph([0.25, 0]);
    const material = createMaterialInstance(graph, "mat-pan");
    material.mainTex = {
      type: "texture",
      id: "scroll",
      path: "fx/scroll.png",
    };
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      textureProvider: {
        getTexture: (ref) =>
          ref.path === "fx/scroll.png" ? texture : undefined,
      },
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "three-material-pan",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "pan",
            ...singleBurstEmitter(),
            render: { material },
          },
        ],
      }),
    );

    renderer.update(0.5);
    const rendered = firstParticleMaterial(instance);

    expect(rendered.map).not.toBe(texture);
    expect(rendered.map?.offset.x).toBeCloseTo(0.125);
    expect(rendered.map?.offset.y).toBeCloseTo(0);
  });

  it("uses a Three ShaderMaterial for compiler-approved Tier-2 material graphs", () => {
    const camera = createCamera();
    const texture = new Texture();
    const graph = particleColorMaterialGraph();
    const material = createMaterialInstance(graph, "mat-tier2");
    material.mainTex = {
      type: "texture",
      id: "main",
      path: "fx/main.png",
    };
    const renderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera,
      textureProvider: {
        getTexture: (ref) => (ref.path === "fx/main.png" ? texture : undefined),
      },
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const instance = renderer.createEffect(
      normalizeParticleEffect({
        id: "three-tier2-material",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "tier2",
            ...singleBurstEmitter(),
            render: { material },
          },
        ],
      }),
    );

    renderer.update(1 / 60);
    const rendered = firstParticleAnyMaterial(instance);

    expect(rendered).toBeInstanceOf(ShaderMaterial);
    expect((rendered as ShaderMaterial).uniforms.uTexture?.value).toBe(texture);
    expect(
      (rendered as ShaderMaterial).uniforms.uParticleColor?.value.w,
    ).toBeGreaterThan(0.9);
    expect(renderer.stats.unsupportedFeatures).toEqual([]);
  });

  it("feeds ShaderMaterial particle color as sRGB while fixed-function stays linear", () => {
    const encodedMid = 0.5;
    const graph = particleColorMaterialGraph();
    const material = createMaterialInstance(graph, "mat-srgb");
    const shaderRenderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
      materialGraphProvider: (shaderId) =>
        shaderId === graph.id ? graph : undefined,
    });
    const shaderInstance = shaderRenderer.createEffect(
      normalizeParticleEffect({
        id: "three-shader-srgb-color",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "shader",
            ...singleBurstEmitter({
              color: [encodedMid, encodedMid, encodedMid, 1],
            }),
            modules: { color: false },
            render: { material },
          },
        ],
      }),
    );

    shaderRenderer.update(1 / 60);
    const shaderUniform = particleUniform(
      firstParticleAnyMaterial(shaderInstance) as ShaderMaterial,
    );

    expect(shaderUniform.x).toBeCloseTo(encodedMid, 5);
    expect(shaderUniform.y).toBeCloseTo(encodedMid, 5);
    expect(shaderUniform.z).toBeCloseTo(encodedMid, 5);

    const fixedRenderer = new ThreeVfxRenderer({
      scene: new Scene(),
      camera: createCamera(),
    });
    const fixedInstance = fixedRenderer.createEffect(
      normalizeParticleEffect({
        id: "three-fixed-linear-color",
        targetProfile: "three-world-3d",
        emitters: [
          {
            id: "fixed",
            ...singleBurstEmitter({
              color: [encodedMid, encodedMid, encodedMid, 1],
            }),
            modules: { color: false },
          },
        ],
      }),
    );

    fixedRenderer.update(1 / 60);
    const fixedColor = instancedParticleColor(
      firstInstancedBillboard(fixedInstance),
    );
    expect(fixedColor.r).toBeCloseTo(srgbToLinear(encodedMid), 5);
  });

  it("gates emitter color and alpha for Tier-2 Three materials without Particle Color", () => {
    const graph = timeOnlyMaterialGraph();
    const sample = (color: [number, number, number, number]) => {
      const camera = createCamera();
      const material = createMaterialInstance(graph, "mat-time");
      const renderer = new ThreeVfxRenderer({
        scene: new Scene(),
        camera,
        materialGraphProvider: (shaderId) =>
          shaderId === graph.id ? graph : undefined,
      });
      const instance = renderer.createEffect(
        normalizeParticleEffect({
          id: "three-gated-color",
          targetProfile: "three-world-3d",
          emitters: [
            {
              id: "gated",
              ...singleBurstEmitter({ color }),
              modules: { color: false },
              render: { material },
            },
          ],
        }),
      );

      renderer.update(1 / 60);
      const rendered = firstParticleAnyMaterial(instance) as ShaderMaterial;
      return particleUniform(rendered);
    };

    expect(sample([1, 0, 0, 0.2])).toEqual(sample([0, 0, 1, 0.8]));
  });

  it("keeps emitter RGB live but gates alpha for Three Particle Color RGB materials", () => {
    const graph = particleColorMaterialGraph();
    const sample = (color: [number, number, number, number]) => {
      const camera = createCamera();
      const material = createMaterialInstance(graph, "mat-pc");
      const renderer = new ThreeVfxRenderer({
        scene: new Scene(),
        camera,
        materialGraphProvider: (shaderId) =>
          shaderId === graph.id ? graph : undefined,
      });
      const instance = renderer.createEffect(
        normalizeParticleEffect({
          id: "three-rgb-color",
          targetProfile: "three-world-3d",
          emitters: [
            {
              id: "rgb",
              ...singleBurstEmitter({ color }),
              modules: { color: false },
              render: { material },
            },
          ],
        }),
      );

      renderer.update(1 / 60);
      const rendered = firstParticleAnyMaterial(instance) as ShaderMaterial;
      return particleUniform(rendered);
    };

    const red = sample([1, 0, 0, 0.2]);
    const blue = sample([0, 0, 1, 0.8]);
    expect(red.x).not.toBe(blue.x);
    expect(red.w).toBeCloseTo(1, 5);
    expect(blue.w).toBeCloseTo(1, 5);
  });

  it("feeds Shader Custom Data channels into Three DynamicParameter uniforms", () => {
    const graph = dynamicParameterOpacityGraph("Param2");
    const material = createMaterialInstance(graph, "mat-dyn");
    const sample = (enabled: boolean) => {
      const camera = createCamera();
      const renderer = new ThreeVfxRenderer({
        scene: new Scene(),
        camera,
        materialGraphProvider: (shaderId) =>
          shaderId === graph.id ? graph : undefined,
      });
      const instance = renderer.createEffect(
        normalizeParticleEffect({
          id: "three-dynamic-params",
          targetProfile: "three-world-3d",
          emitters: [
            {
              id: "dyn",
              ...singleBurstEmitter(),
              modules: { color: false, customData: enabled },
              advanced: {
                customData: {
                  channels: [
                    { mode: "constant", value: 0.25 },
                    { mode: "constant", value: 0.5 },
                    { mode: "constant", value: 0.75 },
                    { mode: "constant", value: 1 },
                  ],
                },
              },
              render: { material },
            },
          ],
        }),
      );

      renderer.update(1 / 60);
      const rendered = firstParticleAnyMaterial(instance) as ShaderMaterial;
      return dynamicUniform(rendered);
    };

    expect(sample(true)).toEqual({ x: 0.25, y: 0.5, z: 0.75, w: 1 });
    expect(sample(false)).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  });
});

function createCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function singleBurstEmitter({
  intensity = 1,
  color = [1, 1, 1, 1],
}: {
  intensity?: number;
  color?: [number, number, number, number];
} = {}): Record<string, unknown> {
  return {
    maxParticles: 4,
    duration: 1,
    loop: false,
    spawn: {
      rate: 0,
      rateValue: { mode: "constant", value: 0 },
      bursts: [{ time: 0, count: 1, cycles: 1, interval: 0, probability: 1 }],
      shape: "point",
    },
    initializeParticle: {
      lifetime: { mode: "constant", value: 1 },
      size: { mode: "constant", value: 1 },
      size3D: {
        x: { mode: "constant", value: 1 },
        y: { mode: "constant", value: 1 },
        z: { mode: "constant", value: 1 },
      },
      velocity: { mode: "vector", min: [0, 0, 0], max: [0, 0, 0] },
      rotation: { mode: "constant", value: 0 },
      rotation3D: {
        x: { mode: "constant", value: 0 },
        y: { mode: "constant", value: 0 },
        z: { mode: "constant", value: 0 },
      },
      color: {
        color,
        intensity: { mode: "constant", value: intensity },
      },
      angularVelocity: { mode: "constant", value: 0 },
    },
    forces: {
      gravity: 0,
      gravityValue: { mode: "constant", value: 0 },
      drag: 0,
      dragValue: { mode: "constant", value: 0 },
    },
  };
}

function positionedBurstEmitter(
  id: string,
  position: [number, number, number],
  render: Record<string, unknown>,
): Record<string, unknown> {
  const emitter = singleBurstEmitter();
  return {
    id,
    ...emitter,
    spawn: {
      ...(emitter.spawn as Record<string, unknown>),
      position,
    },
    render,
  };
}

function firstParticleMaterial(instance: {
  root: { children: unknown[] };
}): MeshBasicMaterial | MeshStandardMaterial {
  const mesh = firstParticleMesh(instance);
  if (!(
    mesh.material instanceof MeshBasicMaterial ||
    mesh.material instanceof MeshStandardMaterial
  )) {
    throw new Error("Expected a billboard mesh with a particle material.");
  }
  return mesh.material;
}

function firstParticleAnyMaterial(instance: {
  root: { children: unknown[] };
}): unknown {
  const mesh = firstParticleMesh(instance);
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}

function firstParticleMesh(instance: { root: { children: unknown[] } }): Mesh {
  const mesh = particleMeshes(instance)[0];
  if (!mesh) {
    throw new Error("Expected a particle mesh.");
  }
  return mesh;
}

function particleMeshes(instance: { root: { children: unknown[] } }): Mesh[] {
  return instance.root.children.filter((child): child is Mesh => {
    if (!(child instanceof Mesh)) return false;
    if (!child.visible) return false;
    const material = Array.isArray(child.material)
      ? child.material[0]
      : child.material;
    return (
      material instanceof MeshBasicMaterial ||
      material instanceof MeshStandardMaterial ||
      material instanceof ShaderMaterial
    );
  });
}

function firstTrailMesh(instance: { root: { children: unknown[] } }): Mesh {
  const trail = instance.root.children.find(
    (child): child is Mesh =>
      child instanceof Mesh &&
      child.geometry instanceof BufferGeometry &&
      child.material instanceof MeshBasicMaterial &&
      child.material.vertexColors,
  );
  if (!trail) throw new Error("Expected a trail mesh.");
  return trail;
}

function eulerFromMatrix(values: number[]): Euler {
  const matrix = new Matrix4().fromArray(values);
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  return new Euler().setFromQuaternion(rotation, "XYZ");
}

function scaleFromMatrix(values: number[]): Vector3 {
  const matrix = new Matrix4().fromArray(values);
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  return scale;
}

function firstPixiParticle(instance: PixiVfxEffectInstance): PixiParticle {
  const containers = instance.root.children.filter(
    (child): child is PixiParticleContainer =>
      child instanceof PixiParticleContainer,
  );
  const container = containers[1] ?? containers[0];
  const particle = container?.particleChildren[0] as PixiParticle | undefined;
  if (!particle) throw new Error("Expected one rendered Pixi particle");
  return particle;
}

function positionFromMatrix(values: number[]): Vector3 {
  const matrix = new Matrix4().fromArray(values);
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  return position;
}

function upFromMatrix(values: number[]): Vector3 {
  return new Vector3()
    .setFromMatrixColumn(new Matrix4().fromArray(values), 1)
    .normalize();
}

function instancedBillboards(instance: {
  root: { children: unknown[] };
}): InstancedMesh[] {
  return instance.root.children.filter(
    (child): child is InstancedMesh => child instanceof InstancedMesh,
  );
}

function firstInstancedBillboard(instance: {
  root: { children: unknown[] };
}): InstancedMesh {
  const mesh = instancedBillboards(instance)[0];
  if (!mesh) throw new Error("Expected an instanced billboard mesh.");
  return mesh;
}

function instancedParticleColor(
  mesh: InstancedMesh,
  index = 0,
): { r: number; g: number; b: number; alpha: number } {
  const colors = mesh.geometry.getAttribute("aInstanceColor");
  const alphas = mesh.geometry.getAttribute("aInstanceAlpha");
  return {
    r: colors.getX(index),
    g: colors.getY(index),
    b: colors.getZ(index),
    alpha: alphas.getX(index),
  };
}

function instancedColorPeak(mesh: InstancedMesh, index = 0): number {
  const color = instancedParticleColor(mesh, index);
  return Math.max(color.r, color.g, color.b);
}

function triangleGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  geometry.setIndex(new Uint16BufferAttribute([0, 1, 2], 1));
  return geometry;
}

function indexValues(geometry: BufferGeometry): number[] {
  const index = geometry.getIndex();
  return index ? Array.from(index.array) : [];
}

function scrollingTextureGraph(speed: [number, number]): ShaderGraph {
  return normalizeShaderGraph({
    id: "three-scrolling-texture",
    name: "Three Scrolling Texture",
    blend: "normal",
    nodes: [
      matNode("uv", "uv"),
      matNode("time", "time"),
      matNode("pan", "panner", { uv: "e-uv", time: "e-time" }, { speed }),
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

function particleColorMaterialGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "three-particle-color-material",
    name: "Three Particle Color Material",
    blend: "normal",
    nodes: [matNode("particle", "particleColor")],
    edges: [matEdge("e-base", "particle", "out", "baseColor", "RGB")],
    outputs: { baseColor: "e-base" },
  });
}

function particleColorAlphaMaterialGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "three-particle-color-alpha-material",
    name: "Three Particle Color Alpha Material",
    blend: "normal",
    nodes: [matNode("particle", "particleColor")],
    edges: [
      matEdge("e-base", "particle", "out", "baseColor", "RGB"),
      matEdge("e-opacity", "particle", "out", "opacity", "A"),
    ],
    outputs: { baseColor: "e-base", opacity: "e-opacity" },
  });
}

function timeOnlyMaterialGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "three-time-only-material",
    name: "Three Time Only Material",
    blend: "normal",
    nodes: [matNode("time", "time")],
    edges: [matEdge("e-base", "time", "out", "baseColor")],
    outputs: { baseColor: "e-base" },
  });
}

/** Tier-2 graph (live dynamicParameter → baseColor) with a constant → opacity. */
function constantOpacityMaterialGraph(value: number): ShaderGraph {
  return normalizeShaderGraph({
    id: `three-constant-opacity-${value}`,
    name: "Three Constant Opacity",
    blend: "normal",
    nodes: [
      matNode("dyn", "dynamicParameter"),
      matNode("const", "constant", {}, { value }),
    ],
    edges: [
      matEdge("e-base", "dyn", "out", "baseColor"),
      matEdge("e-opacity", "const", "out", "opacity"),
    ],
    outputs: { baseColor: "e-base", opacity: "e-opacity" },
  });
}

/** ParabMat-shaped: opacity = multiply(particleColor.A, textureSample). */
function textureMaskOpacityMaterialGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "three-texture-mask-opacity",
    name: "Three Texture Mask Opacity",
    blend: "normal",
    nodes: [
      matNode("particle", "particleColor"),
      matNode("mask", "textureSample"),
      matNode("mul", "multiply", { a: "e-alpha", b: "e-mask" }),
    ],
    edges: [
      matEdge("e-alpha", "particle", "mul", "a", "A"),
      matEdge("e-mask", "mask", "mul", "b"),
      matEdge("e-base", "particle", "out", "baseColor", "RGB"),
      matEdge("e-opacity", "mul", "out", "opacity"),
    ],
    outputs: { baseColor: "e-base", opacity: "e-opacity" },
  });
}

/** Tier-2 graph (live dynamicParameter → baseColor) with blend Opaque. */
function opaqueBlendMaterialGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "three-opaque-blend-material",
    name: "Three Opaque Blend",
    blend: "opaque",
    nodes: [matNode("dyn", "dynamicParameter")],
    edges: [matEdge("e-base", "dyn", "out", "baseColor")],
    outputs: { baseColor: "e-base" },
  });
}

/** Tier-2 graph (live dynamicParameter → baseColor) with blend Masked. */
function maskedBlendMaterialGraph(): ShaderGraph {
  return normalizeShaderGraph({
    id: "three-masked-blend-material",
    name: "Three Masked Blend",
    blend: "masked",
    nodes: [matNode("dyn", "dynamicParameter")],
    edges: [matEdge("e-base", "dyn", "out", "baseColor")],
    outputs: { baseColor: "e-base" },
  });
}

function renderShaderMaterialAtAlpha(
  graph: ShaderGraph,
  alpha: number,
): ShaderMaterial {
  const material = createMaterialInstance(graph, `inst-${graph.id}`);
  const renderer = new ThreeVfxRenderer({
    scene: new Scene(),
    camera: createCamera(),
    materialGraphProvider: (shaderId) =>
      shaderId === graph.id ? graph : undefined,
  });
  const instance = renderer.createEffect(
    normalizeParticleEffect({
      id: `alpha-gate-${graph.id}`,
      targetProfile: "three-world-3d",
      emitters: [
        {
          id: "alpha-gate-emitter",
          ...singleBurstEmitter({ color: [1, 1, 1, alpha] }),
          modules: { color: false },
          render: { material, depthWrite: true },
        },
      ],
    }),
  );

  renderer.update(1 / 60);
  const rendered = firstParticleAnyMaterial(instance);
  expect(rendered).toBeInstanceOf(ShaderMaterial);
  return rendered as ShaderMaterial;
}

function dynamicParameterOpacityGraph(sourceHandle: string): ShaderGraph {
  return normalizeShaderGraph({
    id: `three-dynamic-parameter-${sourceHandle}`,
    name: "Three Dynamic Parameter",
    blend: "normal",
    nodes: [matNode("dyn", "dynamicParameter")],
    edges: [matEdge("e-opacity", "dyn", "out", "opacity", sourceHandle)],
    outputs: { opacity: "e-opacity" },
  });
}

function particleUniform(material: ShaderMaterial): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  const color = material.uniforms.uParticleColor?.value as
    { x: number; y: number; z: number; w: number } | undefined;
  if (!color) throw new Error("Expected a particle color uniform.");
  return { x: color.x, y: color.y, z: color.z, w: color.w };
}

function dynamicUniform(material: ShaderMaterial): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  const value = material.uniforms.uDynamicParams?.value as
    { x: number; y: number; z: number; w: number } | undefined;
  if (!value) throw new Error("Expected a dynamic parameter uniform.");
  return { x: value.x, y: value.y, z: value.z, w: value.w };
}

function subUvUniform(material: ShaderMaterial): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  const value = material.uniforms.uSubUv?.value as
    { x: number; y: number; z: number; w: number } | undefined;
  if (!value) throw new Error("Expected a sub-UV uniform.");
  return { x: value.x, y: value.y, z: value.z, w: value.w };
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
