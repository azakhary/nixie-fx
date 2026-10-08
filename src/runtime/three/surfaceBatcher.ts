import {
  Mesh,
  ShaderMaterial,
  DoubleSide,
  type Object3D,
  type Texture,
} from "three";
import { isBillboardBatchSource } from "./billboardBatchSources";
import { surfaceProgram, type SurfaceProgram } from "./surfaceBatchMaterial";
import {
  MAX_SURFACE_PARAMETER_ROWS,
  SurfaceBatchRun,
  type SurfaceEntry,
} from "./surfaceBatchRun";
export interface ThreeSurfaceBatch {
  mesh: Mesh;
  firstSource: Mesh;
  sourceDrawCalls: number;
}
export interface ThreeSurfaceBatcherOptions {
  parent: Object3D;
  /** Excludes one reserved data sampler. Clamp to host capabilities. */ maxTextures?: number;
}
/** Ordered triangle batching for unlit runtime graphs, stock sprites and history ribbons.
 * Supply the complete visible render order, including non-VFX barriers. No sorting
 * or simulation occurs here; emitted triangle order matches the original draws.
 */
export class ThreeSurfaceBatcher {
  readonly stats = {
    sourceDrawCalls: 0,
    drawCalls: 0,
    savedDrawCalls: 0,
    vertices: 0,
    fallbacks: 0,
    createdRuns: 0,
  };
  private readonly pool = new Map<
    string,
    { runs: SurfaceBatchRun[]; used: number }
  >();
  private readonly maxInactiveRuns = 32;
  private readonly resultCache = new WeakMap<
    SurfaceBatchRun,
    ThreeSurfaceBatch
  >();
  private readonly hidden: Mesh[] = [];
  private readonly pending: SurfaceEntry[] = [];
  private readonly entries = new WeakMap<Mesh, SurfaceEntry>();
  private readonly programs: SurfaceProgram[] = [];
  private readonly textures: Texture[] = [];
  private readonly results: ThreeSurfaceBatch[] = [];
  private readonly seen = new Set<Object3D>();
  private readonly canonical = new Map<string, SurfaceProgram>();
  private state = "";
  private pendingRows = 0;
  private prepared = false;
  private destroyed = false;
  private readonly textureLimit: number;
  constructor(private readonly options: ThreeSurfaceBatcherOptions) {
    this.textureLimit = options.maxTextures ?? 15;
    if (
      !Number.isInteger(this.textureLimit) ||
      this.textureLimit < 1 ||
      this.textureLimit > 31
    )
      throw Error("maxTextures must be 1–31");
  }
  beginFrame(): void {
    if (this.destroyed) throw Error("ThreeSurfaceBatcher is destroyed");
    for (const mesh of this.hidden) mesh.visible = true;
    this.hidden.length = 0;
    for (const bucket of this.pool.values()) {
      bucket.used = 0;
      for (const run of bucket.runs) run.mesh.visible = false;
    }
    this.pending.length =
      this.programs.length =
      this.textures.length =
      this.results.length =
        0;
    this.pendingRows = 0;
    this.seen.clear();
    this.prepared = false;
    Object.assign(this.stats, {
      sourceDrawCalls: 0,
      drawCalls: 0,
      savedDrawCalls: 0,
      vertices: 0,
      fallbacks: 0,
      createdRuns: 0,
    });
  }
  prepare(
    orderedVisibleObjects: readonly Object3D[],
  ): readonly ThreeSurfaceBatch[] {
    if (this.destroyed || this.prepared)
      throw Error("Call beginFrame before preparing a surface batch");
    this.prepared = true;
    for (const object of orderedVisibleObjects) {
      if (this.seen.has(object))
        throw Error("Duplicate object in ordered surface list");
      this.seen.add(object);
      if (!(object instanceof Mesh)) {
        this.flush();
        continue;
      }
      const geometry = object.geometry;
      const position = geometry.getAttribute("position");
      const count = isBillboardBatchSource(object) ? object.count : 1;
      if (!position || position.count === 0 || count === 0) continue;
      const first = geometry.drawRange.start;
      const last = Math.min(
        first + geometry.drawRange.count,
        geometry.index?.count ?? position.count,
      );
      if (last <= first) continue;
      if (count > MAX_SURFACE_PARAMETER_ROWS) {
        this.flush();
        this.stats.fallbacks++;
        continue;
      }
      const material = object.material;
      let program =
        !(object as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh &&
        !object.geometry.morphAttributes.position &&
        object.geometry.groups.length === 0 &&
        (!(object as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh ||
          isBillboardBatchSource(object))
          ? surfaceProgram(object)
          : null;
      if (!program || Array.isArray(material) || !material.visible) {
        this.flush();
        this.stats.fallbacks++;
        continue;
      }
      const canonical = this.canonical.get(program.key);
      if (canonical) program = canonical;
      else this.canonical.set(program.key, program);
      let shown = true;
      for (let parent: Object3D | null = object; parent; parent = parent.parent)
        if (!parent.visible) {
          shown = false;
          break;
        }
      if (!shown) continue;
      const key = [
        material.transparent,
        material.blending,
        material.blendSrc,
        material.blendDst,
        material.blendEquation,
        material.blendSrcAlpha,
        material.blendDstAlpha,
        material.blendEquationAlpha,
        material.premultipliedAlpha,
        material.depthTest,
        material.depthWrite,
        material.depthFunc,
        material.colorWrite,
        object.layers.mask,
      ].join(":");
      let added = 0;
      for (const t of program.textures) if (!this.textures.includes(t)) added++;
      if (
        this.pending.length &&
        (this.pendingRows + count > MAX_SURFACE_PARAMETER_ROWS ||
          this.state !== key ||
          this.textures.length + added > this.textureLimit ||
          (this.programs.length >= 16 && !this.programs.includes(program)))
      )
        this.flush();
      if (program.textures.length > this.textureLimit) {
        this.stats.fallbacks++;
        continue;
      }
      this.state = key;
      if (!this.programs.includes(program)) this.programs.push(program);
      for (const t of program.textures)
        if (!this.textures.includes(t)) this.textures.push(t);
      let entry = this.entries.get(object);
      if (!entry) {
        entry = { mesh: object, program, vertices: 0 };
        this.entries.set(object, entry);
      }
      entry.program = program;
      let vertices = 0;
      if (geometry.index) {
        for (let k = first; k < last; k++)
          vertices = Math.max(vertices, geometry.index.getX(k) + 1);
      } else vertices = last;
      entry.vertices = vertices;
      this.pending.push(entry);
      this.pendingRows += count;
    }
    this.flush();
    this.trimInactiveRuns();
    return this.results;
  }
  private flush(): void {
    if (!this.pending.length) return;
    let vertices = 0,
      indices = 0,
      draws = 0,
      sourceDraws = 0;
    for (const { mesh, vertices: liveVertices } of this.pending) {
      const m = mesh.material as ShaderMaterial,
        count = isBillboardBatchSource(mesh) ? mesh.count : 1,
        passes =
          m.transparent && m.side === DoubleSide && !m.forceSinglePass ? 2 : 1;
      vertices += liveVertices * count * passes;
      indices +=
        Math.max(
          0,
          Math.min(
            mesh.geometry.drawRange.count,
            (mesh.geometry.index?.count ??
              mesh.geometry.getAttribute("position").count) -
              mesh.geometry.drawRange.start,
          ),
        ) *
        count *
        passes;
      draws += count;
      sourceDraws += passes;
    }
    this.stats.sourceDrawCalls += sourceDraws;
    // Program dispatch order need not follow particle order. Canonicalize it
    // so changing birth/death order reuses the same shader and texture bindings.
    this.programs.sort((a, b) => a.id - b.id);
    this.textures.length = 0;
    for (const program of this.programs)
      for (const texture of program.textures)
        if (!this.textures.includes(texture)) this.textures.push(texture);
    const key = this.state + "|" + this.programs.map((p) => p.id).join(",");
    let bucket = this.pool.get(key);
    if (!bucket) {
      bucket = { runs: [], used: 0 };
      this.pool.set(key, bucket);
    }
    // The same state can recur after a barrier. Every active run needs its own
    // retained stream, otherwise a later write overwrites earlier triangles.
    const slot = bucket.used++;
    let run = bucket.runs[slot];
    if (
      !run ||
      run.key !== key ||
      run.capacity < vertices ||
      run.indexCapacity < indices ||
      run.drawCapacity < draws
    ) {
      run?.dispose();
      const power = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
      run = new SurfaceBatchRun(
        key,
        power(Math.max(vertices, 256)),
        power(Math.max(indices, 1024)),
        power(Math.max(draws, 64)),
        this.programs.slice(),
        this.textures.slice(),
        this.pending[0]!.mesh,
        this.options.parent,
      );
      bucket.runs[slot] = run;
      this.stats.createdRuns++;
    }
    run.write(this.pending);
    this.stats.drawCalls++;
    this.stats.savedDrawCalls += sourceDraws - 1;
    this.stats.vertices += vertices;
    let result = this.resultCache.get(run);
    if (!result) {
      result = {
        mesh: run.mesh,
        firstSource: this.pending[0]!.mesh,
        sourceDrawCalls: sourceDraws,
      };
      this.resultCache.set(run, result);
    }
    result.firstSource = this.pending[0]!.mesh;
    result.sourceDrawCalls = sourceDraws;
    this.results.push(result);
    for (const { mesh } of this.pending) {
      mesh.visible = false;
      this.hidden.push(mesh);
    }
    this.pendingRows = 0;
    this.pending.length = this.programs.length = this.textures.length = 0;
  }
  private trimInactiveRuns(): void {
    let retained = 0;
    this.canonical.clear();
    for (const [key, bucket] of this.pool) {
      const keep = Math.min(
        bucket.runs.length - bucket.used,
        Math.max(0, this.maxInactiveRuns - retained),
      );
      retained += keep;
      while (bucket.runs.length > bucket.used + keep)
        bucket.runs.pop()!.dispose();
      if (bucket.runs.length === 0) this.pool.delete(key);
      else
        for (const run of bucket.runs)
          for (const program of run.programs)
            this.canonical.set(program.key, program);
    }
  }
  dispose(): void {
    if (this.destroyed) return;
    this.beginFrame();
    for (const bucket of this.pool.values())
      for (const run of bucket.runs) run.dispose();
    this.pool.clear();
    this.canonical.clear();
    this.destroyed = true;
  }
}
