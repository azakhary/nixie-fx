import {
  DataTexture,
  FloatType,
  RGBAFormat,
  RGBAIntegerFormat,
  UnsignedIntType,
  type Camera,
  type Object3D,
  type Scene,
  type Light,
} from "three";
import {
  LightsNode,
  LightingNode,
  type NodeBuilder,
  type Node,
  type WebGPURenderer,
} from "three/webgpu";
import * as T from "three/tsl";
import {
  ThreeLightClusterGrid,
  THREE_CLUSTER_COUNT,
  THREE_CLUSTER_LIMITS,
} from "../clusterGrid";
import {
  ThreeVfxLightManager,
  type ThreeVfxClusterBackend,
} from "../vfxLights";
import type { VfxLightSlot } from "../../lights/selection";

/** Install before the first render; does not render, simulate or schedule frames.
 * One binding per renderer, one manager per scene. Other scenes and all game
 * lights continue through the host's existing lighting implementation.
 */
export function createThreeClusteredLighting(
  renderer: WebGPURenderer,
  scene: Scene,
) {
  if (bindings.has(renderer))
    throw new Error("This renderer already has a clustered lighting binding.");
  const supported =
    "isWebGPUBackend" in renderer.backend &&
    renderer.backend.isWebGPUBackend === true;
  const backend = new ClusterBackend(supported);
  const manager = ThreeVfxLightManager.forScene(scene);
  const previous = renderer.lighting;
  const originalGetNode = previous.getNode;
  const node = new ClusterLightsNode(backend);
  // r184/r185 capture the Lighting object during init. Replacing renderer.lighting
  // afterward has no effect. Patch its public factory and invalidate only cached
  // render lists so a host may install/remove this binding without owning a new renderer.
  const lists = (renderer as unknown as { _renderLists?: { dispose(): void } })
    ._renderLists;
  if (supported && !lists?.dispose) {
    backend.dispose();
    throw new Error(
      "This Three version cannot install clustered lighting on an initialized renderer. Use the small path.",
    );
  }
  const getNode = (target: Object3D): LightsNode =>
    target === scene ? node : originalGetNode.call(previous, target);
  manager.setClusterBackend(backend);
  if (supported) {
    previous.getNode = getNode;
    lists!.dispose();
  }
  bindings.add(renderer);
  let disposed = false;
  return {
    manager,
    supported,
    reason: backend.reason,
    dispose() {
      if (disposed) return;
      disposed = true;
      manager.setProfile({ mode: "small", maxLights: 2 });
      manager.setClusterBackend(undefined);
      if (previous.getNode === getNode) previous.getNode = originalGetNode;
      lists?.dispose();
      backend.dispose();
      bindings.delete(renderer);
    },
  };
}
const bindings = new WeakSet<WebGPURenderer>();

