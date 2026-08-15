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
  return Boolean(
    texture &&
    emitter.mode === "billboard" &&
    emitter.render.shading === "unlit" &&
    emitter.render.texture &&
    !emitter.render.material &&
    !emitter.modules.trails &&
    !emitter.modules.textureSheetAnimation &&
    emitter.render.opacitySource === "textureAlpha" &&
    !emitter.render.opacityInvert &&
    // Premultiplied is intentionally excluded: this fast path emits straight
    // color with `discard(alpha <= 0.001)`, which would kill exactly the
    // low-alpha glow texels premultiplied is for. It auto-falls back to the
    // per-particle mesh path (I13-A D6) — do not add it here.
    (emitter.render.blend === "alpha" || emitter.render.blend === "additive") &&
    (emitter.render.sortMode === "none" ||
      emitter.render.sortMode === "oldestFirst"),
  );
}

/** Retained one-draw renderer for the texture-only billboard runtime subset. */
export class ThreeInstancedBillboardView {
  readonly mesh: InstancedMesh<BufferGeometry, ShaderMaterial>;

  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly colors: Float32Array;
  private readonly alphas: Float32Array;
  private readonly colorAttribute: InstancedBufferAttribute;
  private readonly alphaAttribute: InstancedBufferAttribute;

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
    this.colorAttribute = new InstancedBufferAttribute(this.colors, 3);
    this.alphaAttribute = new InstancedBufferAttribute(this.alphas, 1);
    this.colorAttribute.setUsage(DynamicDrawUsage);
    this.alphaAttribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("aInstanceColor", this.colorAttribute);
    this.geometry.setAttribute("aInstanceAlpha", this.alphaAttribute);
    this.material = new ShaderMaterial({
      vertexShader: INSTANCED_VERTEX_SHADER,
      fragmentShader: INSTANCED_FRAGMENT_SHADER,
      uniforms: { uTexture: { value: texture } },
      transparent: true,
      depthTest: emitter.render.depthTest,
      depthWrite: resolveParticleDepthWrite(emitter.render),
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
    this.material.depthWrite = resolveParticleDepthWrite(emitter.render);
    this.material.blending =
      emitter.render.blend === "additive" ? AdditiveBlending : NormalBlending;
  }

  write(index: number, matrix: Matrix4, color: Color, alpha: number): void {
    this.mesh.setMatrixAt(index, matrix);
    const colorOffset = index * 3;
    this.colors[colorOffset + 0] = color.r;
    this.colors[colorOffset + 1] = color.g;
    this.colors[colorOffset + 2] = color.b;
    this.alphas[index] = alpha;
  }

  commit(count: number): void {
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    if (count <= 0) return;
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
