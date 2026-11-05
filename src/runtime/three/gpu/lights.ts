import type { Camera } from "three";
import type { StorageBufferNode } from "three/webgpu";
/** GPU-only producer contract. Stable source registration plus bounded slot ranges. */
export interface ThreeGpuLightSource {
  readonly requestedLights: number;
  writeLights(
    target: StorageBufferNode<"vec4">,
    offset: number,
    count: number,
    camera: Camera,
  ): void;
}
export interface ThreeGpuLightAllocation {
  source: ThreeGpuLightSource;
  offset: number;
  count: number;
}
