import { Matrix4, Vector3, type Camera } from "three";
import type { VfxLightSlot } from "../lights/selection";

/** Fixed allocation ceilings, not device performance recommendations. */
export const THREE_CLUSTER_LIMITS = Object.freeze({
  lights: 512,
  perCluster: 64,
  x: 16,
  y: 9,
  z: 16,
});
const { x: NX, y: NY, z: NZ } = THREE_CLUSTER_LIMITS;
export const THREE_CLUSTER_COUNT = NX * NY * NZ;

/** CPU-built conservative view clusters. Particle simulation remains on the CPU.
 * Entries are 1-based slot indices, zero terminates a list. Dimensions never
 * depend on resolution/DPR. The fragment shader applies the exact sphere range.
 */
export class ThreeLightClusterGrid {
  readonly indices = new Uint32Array(
    THREE_CLUSTER_COUNT * THREE_CLUSTER_LIMITS.perCluster,
  );
  readonly counts = new Uint16Array(THREE_CLUSTER_COUNT);
  private readonly admittedCounts = new Uint8Array(THREE_CLUSTER_COUNT);
  private readonly influenceCells = new Uint16Array(THREE_CLUSTER_COUNT);
  readonly lightData = new Float32Array(THREE_CLUSTER_LIMITS.lights * 8);
  readonly stats = {
    overflowClusters: 0,
    overflowAssignments: 0,
    overflowLights: 0,
    maxOccupancy: 0,
    culledLights: 0,
    contributingLights: 0,
  };
  near = 0.1;
  far = 1000;
  private readonly position = new Vector3();
  private readonly corner = new Vector3();
  private readonly view = new Matrix4();
  private readonly order: number[] = [];
  clear(): void {
    this.indices.fill(0);
    this.counts.fill(0);
    this.admittedCounts.fill(0);
    this.lightData.fill(0);
    Object.assign(this.stats, {
      overflowClusters: 0,
      overflowAssignments: 0,
      overflowLights: 0,
      maxOccupancy: 0,
      culledLights: 0,
      contributingLights: 0,
    });
  }
  /** Returns false for cameras whose finite projection cannot be clustered. */
  update(
    slots: readonly VfxLightSlot[],
    camera: Camera,
    capacity: number,
  ): boolean {
    this.clear();
    const c = camera as Camera & {
      near?: number;
      far?: number;
      isPerspectiveCamera?: boolean;
      isOrthographicCamera?: boolean;
    };
    if (
      !(c.isPerspectiveCamera || c.isOrthographicCamera) ||
      !Number.isFinite(c.near) ||
      !Number.isFinite(c.far) ||
      c.near! < 0 ||
      c.far! <= Math.max(0.0001, c.near!) ||
      !camera.projectionMatrix.elements.every(Number.isFinite)
    )
      return false;
    this.near = Math.max(0.0001, c.near!);
    this.far = c.far!;
    camera.updateWorldMatrix(true, false);
    this.view.copy(camera.matrixWorld).invert();
    const cap = Math.min(
      THREE_CLUSTER_LIMITS.perCluster,
      Math.max(1, Math.floor(capacity)),
    );
    const slice = (depth: number) =>
      Math.max(
        0,
        Math.min(
          NZ - 1,
          Math.floor(
            (Math.log(Math.max(this.near, depth) / this.near) /
              Math.log(this.far / this.near)) *
              NZ,
          ),
        ),
      );
    this.order.length = 0;
    for (
      let i = 0;
      i < Math.min(slots.length, THREE_CLUSTER_LIMITS.lights);
      i++
    )
      this.order.push(i);
    // Stable identity order prevents a compacted selector slot from arbitrarily
    // winning a crowded cluster. Global selection already applies importance.
    this.order.sort((a, b) =>
      slots[a]!.candidate.id.localeCompare(slots[b]!.candidate.id),
    );
    for (const index of this.order) {
      const slot = slots[index]!,
        light = slot.candidate;
      this.position.fromArray(light.position).applyMatrix4(this.view);
      const p = this.position,
        radius = light.radius,
        depth = -p.z;
      this.lightData.set(
        [
          p.x,
          p.y,
          p.z,
          radius,
          light.color[0] * light.intensity * slot.gain,
          light.color[1] * light.intensity * slot.gain,
          light.color[2] * light.intensity * slot.gain,
          2,
        ],
        index * 8,
      );
      if (depth + radius < this.near || depth - radius > this.far) {
        this.stats.culledLights++;
        continue;
      }
      let minX = -1,
        maxX = 1,
        minY = -1,
        maxY = 1;
      // A projected bounding cube contains the entire influence sphere. If it
      // crosses the eye/near plane, use all XY cells (never center-point cull).
      if (!c.isPerspectiveCamera || depth - radius > this.near) {
        minX = minY = Infinity;
        maxX = maxY = -Infinity;
        for (const dx of [-radius, radius])
          for (const dy of [-radius, radius])
            for (const dz of [-radius, radius]) {
              this.corner
                .set(p.x + dx, p.y + dy, p.z + dz)
                .applyMatrix4(camera.projectionMatrix);
              minX = Math.min(minX, this.corner.x);
              maxX = Math.max(maxX, this.corner.x);
              minY = Math.min(minY, this.corner.y);
              maxY = Math.max(maxY, this.corner.y);
            }
      }
      if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) {
        this.stats.culledLights++;
        continue;
      }
      const cell = (v: number, n: number) =>
        Math.max(0, Math.min(n - 1, Math.floor((v * 0.5 + 0.5) * n)));
      let overflow = false,
        cellCount = 0;
      for (let z = slice(depth - radius); z <= slice(depth + radius); z++)
        for (let y = cell(minY, NY); y <= cell(maxY, NY); y++)
          for (let x = cell(minX, NX); x <= cell(maxX, NX); x++) {
            const cluster = x + NX * (y + NY * z),
              count = this.counts[cluster]!;
            this.counts[cluster] = count + 1;
            this.stats.maxOccupancy = Math.max(
              this.stats.maxOccupancy,
              count + 1,
            );
            if (count === cap) this.stats.overflowClusters++;
            this.influenceCells[cellCount++] = cluster;
            if (this.admittedCounts[cluster]! >= cap) overflow = true;
          }
      // Admit the entire influence volume atomically. Partial admission gives a
      // light an artificial hard cutoff at cell boundaries, including diagonal
      // depth-slice cuts across planar mesh faces. Stable identity order keeps
      // the decision independent of selector slot compaction.
      if (overflow) {
        this.stats.overflowLights++;
        this.stats.overflowAssignments += cellCount;
        continue;
      }
      for (let i = 0; i < cellCount; i++) {
        const cluster = this.influenceCells[i]!,
          count = this.admittedCounts[cluster]!;
        this.indices[cluster * THREE_CLUSTER_LIMITS.perCluster + count] =
          index + 1;
        this.admittedCounts[cluster] = count + 1;
      }
      if (cellCount > 0) this.stats.contributingLights++;
    }
    return true;
  }
}
