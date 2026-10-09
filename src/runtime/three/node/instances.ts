import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  type BufferGeometry,
  type Color,
  type Matrix4,
} from "three";
import {
  resolveParticleDepthWrite,
  type ParticleEmitterDefinition,
} from "../../../engine/particles";
import type { ThreeEmitterMaterialResolution } from "../materialAdapter";
import type { ThreeVfxInstancedView } from "../renderAdapter";
import type { ParticleSample } from "../rendererState";
import {
  materialBlendOverridesEmitter,
  resolveEffectiveParticleBlend,
} from "../../schema/materials";
import { sampleEmitterDynamicParams } from "../particleMaterialSample";

/** CPU-prepared matrices and authored inputs, one retained draw per emitter. */
export class ThreeNodeInstances implements ThreeVfxInstancedView {
  readonly mesh: InstancedMesh;
  private readonly attributes: Record<string, InstancedBufferAttribute>;
  private readonly distances: Float32Array;
  private readonly order: Uint32Array;
  private readonly scratch: Float32Array;
  private allOpaque = true;
  private depthAuthored = false;
  constructor(
    geometry: BufferGeometry,
    private readonly resolution: ThreeEmitterMaterialResolution,
    private readonly emitter: ParticleEmitterDefinition,
  ) {
    const capacity = Math.max(1, Math.floor(emitter.maxParticles));
    const owned = geometry.clone();
    this.attributes = {
      nfxEmissive: new InstancedBufferAttribute(new Float32Array(capacity), 1),
      nfxColor: new InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
      nfxDynamic: new InstancedBufferAttribute(
        new Float32Array(capacity * 4),
        4,
      ),
      nfxSubUv: new InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
    };
    for (const [name, attr] of Object.entries(this.attributes)) {
      attr.setUsage(DynamicDrawUsage);
      owned.setAttribute(name, attr);
    }
    this.mesh = new InstancedMesh(owned, resolution.material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.distances = new Float32Array(capacity);
    this.order = new Uint32Array(capacity);
    this.scratch = new Float32Array(capacity * 16);
  }
  setRenderState(emitter: ParticleEmitterDefinition): void {
    this.allOpaque = true;
    this.depthAuthored = resolveParticleDepthWrite(emitter.render);
  }
  updateTime(time: number): void {
    this.resolution.updateTime?.(time);
  }
  write(
    index: number,
    matrix: Matrix4,
    color: Color,
    alpha: number,
    distance = 0,
    sample?: ParticleSample,
  ): void {
    this.allOpaque &&= alpha >= 0.999;
    this.mesh.setMatrixAt(index, matrix);
    this.distances[index] = distance;
    this.attributes.nfxEmissive!.setX(index, sample?.emissiveStrength ?? 1);
    const rgb = sample?.shaderColor;
    this.attributes.nfxColor!.setXYZW(
      index,
      rgb?.[0] ?? color.r,
      rgb?.[1] ?? color.g,
      rgb?.[2] ?? color.b,
      alpha,
    );
    const dynamic = sample
      ? sampleEmitterDynamicParams(this.emitter, sample)
      : [0, 0, 0, 0];
    this.attributes.nfxDynamic!.setXYZW(
      index,
      dynamic[0]!,
      dynamic[1]!,
      dynamic[2]!,
      dynamic[3]!,
    );
    const tiles = this.emitter.modules.textureSheetAnimation
      ? this.emitter.advanced.textureSheetAnimation.tiles
      : [1, 1];
    const x = Math.max(1, Math.round(tiles[0]!)),
      y = Math.max(1, Math.round(tiles[1]!)),
      frame = sample?.textureFrameIndex ?? 0;
    this.attributes.nfxSubUv!.setXYZW(
      index,
      (frame % x) / x,
      (y - 1 - (Math.floor(frame / x) % y)) / y,
      1 / x,
      1 / y,
    );
  }
  sortByCameraDistance(count: number, farFirst: boolean): void {
    for (let i = 0; i < count; i++) this.order[i] = i;
    const order = this.order.subarray(0, count);
    order.sort(
      (a, b) => (farFirst ? -1 : 1) * (this.distances[a]! - this.distances[b]!),
    );
    for (const attr of [
      this.mesh.instanceMatrix,
      ...Object.values(this.attributes),
    ]) {
      const size = attr.itemSize,
        values = attr.array;
      this.scratch.set(values.subarray(0, count * size));
      for (let i = 0; i < count; i++)
        for (let k = 0; k < size; k++)
          values[i * size + k] = this.scratch[order[i]! * size + k]!;
    }
  }
  commit(count: number): void {
    const ownsBlend = materialBlendOverridesEmitter(
      resolveEffectiveParticleBlend(
        this.emitter.render.blend,
        this.resolution.materialBlend,
      ),
    );
    this.resolution.material.depthWrite =
      ownsBlend ||
      (this.depthAuthored &&
        this.allOpaque &&
        this.resolution.opacityIsConstantOne);
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    if (count) {
      this.mesh.instanceMatrix.needsUpdate = true;
      for (const attr of Object.values(this.attributes))
        attr.needsUpdate = true;
    }
  }
  setRenderOrder(order: number): void {
    this.mesh.renderOrder = order;
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose(); /* material is owned by the shared emitter view */
  }
}
