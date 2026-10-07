import type { Object3D, Texture } from "three";
import { BillboardBatchRun } from "./billboardBatchRun";
import {
  isBillboardBatchSource,
  type BillboardBatchSource,
} from "./billboardBatchSources";

export interface ThreeVfxBatcherOptions {
  /** Host-owned parent for derived render meshes. Must have an invertible transform. */
  parent: Object3D;
  /** Sampler budget; clamp to the host renderer's available fragment texture units. */
  maxTextures?: number;
}
export interface ThreeVfxBillboardBatch {
  mesh: BillboardBatchSource;
  /** Host must give mesh this source's final transparent sort position. */
  firstSource: Object3D;
  sourceDrawCalls: number;
}
export interface ThreeVfxBatcherStats {
  sourceDrawCalls: number;
  drawCalls: number;
  savedDrawCalls: number;
  particles: number;
}

/**
 * Combines adjacent runtime billboard draws without changing emission/simulation.
 * Call beginFrame BEFORE updates/visibility edits and prepare AFTER final culling
 * and transparent sorting. Every intervening non-billboard object is a barrier.
 * Apply each output's firstSource sort key before rendering the scene once.
 */
export class ThreeVfxBatcher {
  readonly stats: ThreeVfxBatcherStats = {
    sourceDrawCalls: 0,
    drawCalls: 0,
    savedDrawCalls: 0,
    particles: 0,
  };
  private readonly textureLimit: number;
  private readonly pool: {
    run: BillboardBatchRun;
    result: ThreeVfxBillboardBatch;
  }[] = [];
  private readonly results: ThreeVfxBillboardBatch[] = [];
  private readonly hidden: BillboardBatchSource[] = [];
  private readonly pending: BillboardBatchSource[] = [];
  private readonly textures: Texture[] = [];
  private readonly seen = new Set<Object3D>();
  private key = "";
  private prepared = false;
  private destroyed = false;
  constructor(private readonly options: ThreeVfxBatcherOptions) {
    this.textureLimit = options.maxTextures ?? 4;
    if (
      !Number.isInteger(this.textureLimit) ||
      this.textureLimit < 1 ||
      this.textureLimit > 8
    )
      throw new Error("maxTextures must be an integer from 1 to 8");
  }
  /** Restore source visibility before the host updates or builds its render list. */
  beginFrame(): void {
    if (this.destroyed) throw new Error("ThreeVfxBatcher is destroyed");
    for (const source of this.hidden) source.visible = true;
    this.hidden.length = 0;
    for (const { run } of this.pool) run.mesh.visible = false;
    this.results.length = 0;
    this.pending.length = 0;
    this.textures.length = 0;
    this.seen.clear();
    this.prepared = false;
    Object.assign(this.stats, {
      sourceDrawCalls: 0,
      drawCalls: 0,
      savedDrawCalls: 0,
      particles: 0,
    });
  }
  prepare(
    orderedVisibleObjects: readonly Object3D[],
  ): readonly ThreeVfxBillboardBatch[] {
    if (this.destroyed) throw new Error("ThreeVfxBatcher is destroyed");
    if (this.prepared)
      throw new Error("Call beginFrame before preparing another view/frame");
    this.prepared = true;
    for (const object of orderedVisibleObjects) {
      if (!isBillboardBatchSource(object)) {
        this.flush();
        continue;
      }
      if (this.seen.has(object))
        throw new Error("Duplicate billboard in ordered render list");
      this.seen.add(object);
      if (!shown(object) || object.count === 0 || !object.material.visible)
        continue;
      this.stats.sourceDrawCalls++;
      this.stats.drawCalls++;
      this.stats.particles += object.count;
      const texture = object.material.uniforms.uTexture?.value as
        Texture | undefined;
      if (!texture?.isTexture) {
        this.flush();
        continue;
      }
      const key = compatibilityKey(object);
      if (
        this.pending.length &&
        (key !== this.key ||
          (!this.textures.includes(texture) &&
            this.textures.length === this.textureLimit))
      )
        this.flush();
      this.key = key;
      if (!this.textures.includes(texture)) this.textures.push(texture);
      this.pending.push(object);
    }
    this.flush();
    return this.results;
  }
  private flush(): void {
    if (this.pending.length > 1) {
      const first = this.pending[0]!;
      const count = this.pending.reduce((sum, source) => sum + source.count, 0);
      const index = this.results.length;
      let entry = this.pool[index];
      if (!entry || entry.run.key !== this.key || entry.run.capacity < count) {
        entry?.run.dispose();
        const capacity = 2 ** Math.ceil(Math.log2(Math.max(1, count)));
        const run = new BillboardBatchRun(
          first,
          this.key,
          capacity,
          this.textureLimit,
          this.options.parent,
        );
        entry = {
          run,
          result: { mesh: run.mesh, firstSource: first, sourceDrawCalls: 0 },
        };
        this.pool[index] = entry;
      }
      entry.run.write(this.pending, this.textures);
      entry.result.firstSource = first;
      entry.result.sourceDrawCalls = this.pending.length;
      this.results.push(entry.result);
      for (const source of this.pending) {
        source.visible = false;
        this.hidden.push(source);
      }
      this.stats.savedDrawCalls += this.pending.length - 1;
      this.stats.drawCalls -= this.pending.length - 1;
    }
    this.pending.length = 0;
    this.textures.length = 0;
  }
  /** Restores original meshes; releases only owned buffers/materials, never textures. */
  dispose(): void {
    if (this.destroyed) return;
    this.beginFrame();
    for (const { run } of this.pool) run.dispose();
    this.pool.length = 0;
    this.destroyed = true;
  }
}
function shown(object: Object3D): boolean {
  for (let parent: Object3D | null = object; parent; parent = parent.parent)
    if (!parent.visible) return false;
  return true;
}
const uniformIds = new WeakMap<object, number>();
let nextUniformId = 0;
function uniformId(uniform: object): number {
  let id = uniformIds.get(uniform);
  if (id === undefined) {
    id = ++nextUniformId;
    uniformIds.set(uniform, id);
  }
  return id;
}
function compatibilityKey(source: BillboardBatchSource): string {
  const m = source.material;
  let groupOrder = 0;
  for (let p = source.parent; p; p = p.parent)
    if ("isGroup" in p && p.isGroup) {
      groupOrder = p.renderOrder;
      break;
    }
  return JSON.stringify([
    Object.entries(m.uniforms)
      .filter(([name]) => name !== "uTexture")
      .map(([name, uniform]) => [name, uniformId(uniform)]),
    m.vertexShader,
    m.fragmentShader,
    m.defines,
    m.customProgramCacheKey(),
    m.glslVersion,
    m.precision,
    m.blending,
    m.blendSrc,
    m.blendDst,
    m.blendEquation,
    m.blendSrcAlpha,
    m.blendDstAlpha,
    m.blendEquationAlpha,
    m.blendColor,
    m.blendAlpha,
    m.transparent,
    m.depthTest,
    m.depthWrite,
    m.depthFunc,
    m.side,
    m.forceSinglePass,
    m.premultipliedAlpha,
    m.colorWrite,
    m.stencilWrite,
    m.stencilFunc,
    m.stencilRef,
    m.stencilWriteMask,
    m.stencilFuncMask,
    m.stencilFail,
    m.stencilZFail,
    m.stencilZPass,
    m.polygonOffset,
    m.polygonOffsetFactor,
    m.polygonOffsetUnits,
    m.alphaTest,
    m.alphaHash,
    m.alphaToCoverage,
    m.toneMapped,
    m.clippingPlanes,
    m.clipIntersection,
    m.fog,
    m.clipping,
    m.clipShadows,
    source.geometry.drawRange,
    m.wireframe,
    source.renderOrder,
    source.layers.mask,
    groupOrder,
    Array.from(source.geometry.getAttribute("position").array),
    Array.from(source.geometry.getAttribute("uv").array),
    source.geometry.index ? Array.from(source.geometry.index.array) : null,
  ]);
}
