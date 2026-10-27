import {
  Color,
  DepthTexture,
  Material,
  Mesh,
  PerspectiveCamera,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { ParticleSoftParticlesSettings } from "../../engine/particles";

type HostRenderer = WebGLRenderer | WebGPURenderer;

/** Optional host-owned depth resource. No renderer or frame loop is created. */
export class ThreeSoftParticleDepth {
  readonly texture: DepthTexture;
  readonly uniforms = {
    nfxSceneDepth: { value: null as DepthTexture | null },
    nfxDepthReady: { value: 0 },
    nfxDepthCamera: { value: new Vector4(0.1, 1000, 1, 0) },
    nfxDepthViewport: { value: new Vector4(0, 0, 1, 1) },
  };
  readonly stats = { passes: 0, captures: 0, activeMeshes: 0 };
  private target?: WebGLRenderTarget;
  private readonly consumers = new Map<Mesh, () => void>();
  private readonly excluded = new Set<Object3D>();
  private readonly size = new Vector2();
  private readonly viewport = new Vector4();
  private readonly clearColor = new Color();
  private disposed = false;

  /** Supplied depth is borrowed, conventional [0,1], opaque-only, same camera/viewport. */
  constructor(private readonly externalDepth?: DepthTexture) {
    this.texture = externalDepth ?? new DepthTexture(1, 1, UnsignedIntType);
    this.uniforms.nfxSceneDepth.value = this.texture;
  }
  exclude(root: Object3D): void {
    this.excluded.add(root);
  }
  include(root: Object3D): void {
    this.excluded.delete(root);
  }

  /** Register runtime-owned particle draws; registration ends when their material is disposed. */
  track(mesh: Mesh): void {
    if (this.consumers.has(mesh)) return;
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    const release = () => {
      this.consumers.delete(mesh);
      for (const material of materials)
        material.removeEventListener("dispose", release);
    };
    this.consumers.set(mesh, release);
    for (const material of materials)
      material.addEventListener("dispose", release);
  }

  /** Call after VFX update and immediately before the host's final scene render. */
  prepare(renderer: HostRenderer, scene: Scene, camera: Camera): void {
    this.stats.passes = 0;
    this.stats.activeMeshes = 0;
    this.uniforms.nfxDepthReady.value = 0;
    if (this.disposed || !this.consumers.size) return;
    for (const mesh of this.consumers.keys()) {
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      if (!materials.some((material) => material.visible)) continue;
      if (!camera.layers.test(mesh.layers)) continue;
      if ("count" in mesh && mesh.count === 0) continue;
      let object: Object3D | null = mesh;
      while (object && object !== scene && object.visible)
        object = object.parent;
      if (object === scene && scene.visible) this.stats.activeMeshes++;
    }
    if (!this.stats.activeMeshes) return;
    const projection = camera as Camera & { near: number; far: number };
    this.uniforms.nfxDepthCamera.value.set(
      projection.near,
      projection.far,
      camera instanceof PerspectiveCamera ? 1 : 0,
      0,
    );
    const savedTarget = renderer.getRenderTarget();
    if (savedTarget) this.viewport.copy(savedTarget.viewport);
    else renderer.getViewport(this.viewport);
    const ratio = savedTarget ? 1 : renderer.getPixelRatio();
    this.uniforms.nfxDepthViewport.value
      .copy(this.viewport)
      .multiplyScalar(ratio);
    this.size.set(
      this.uniforms.nfxDepthViewport.value.z,
      this.uniforms.nfxDepthViewport.value.w,
    );
    if (this.externalDepth) {
      this.uniforms.nfxDepthReady.value = 1;
      return;
    }
    if (!this.target) {
      this.target = new WebGLRenderTarget(this.size.x, this.size.y, {
        depthTexture: this.texture,
      });
    }
    this.target.setSize(this.size.x, this.size.y);
    this.target.viewport.set(0, 0, this.size.x, this.size.y);
    // Preserve real material depth (cutouts, displacement, skinning). Opaque
    // scene geometry only; never let VFX, grids or transparent objects self-fade.
    const hidden: Object3D[] = [];
    const hiddenMaterials = new Set<Material>();
    for (const root of this.excluded)
      if (root.visible) {
        hidden.push(root);
        root.visible = false;
      }
    scene.traverseVisible((object) => {
      if (!(object instanceof Mesh)) {
        if ("material" in object) {
          hidden.push(object);
          object.visible = false;
        }
        return;
      }
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        if (
          material.visible &&
          (material.transparent || !material.depthWrite)
        ) {
          hiddenMaterials.add(material);
          material.visible = false;
        }
      }
    });
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const clearAlpha = renderer.getClearAlpha();
    (renderer as WebGLRenderer).getClearColor(this.clearColor);
    const shadows = renderer.shadowMap;
    const shadowAutoUpdate =
      "autoUpdate" in shadows ? shadows.autoUpdate : undefined;
    try {
      scene.background = null;
      renderer.autoClear = true;
      if ("autoUpdate" in shadows) shadows.autoUpdate = false;
      renderer.setClearColor(0, 0);
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(scene, camera);
      this.stats.passes = 1;
      this.stats.captures++;
      this.uniforms.nfxDepthReady.value = 1;
    } finally {
      (renderer as WebGLRenderer).setRenderTarget(
        savedTarget as WebGLRenderTarget | null,
      );
      renderer.setClearColor(this.clearColor, clearAlpha);
      renderer.autoClear = autoClear;
      if ("autoUpdate" in shadows && shadowAutoUpdate !== undefined)
        shadows.autoUpdate = shadowAutoUpdate;
      scene.background = background;
      for (const material of hiddenMaterials) material.visible = true;
      for (const object of hidden) object.visible = true;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.uniforms.nfxDepthReady.value = 0;
    for (const release of this.consumers.values()) release();
    this.excluded.clear();
    this.target?.dispose();
    if (!this.target && !this.externalDepth) this.texture.dispose();
  }
}

const GLSL_DEPTH = `
uniform sampler2D nfxSceneDepth;
uniform float nfxDepthReady;
uniform vec4 nfxDepthCamera;
uniform vec4 nfxDepthViewport;
uniform vec2 nfxSoftRange;
float nfxLinearDepth(float d) {
  float n = nfxDepthCamera.x, f = nfxDepthCamera.y;
  return nfxDepthCamera.z > 0.5 ? n*f/(f-d*(f-n)) : n+d*(f-n);
}
float nfxSoftFade() {
  if (nfxDepthReady < 0.5) return 1.0;
  vec2 uv = (gl_FragCoord.xy - nfxDepthViewport.xy) / nfxDepthViewport.zw;
  float d = texture2D(nfxSceneDepth, uv).x;
  if (d >= 1.0) return 1.0;
  float gap = nfxLinearDepth(d) - nfxLinearDepth(gl_FragCoord.z);
  return clamp((gap - nfxSoftRange.x) / (nfxSoftRange.y - nfxSoftRange.x), 0.0, 1.0);
}
`;

/** Applied after the existing graph/color output, without reapplying authored alpha. */
export function applyThreeSoftParticleMaterial(
  material: Material,
  depth: ThreeSoftParticleDepth,
  settings: ParticleSoftParticlesSettings,
): void {
  material.userData.nixieSoftParticles = true;
  const uniforms = {
    ...depth.uniforms,
    nfxSoftRange: { value: new Vector2(settings.near, settings.far) },
  };
  const fade = `\nfloat nfxFade = nfxSoftFade();\ngl_FragColor.a *= nfxFade;\n${material.premultipliedAlpha ? "gl_FragColor.rgb *= nfxFade;" : ""}\n`;
  const patch = (source: string) =>
    GLSL_DEPTH + source.replace(/}\s*$/, fade + "}\n");
  if (material instanceof ShaderMaterial) {
    Object.assign(material.uniforms, uniforms);
    material.fragmentShader = patch(material.fragmentShader);
  } else {
    const original = material.onBeforeCompile;
    const key = material.customProgramCacheKey();
    material.onBeforeCompile = function (shader, renderer) {
      original.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = patch(shader.fragmentShader);
    };
    material.customProgramCacheKey = () =>
      `${key}:nfx-soft:${material.premultipliedAlpha}`;
  }
  material.transparent = true;
  material.depthWrite = false;
  material.needsUpdate = true;
}
