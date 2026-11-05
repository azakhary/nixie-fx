import { Matrix4, type Camera } from "three";
import {
  StorageInstancedBufferAttribute,
  type Node,
  type WebGPURenderer,
} from "three/webgpu";
import * as T from "three/tsl";
import { THREE_CLUSTER_COUNT, THREE_CLUSTER_LIMITS } from "../clusterGrid";
import type { ThreeGpuLightAllocation } from "./lights";

/** Compact GPU lists under a conservative whole-volume allowance. CPU + GPU
 * occupancy cannot exceed perCluster, so lights never acquire cluster-edge cuts. */
export class ThreeGpuLightClusters {
  readonly data = T.storage(
    new StorageInstancedBufferAttribute(1024, 4),
    "vec4",
    1024,
  );
  private readonly bounds = T.storage(
    new StorageInstancedBufferAttribute(128, 4),
    "vec4",
    128,
  );
  private readonly indices = T.storage(
    new StorageInstancedBufferAttribute(
      new Uint32Array(THREE_CLUSTER_COUNT * 64),
      1,
    ),
    "uint",
    THREE_CLUSTER_COUNT * 64,
  );
  readonly count = T.uniform(0);
  private readonly projection = T.uniform(new Matrix4());
  private readonly near = T.uniform(0.1);
  private readonly far = T.uniform(1000);
  private readonly perspective = T.uniform(1);
  private readonly boundsPass;
  private readonly clusterPass;
  constructor(private readonly renderer: WebGPURenderer) {
    const { x: nx, y: ny, z: nz } = THREE_CLUSTER_LIMITS;
    this.boundsPass = T.Fn(() => {
      const i = T.instanceIndex;
      const min = this.bounds.element(i.mul(2)),
        max = this.bounds.element(i.mul(2).add(1));
      min.assign(T.vec4(2));
      max.assign(T.vec4(-2));
      T.If(T.float(i).lessThan(this.count), () => {
        const light = this.data.element(i.mul(2));
        const depth = light.z.negate(),
          radius = light.w;
        T.If(
          radius
            .greaterThan(0)
            .and(depth.add(radius).greaterThanEqual(this.near))
            .and(depth.sub(radius).lessThanEqual(this.far)),
          () => {
            const lo = T.vec2(-1).toVar(),
              hi = T.vec2(1).toVar();
            T.If(
              this.perspective
                .equal(0)
                .or(depth.sub(radius).greaterThan(this.near)),
              () => {
                lo.assign(T.vec2(1e20));
                hi.assign(T.vec2(-1e20));
                for (const x of [-1, 1])
                  for (const y of [-1, 1])
                    for (const z of [-1, 1]) {
                      const p = this.projection.mul(
                        T.vec4(light.xyz.add(T.vec3(x, y, z).mul(radius)), 1),
                      );
                      const xy = p.xy.div(p.w);
                      lo.assign(T.min(lo, xy));
                      hi.assign(T.max(hi, xy));
                    }
              },
            );
            const slice = (z: Node<"float">) =>
              z
                .max(this.near)
                .div(this.near)
                .log()
                .div(this.far.div(this.near).log())
                .mul(nz)
                .floor()
                .clamp(0, nz - 1);
            min.assign(
              T.vec4(
                lo.mul(0.5).add(0.5).mul(T.vec2(nx, ny)).floor(),
                slice(depth.sub(radius)),
                0,
              ),
            );
            max.assign(
              T.vec4(
                hi.mul(0.5).add(0.5).mul(T.vec2(nx, ny)).floor(),
                slice(depth.add(radius)),
                0,
              ),
            );
          },
        );
      });
    })().compute(64, [64]);
    this.clusterPass = T.Fn(() => {
      const cluster = T.instanceIndex;
      const cell = T.vec3(
        T.float(cluster.mod(nx)),
        T.float(cluster.div(nx).mod(ny)),
        T.float(cluster.div(nx * ny)),
      );
      const filled = T.uint(0).toVar();
      T.Loop({ start: 0, end: T.int(this.count), condition: "<" }, ({ i }) => {
        const lo = this.bounds.element(i.mul(2)).xyz,
          hi = this.bounds.element(i.mul(2).add(1)).xyz;
        T.If(
          cell.x
            .greaterThanEqual(lo.x)
            .and(cell.y.greaterThanEqual(lo.y))
            .and(cell.z.greaterThanEqual(lo.z))
            .and(cell.x.lessThanEqual(hi.x))
            .and(cell.y.lessThanEqual(hi.y))
            .and(cell.z.lessThanEqual(hi.z)),
          () => {
            this.indices
              .element(cluster.mul(64).add(filled))
              .assign(T.uint(i).add(1));
            filled.addAssign(1);
          },
        );
      });
      T.If(filled.lessThan(64), () => {
        this.indices.element(cluster.mul(64).add(filled)).assign(0);
      });
    })().compute(THREE_CLUSTER_COUNT, [64]);
  }
  update(
    allocations: readonly ThreeGpuLightAllocation[],
    camera: Camera,
    allowance: number,
  ) {
    let used = 0;
    for (const a of allocations) {
      const n = Math.min(a.count, Math.max(0, allowance - used), 64 - used);
      if (n) {
        a.source.writeLights(this.data, used, n, camera);
        used += n;
      }
    }
    this.count.value = used;
    if (!used) return 0;
    const c = camera as Camera & {
      near: number;
      far: number;
      isPerspectiveCamera?: boolean;
    };
    this.projection.value.copy(c.projectionMatrix);
    this.near.value = c.near;
    this.far.value = c.far;
    this.perspective.value = c.isPerspectiveCamera ? 1 : 0;
    this.renderer.compute(this.boundsPass);
    this.renderer.compute(this.clusterPass);
    return used;
  }
  visit(
    cluster: Node<"float">,
    visit: (light: {
      lightDirection: Node<"vec3">;
      lightColor: Node<"vec3">;
    }) => void,
  ) {
    T.If(this.count.greaterThan(0), () => {
      T.Loop(64, ({ i }) => {
        const index = this.indices.element(
          T.uint(cluster).mul(64).add(T.uint(i)),
        );
        T.If(index.equal(0), () => {
          T.Break();
        });
        const a = this.data.element(index.sub(1).mul(2)),
          b = this.data.element(index.sub(1).mul(2).add(1));
        const vector = a.xyz.sub(T.positionView),
          distance = vector.length();
        const attenuation = T.float(1)
          .div(distance.pow(2).max(0.01))
          .mul(
            T.float(1)
              .sub(distance.div(a.w.max(0.0001)).pow(4))
              .clamp()
              .pow(2),
          );
        visit({
          lightDirection: vector.div(distance.max(0.00001)),
          lightColor: b.rgb.mul(attenuation),
        });
      });
    });
  }
  clear() {
    this.count.value = 0;
  }
  dispose() {
    this.clear();
    this.boundsPass.dispose();
    this.clusterPass.dispose();
    const backend = this.renderer.backend as unknown as {
      get(a: unknown): { buffer?: unknown };
      destroyAttribute(a: unknown): void;
    };
    for (const node of [this.data, this.bounds, this.indices])
      if (backend.get(node.value).buffer) backend.destroyAttribute(node.value);
  }
}