class ClusterBackend implements ThreeVfxClusterBackend {
  readonly grid = new ThreeLightClusterGrid();
  readonly stats = this.grid.stats;
  readonly reason: string;
  readonly lights = new DataTexture(
    this.grid.lightData,
    2,
    THREE_CLUSTER_LIMITS.lights,
    RGBAFormat,
    FloatType,
  );
  readonly indices = new DataTexture(
    this.grid.indices,
    THREE_CLUSTER_LIMITS.perCluster / 4,
    THREE_CLUSTER_COUNT,
    RGBAIntegerFormat,
    UnsignedIntType,
  );
  readonly enabled = T.uniform(0);
  constructor(readonly supported: boolean) {
    this.reason = supported
      ? ""
      : "Clustered lighting requires native WebGPU; WebGL2 fallback is small-budget only. Use 0, 2 or 4 lights.";
  }
  update(
    slots: readonly VfxLightSlot[],
    camera: Camera,
    perCluster: number,
  ): boolean {
    const valid = this.supported && this.grid.update(slots, camera, perCluster);
    this.enabled.value = valid ? 1 : 0;
    this.lights.needsUpdate = this.indices.needsUpdate = true;
    return valid;
  }
  clear(): void {
    this.enabled.value = 0;
    this.grid.clear();
    this.lights.needsUpdate = this.indices.needsUpdate = true;
  }
  dispose(): void {
    this.clear();
    this.lights.dispose();
    this.indices.dispose();
  }
  forEachLight(
    visit: (light: {
      lightDirection: Node<"vec3">;
      lightColor: Node<"vec3">;
    }) => void,
  ): void {
    T.If(this.enabled.greaterThan(0), () => {
      const projected = T.cameraProjectionMatrix.mul(T.vec4(T.positionView, 1));
      const uv = projected.xy.div(projected.w).mul(0.5).add(0.5);
      const xy = T.vec2(
        uv.mul(T.vec2(THREE_CLUSTER_LIMITS.x, THREE_CLUSTER_LIMITS.y)).floor(),
      ).clamp(
        T.vec2(0),
        T.vec2(THREE_CLUSTER_LIMITS.x - 1, THREE_CLUSTER_LIMITS.y - 1),
      );
      const near = T.cameraNear.max(0.0001);
      const z = T.float(
        T.positionView.z
          .negate()
          .max(near)
          .div(near)
          .log()
          .div(T.cameraFar.div(near).log())
          .mul(THREE_CLUSTER_LIMITS.z)
          .floor(),
      ).clamp(0, THREE_CLUSTER_LIMITS.z - 1);
      const cluster = xy.x.add(
        xy.y.add(z.mul(THREE_CLUSTER_LIMITS.y)).mul(THREE_CLUSTER_LIMITS.x),
      );
      T.Loop(THREE_CLUSTER_LIMITS.perCluster, ({ i }) => {
        const packed = T.textureLoad(
          this.indices,
          T.ivec2(i.div(4), T.int(cluster)),
        );
        const index = T.int(packed.element(i.mod(4)) as Node<"uint">);
        T.If(index.equal(0), () => {
          T.Break();
        });
        const a = T.textureLoad(this.lights, T.ivec2(0, index.sub(1)));
        const b = T.textureLoad(this.lights, T.ivec2(1, index.sub(1)));
        const vector = a.xyz.sub(T.positionView);
        const distance = vector.length();
        // Three point-light attenuation (decay 2), shared by BRDF and graph feeds.
        const attenuation = T.float(1)
          .div(distance.pow(b.w).max(0.01))
          .mul(T.float(1).sub(distance.div(a.w).pow(4)).clamp().pow(2));
        visit({
          lightDirection: vector.normalize(),
          lightColor: b.rgb.mul(attenuation),
        });
      });
    });
  }
  diffuse() {
    return T.Fn(() => {
      const sum = T.vec3(0).toVar();
      this.forEachLight(({ lightDirection, lightColor }) => {
        sum.addAssign(
          lightColor.mul(T.normalView.dot(lightDirection).clamp()).div(Math.PI),
        );
      });
      return sum;
    })();
  }
}
class ClusterContribution extends LightingNode {
  constructor(private readonly backend: ClusterBackend) {
    super();
  }
  override setup(builder: NodeBuilder): undefined {
    const reflected = builder.getContext().reflectedLight as {
      directDiffuse: Node<"vec3">;
      directSpecular: Node<"vec3">;
    };
    reflected.directDiffuse.toStack();
    reflected.directSpecular.toStack();
    T.Fn(() => {
      this.backend.forEachLight((light) =>
        builder.lightsNode.setupDirectLight(builder, this, light),
      );
    }, "void")();
    return undefined;
  }
}
class ClusterLightsNode extends LightsNode {
  private readonly contribution: ClusterContribution;
  constructor(private readonly backend: ClusterBackend) {
    super();
    this.contribution = new ClusterContribution(backend);
    this.setLights([]);
  }
  override setLights(lights: Light[]): this {
    // Three explicitly supports LightingNodes in this list. Keep the contribution
    // in getLights() so material-local AO/environment/lightmap nodes can compose
    // a new LightsNode without dropping clustered illumination.
    return super.setLights([...lights, this.contribution as unknown as Light]);
  }
  getClusterDiffuse() {
    return this.backend.diffuse();
  }
}
