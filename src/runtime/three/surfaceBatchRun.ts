import {
  BufferGeometry,
  BufferAttribute,
  DataTexture,
  FloatType,
  RGBAFormat,
  NearestFilter,
  DynamicDrawUsage,
  Mesh,
  ShaderMaterial,
  MeshBasicMaterial,
  Matrix4,
  Vector3,
  Vector2,
  DoubleSide,
  FrontSide,
  BackSide,
  type Object3D,
  type Texture,
  type InstancedMesh,
} from "three";
import { isBillboardBatchSource } from "./billboardBatchSources";
import {
  compileSurfacePrograms,
  type SurfaceProgram,
} from "./surfaceBatchMaterial";
export interface SurfaceEntry {
  mesh: Mesh;
  program: SurfaceProgram;
  vertices: number;
}
export const MAX_SURFACE_PARAMETER_ROWS = 2048;

const VERTEX = `attribute vec4 nfxColor;attribute float nfxProgram;attribute highp float nfxDraw;attribute float nfxFace;attribute vec4 nfxDynamic;
varying vec2 vUV;varying vec4 vNfxColor;varying float vNfxProgram;varying highp float vNfxDraw;varying float vNfxFace;varying vec4 vNfxDynamic;
void main(){vUV=uv;vNfxColor=nfxColor;vNfxProgram=nfxProgram;vNfxDraw=nfxDraw;vNfxFace=nfxFace;vNfxDynamic=nfxDynamic;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
/** A retained indexed surface stream. Different source topology needs no extra draw. */
export class SurfaceBatchRun {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly data: DataTexture;
  private readonly transform = new Matrix4();
  private readonly instance = new Matrix4();
  private readonly inverseParent = new Matrix4();
  private readonly point = new Vector3();
  private readonly uv = new Vector2();
  private readonly fields: Record<string, BufferAttribute> = {};
  private readonly indices: BufferAttribute;
  constructor(
    readonly key: string,
    readonly capacity: number,
    readonly indexCapacity: number,
    readonly drawCapacity: number,
    readonly programs: readonly SurfaceProgram[],
    textures: readonly Texture[],
    first: Mesh,
    parent: Object3D,
  ) {
    if (drawCapacity > MAX_SURFACE_PARAMETER_ROWS)
      throw Error("Surface parameter rows exceed the WebGL2 texture budget");
    const geometry = new BufferGeometry();
    for (const [name, size] of [
      ["position", 3],
      ["uv", 2],
      ["nfxColor", 4],
      ["nfxProgram", 1],
      ["nfxDraw", 1],
      ["nfxFace", 1],
      ["nfxDynamic", 4],
    ] as const) {
      const a = new BufferAttribute(
        new Float32Array(capacity * size),
        size,
      ).setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, a);
      this.fields[name] = a;
    }
    this.indices = new BufferAttribute(
      new Uint32Array(indexCapacity),
      1,
    ).setUsage(DynamicDrawUsage);
    geometry.setIndex(this.indices);
    this.data = new DataTexture(
      new Float32Array(drawCapacity * 16 * 4),
      16,
      drawCapacity,
      RGBAFormat,
      FloatType,
    );
    this.data.minFilter = this.data.magFilter = NearestFilter;
    this.data.generateMipmaps = false;
    const source = first.material as ShaderMaterial | MeshBasicMaterial;
    const uniforms: Record<string, { value: unknown }> = {
      uNfxData: { value: this.data },
    };
    textures.forEach(
      (texture, i) => (uniforms["nfxTexture" + i] = { value: texture }),
    );
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: compileSurfacePrograms(programs, textures),
      uniforms,
      side: DoubleSide,
      forceSinglePass: true,
      transparent: source.transparent,
      blending: source.blending,
      depthTest: source.depthTest,
      depthWrite: source.depthWrite,
      depthFunc: source.depthFunc,
      premultipliedAlpha: source.premultipliedAlpha,
      toneMapped: true,
    });
    material.colorWrite = source.colorWrite;
    material.blendSrc = source.blendSrc;
    material.blendDst = source.blendDst;
    material.blendEquation = source.blendEquation;
    material.blendSrcAlpha = source.blendSrcAlpha;
    material.blendDstAlpha = source.blendDstAlpha;
    material.blendEquationAlpha = source.blendEquationAlpha;
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = "NixieFX surface batch";
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }
  write(entries: readonly SurfaceEntry[]): void {
    this.mesh.parent!.updateWorldMatrix(true, false);
    this.inverseParent.copy(this.mesh.parent!.matrixWorld).invert();
    let vertex = 0,
      index = 0,
      draw = 0;
    const data = this.data.image.data as Float32Array;
    for (const { mesh, program, vertices } of entries) {
      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry,
        position = geometry.getAttribute("position"),
        uv = geometry.getAttribute("uv"),
        color = geometry.getAttribute("color"),
        dynamic = geometry.getAttribute("trailDynamicParams"),
        srcIndex = geometry.index;
      const count = isBillboardBatchSource(mesh) ? mesh.count : 1,
        material = mesh.material as ShaderMaterial | MeshBasicMaterial;
      const start = geometry.drawRange.start,
        end = Math.min(
          start + geometry.drawRange.count,
          srcIndex?.count ?? position.count,
        );
      const programIndex = this.programs.indexOf(program);
      for (let particle = 0; particle < count; particle++, draw++) {
        this.transform.multiplyMatrices(this.inverseParent, mesh.matrixWorld);
        if (isBillboardBatchSource(mesh)) {
          (mesh as InstancedMesh).getMatrixAt(particle, this.instance);
          this.transform.multiply(this.instance);
        }
        const mirrored = this.transform.determinant() < 0 ? -1 : 1;
        if (material instanceof ShaderMaterial && program.kind === "graph") {
          for (let u = 0; u < program.uniforms.length; u++) {
            const value = material.uniforms[program.uniforms[u]!]!.value;
            const at = (draw * 16 + u) * 4;
            if (typeof value === "number") {
              data[at] = value;
              data[at + 1] = data[at + 2] = data[at + 3] = 0;
            } else {
              data[at] = value.x ?? 0;
              data[at + 1] = value.y ?? 0;
              data[at + 2] = value.z ?? 0;
              data[at + 3] = value.w ?? 0;
            }
          }
        }
        let r = 1,
          g = 1,
          b = 1,
          a = 1;
        if (program.kind === "graph" && !program.vertexDynamicParams) {
          const c = (material as ShaderMaterial).uniforms.uParticleColor?.value;
          if (c) {
            r = c.x;
            g = c.y;
            b = c.z;
            a = c.w;
          }
        } else if (isBillboardBatchSource(mesh)) {
          const c = geometry.getAttribute("aInstanceColor");
          r = c.getX(particle);
          g = c.getY(particle);
          b = c.getZ(particle);
          a = geometry.getAttribute("aInstanceAlpha").getX(particle);
        } else if (material instanceof MeshBasicMaterial) {
          const m = material;
          r = m.color.r;
          g = m.color.g;
          b = m.color.b;
          a = m.opacity;
        }
        const map = material instanceof MeshBasicMaterial ? material.map : null;
        if (map?.matrixAutoUpdate) map.updateMatrix();
        // Match Three's back-then-front transparent DoubleSide submission, within
        // one indexed stream. The face tag discards the opposite face in each copy.
        const passes =
          material.transparent &&
          material.side === DoubleSide &&
          !material.forceSinglePass
            ? 2
            : 1;
        for (let pass = 0; pass < passes; pass++) {
          const base = vertex;
          const face =
            (passes === 2
              ? pass === 0
                ? -1
                : 1
              : material.side === FrontSide
                ? 1
                : material.side === BackSide
                  ? -1
                  : 0) * mirrored;
          for (let v = 0; v < vertices; v++, vertex++) {
            this.point
              .fromBufferAttribute(position, v)
              .applyMatrix4(this.transform);
            this.fields.position!.setXYZ(
              vertex,
              this.point.x,
              this.point.y,
              this.point.z,
            );
            this.uv.set(uv?.getX(v) ?? 0, uv?.getY(v) ?? 0);
            if (map) this.uv.applyMatrix3(map.matrix);
            this.fields.uv!.setXY(vertex, this.uv.x, this.uv.y);
            const vertexColor =
              ((material instanceof MeshBasicMaterial &&
                material.vertexColors) ||
                program.vertexDynamicParams) &&
              color;
            this.fields.nfxColor!.setXYZW(
              vertex,
              r * (vertexColor ? color.getX(v) : 1),
              g * (vertexColor ? color.getY(v) : 1),
              b * (vertexColor ? color.getZ(v) : 1),
              a * (vertexColor && color.itemSize === 4 ? color.getW(v) : 1),
            );
            this.fields.nfxProgram!.setX(vertex, programIndex);
            this.fields.nfxDraw!.setX(vertex, draw);
            this.fields.nfxFace!.setX(vertex, face);
            this.fields.nfxDynamic!.setXYZW(
              vertex,
              dynamic?.getX(v) ?? 0,
              dynamic?.getY(v) ?? 0,
              dynamic?.getZ(v) ?? 0,
              dynamic?.getW(v) ?? 0,
            );
          }
          for (let j = start; j < end; j++)
            this.indices.setX(
              index++,
              base + (srcIndex ? srcIndex.getX(j) : j),
            );
        }
      }
    }
    for (const attribute of Object.values(this.fields)) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, vertex * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.indices.clearUpdateRanges();
    this.indices.addUpdateRange(0, index);
    this.indices.needsUpdate = true;
    this.data.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, index);
    this.mesh.visible = index > 0;
    this.mesh.renderOrder = entries[0]!.mesh.renderOrder;
    this.mesh.layers.mask = entries[0]!.mesh.layers.mask;
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.data.dispose();
  }
}
