import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  type Object3D,
  type Texture,
} from "three";
import type { BillboardBatchSource } from "./billboardBatchSources";

/** Retained GPU storage for one consecutive compatible run. */
export class BillboardBatchRun {
  readonly mesh: BillboardBatchSource;
  private readonly matrix = new Matrix4();
  private readonly transform = new Matrix4();
  private readonly inverseParent = new Matrix4();
  constructor(
    source: BillboardBatchSource,
    readonly key: string,
    readonly capacity: number,
    private readonly textureLimit: number,
    parent: Object3D,
  ) {
    const geometry = source.geometry.clone();
    for (const [name, size] of [
      ["aInstanceColor", 3],
      ["aInstanceAlpha", 1],
      ["aNixieTexture", 1],
    ] as const) {
      geometry.setAttribute(
        name,
        new InstancedBufferAttribute(
          new Float32Array(capacity * size),
          size,
        ).setUsage(DynamicDrawUsage),
      );
    }
    const original = source.material;
    const material = original.clone();
    material.onBeforeCompile = original.onBeforeCompile;
    material.customProgramCacheKey = () => key + "-nixie-batch-" + textureLimit;
    delete material.uniforms.uTexture;
    // Extra host uniforms may batch only when they share the same live binding.
    for (const [name, uniform] of Object.entries(original.uniforms)) {
      if (name !== "uTexture") material.uniforms[name] = uniform;
    }
    for (let i = 0; i < textureLimit; i++)
      material.uniforms["uNixieTexture" + i] = { value: null };
    material.vertexShader =
      "attribute float aNixieTexture;\nvarying float vNixieTexture;\n" +
      material.vertexShader.replace(
        "vUv = uv;",
        "vUv = uv; vNixieTexture = aNixieTexture;",
      );
    const declarations = Array.from(
      { length: textureLimit },
      (_, i) => `uniform sampler2D uNixieTexture${i};`,
    ).join("\n");
    // Constant sampler names also work on hosts without sampler-array indexing.
    // Existing textures retain their own resolution, filtering and color space.
    const samples = Array.from(
      { length: textureLimit - 1 },
      (_, i) =>
        `if(vNixieTexture < ${i + 0.5}) return textureGrad(uNixieTexture${i}, uv, dx, dy);`,
    ).join("\n");
    material.fragmentShader = material.fragmentShader
      .replace(
        "uniform sampler2D uTexture;",
        `${declarations}\nvarying float vNixieTexture;\nvec4 sampleNixieBatch(vec2 uv){vec2 dx=dFdx(uv),dy=dFdy(uv);${samples}\nreturn textureGrad(uNixieTexture${textureLimit - 1}, uv, dx, dy);}`,
      )
      .replace("texture2D(uTexture, vUv)", "sampleNixieBatch(vUv)");
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.name = "NixieFX billboard batch";
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false; // Caller already culled the ordered source list.
    this.mesh.visible = false;
    parent.add(this.mesh);
  }
  write(
    sources: readonly BillboardBatchSource[],
    textures: readonly Texture[],
  ): void {
    const mesh = this.mesh;
    mesh.parent!.updateWorldMatrix(true, false);
    this.inverseParent.copy(mesh.parent!.matrixWorld).invert();
    const colors = mesh.geometry.getAttribute(
      "aInstanceColor",
    ) as InstancedBufferAttribute;
    const alphas = mesh.geometry.getAttribute(
      "aInstanceAlpha",
    ) as InstancedBufferAttribute;
    const indices = mesh.geometry.getAttribute(
      "aNixieTexture",
    ) as InstancedBufferAttribute;
    let count = 0;
    for (const source of sources) {
      source.updateWorldMatrix(true, false);
      this.transform.multiplyMatrices(this.inverseParent, source.matrixWorld);
      const color = source.geometry.getAttribute("aInstanceColor");
      const alpha = source.geometry.getAttribute("aInstanceAlpha");
      const textureIndex = textures.indexOf(
        source.material.uniforms.uTexture!.value as Texture,
      );
      // Preserve emitter order AND each emitter's already-sorted particle order.
      for (let i = 0; i < source.count; i++, count++) {
        source.getMatrixAt(i, this.matrix);
        this.matrix.premultiply(this.transform);
        mesh.setMatrixAt(count, this.matrix);
        colors.setXYZ(count, color.getX(i), color.getY(i), color.getZ(i));
        alphas.setX(count, alpha.getX(i));
        indices.setX(count, textureIndex);
      }
    }
    for (let i = 0; i < this.textureLimit; i++)
      mesh.material.uniforms["uNixieTexture" + i]!.value =
        textures[i] ?? textures[0];
    mesh.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
    alphas.needsUpdate = true;
    indices.needsUpdate = true;
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.renderOrder = sources[0]!.renderOrder;
    mesh.layers.mask = sources[0]!.layers.mask;
    mesh.computeBoundingSphere();
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
