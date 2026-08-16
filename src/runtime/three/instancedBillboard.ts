import {
  AdditiveBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  NormalBlending,
  ShaderMaterial,
  type BufferGeometry,
  type Color,
  type Matrix4,
  type Texture,
} from "three";
import { resolveParticleDepthWrite } from "../../engine/particles";
import type { ParticleEmitterDefinition } from "../../engine/particles";

const INSTANCED_VERTEX_SHADER = `
attribute vec3 aInstanceColor;
attribute float aInstanceAlpha;

varying vec2 vUv;
varying vec4 vInstanceColor;

void main() {
  vUv = uv;
  vInstanceColor = vec4(aInstanceColor, aInstanceAlpha);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const INSTANCED_FRAGMENT_SHADER = `
uniform sampler2D uTexture;

varying vec2 vUv;
varying vec4 vInstanceColor;

void main() {
  vec4 sampled = texture2D(uTexture, vUv);
  vec4 color = sampled * vInstanceColor;
  if (color.a <= 0.001) discard;
  gl_FragColor = color;
  #include <colorspace_fragment>
}
`;

export function canUseInstancedBillboard(
  emitter: ParticleEmitterDefinition,
  texture: Texture | null,
): boolean {
  // `texture` may be a provider texture OR the shared procedural billboard
  // shape texture (F12) — assetless billboards instance too. Every sort mode
  // is supported: age orders pre-sort the instance write order and distance
  // orders re-sort the written instances against the camera each frame (F13).
  return Boolean(
    texture &&
    emitter.mode === "billboard" &&
    emitter.render.shading === "unlit" &&
    !emitter.render.material &&
    !emitter.modules.trails &&
    !emitter.modules.textureSheetAnimation &&
    emitter.render.opacitySource === "textureAlpha" &&
    !emitter.render.opacityInvert &&
    // Premultiplied is intentionally excluded: this fast path emits straight
    // color with `discard(alpha <= 0.001)`, which would kill exactly the
    // low-alpha glow texels premultiplied is for. It auto-falls back to the
    // per-particle mesh path (I13-A D6) — do not add it here.
    (emitter.render.blend === "alpha" || emitter.render.blend === "additive"),
  );
}

/** Retained one-draw renderer for the texture-only billboard runtime subset. */
export class ThreeInstancedBillboardView {
  readonly mesh: InstancedMesh<BufferGeometry, ShaderMaterial>;

  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly colors: Float32Array;
  private readonly alphas: Float32Array;
  private readonly depths: Float32Array;
  private readonly colorAttribute: InstancedBufferAttribute;
  private readonly alphaAttribute: InstancedBufferAttribute;
  /** Lazy scratch for camera-distance re-sorts (distance sort modes only). */
  private sortScratch: {
    order: Uint32Array;
    matrices: Float32Array;
    colors: Float32Array;
    alphas: Float32Array;
  } | null = null;
  /** Authored depth-write resolution; gated per commit by instance alphas. */
  private depthWriteAuthored: boolean;

  constructor(
    sourceGeometry: BufferGeometry,
    texture: Texture,
    capacity: number,
    emitter: ParticleEmitterDefinition,
  ) {
    const safeCapacity = Math.max(1, Math.floor(capacity));
    this.geometry = sourceGeometry.clone();
    this.colors = new Float32Array(safeCapacity * 3);
    this.alphas = new Float32Array(safeCapacity);
    this.depths = new Float32Array(safeCapacity);
    this.colorAttribute = new InstancedBufferAttribute(this.colors, 3);
    this.alphaAttribute = new InstancedBufferAttribute(this.alphas, 1);
    this.colorAttribute.setUsage(DynamicDrawUsage);
    this.alphaAttribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("aInstanceColor", this.colorAttribute);
    this.geometry.setAttribute("aInstanceAlpha", this.alphaAttribute);
    this.depthWriteAuthored = resolveParticleDepthWrite(emitter.render);
    this.material = new ShaderMaterial({
      vertexShader: INSTANCED_VERTEX_SHADER,
      fragmentShader: INSTANCED_FRAGMENT_SHADER,
      uniforms: { uTexture: { value: texture } },
      transparent: true,
      depthTest: emitter.render.depthTest,
      depthWrite: this.depthWriteAuthored,
      blending:
        emitter.render.blend === "additive" ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
    });
    this.mesh = new InstancedMesh(this.geometry, this.material, safeCapacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  setRenderState(emitter: ParticleEmitterDefinition): void {
    this.material.depthTest = emitter.render.depthTest;
    this.depthWriteAuthored = resolveParticleDepthWrite(emitter.render);
    this.material.depthWrite = this.depthWriteAuthored;
    this.material.blending =
      emitter.render.blend === "additive" ? AdditiveBlending : NormalBlending;
  }

  write(
    index: number,
    matrix: Matrix4,
    color: Color,
    alpha: number,
    cameraDistanceSquared = 0,
  ): void {
    this.mesh.setMatrixAt(index, matrix);
    const colorOffset = index * 3;
    this.colors[colorOffset + 0] = color.r;
    this.colors[colorOffset + 1] = color.g;
    this.colors[colorOffset + 2] = color.b;
    this.alphas[index] = alpha;
    this.depths[index] = cameraDistanceSquared;
  }

  /**
   * Re-orders the first `count` written instances by their recorded camera
   * distance so blending inside the single instanced draw resolves in
   * painter's order (`farFirst` = far-to-near, the translucent default).
   * Call after the per-frame `write` pass and before `commit`.
   */
  sortByCameraDistance(count: number, farFirst: boolean): void {
    if (count <= 1) return;
    const scratch = this.ensureSortScratch();
    const order = scratch.order;
    for (let i = 0; i < count; i++) order[i] = i;
    const depths = this.depths;
    order
      .subarray(0, count)
      .sort(
        farFirst
          ? (a, b) => (depths[b] ?? 0) - (depths[a] ?? 0)
          : (a, b) => (depths[a] ?? 0) - (depths[b] ?? 0),
      );
    let identity = true;
    for (let i = 0; i < count; i++) {
      if (order[i] !== i) {
        identity = false;
        break;
      }
    }
    if (identity) return;
    const matrixArray = this.mesh.instanceMatrix.array as Float32Array;
    scratch.matrices.set(matrixArray.subarray(0, count * 16));
    scratch.colors.set(this.colors.subarray(0, count * 3));
    scratch.alphas.set(this.alphas.subarray(0, count));
    for (let i = 0; i < count; i++) {
      const source = order[i] ?? i;
      const sourceMatrix = source * 16;
      const targetMatrix = i * 16;
      for (let k = 0; k < 16; k++) {
        matrixArray[targetMatrix + k] = scratch.matrices[sourceMatrix + k] ?? 0;
      }
      const sourceColor = source * 3;
      const targetColor = i * 3;
      this.colors[targetColor + 0] = scratch.colors[sourceColor + 0] ?? 0;
      this.colors[targetColor + 1] = scratch.colors[sourceColor + 1] ?? 0;
      this.colors[targetColor + 2] = scratch.colors[sourceColor + 2] ?? 0;
      this.alphas[i] = scratch.alphas[source] ?? 0;
    }
  }

  private ensureSortScratch(): NonNullable<
    ThreeInstancedBillboardView["sortScratch"]
  > {
    if (!this.sortScratch) {
      const capacity = this.alphas.length;
      this.sortScratch = {
        order: new Uint32Array(capacity),
        matrices: new Float32Array(capacity * 16),
        colors: new Float32Array(capacity * 3),
        alphas: new Float32Array(capacity),
      };
    }
    return this.sortScratch;
  }

  commit(count: number): void {
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    if (count <= 0) return;
    // One draw covers every instance, so the per-sample depth-write gate
    // (I12-A) applies at draw granularity: any translucent instance disables
    // depth writes for the whole batch.
    if (this.depthWriteAuthored) {
      let opaque = true;
      for (let i = 0; i < count; i++) {
        if ((this.alphas[i] ?? 0) < 0.999) {
          opaque = false;
          break;
        }
      }
      this.material.depthWrite = opaque;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    this.alphaAttribute.needsUpdate = true;
  }

  setRenderOrder(renderOrder: number): void {
    this.mesh.renderOrder = renderOrder;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
