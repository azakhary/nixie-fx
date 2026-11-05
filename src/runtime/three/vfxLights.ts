import type {
  ThreeGpuLightSource,
  ThreeGpuLightAllocation,
} from "./gpu/lights";
import {
  PointLight,
  Scene,
  Vector3,
  Frustum,
  Matrix4,
  Sphere,
  type Camera,
  type Light,
} from "three";
import type { VfxLightCandidate, VfxLightProducer } from "../lights/candidates";
import type { VfxLightSlot } from "../lights/selection";
import { THREE_CLUSTER_LIMITS } from "./clusterGrid";
import { VfxLightSelector } from "../lights/selection";
export type ThreeVfxLightBudget = 0 | 2 | 4;
export type ThreeVfxLightProfile =
  | { mode: "small"; maxLights: ThreeVfxLightBudget }
  | {
      mode: "clustered";
      maxLights: number;
      maxLightsPerCluster: number;
      totalSceneLights: number;
    };
export interface ThreeVfxClusterBackend {
  readonly supported: boolean;
  readonly reason: string;
  readonly stats: {
    overflowClusters: number;
    overflowAssignments: number;
    overflowLights: number;
    maxOccupancy: number;
    culledLights: number;
    contributingLights: number;
    gpuReservedLights?: number;
    gpuRejectedLights?: number;
  };
  update(
    slots: readonly VfxLightSlot[],
    camera: Camera,
    perCluster: number,
    gpu?: readonly ThreeGpuLightAllocation[],
  ): boolean;
  clear(): void;
}
export interface ThreeVfxLightStats {
  candidates: number;
  active: number;
  budget: number;
  sceneLights: number;
  mode: "small" | "clustered";
  requestedMode: "small" | "clustered";
  supported: boolean;
  reason: string;
  capacityClamped: boolean;
  requestedBudget: number;
  totalSceneCapacity: number;
  perClusterCapacity: number;
  invalidRanges: number;
  invalidCandidates: number;
  budgetRejected: number;
  budgetReduction: number;
  frustumCulled: number;
  overflowClusters: number;
  overflowAssignments: number;
  overflowLights: number;
  maxOccupancy: number;
  contributingLights: number;
  fading: number;
}
const bounded = (value: number, max: number, min = 0) =>
  Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : min;
const managers = new WeakMap<Scene, ThreeVfxLightManager>();
/** One manager per host scene, shared even by independent ThreeVfxRenderers. No owned frame loop. */
export class ThreeVfxLightManager {
  readonly stats: ThreeVfxLightStats = {
    candidates: 0,
    active: 0,
    budget: 0,
    sceneLights: 0,
    mode: "small",
    requestedMode: "small",
    supported: false,
    reason:
      "Clustered lighting requires native WebGPU. Use the small 0/2/4-light path.",
    capacityClamped: false,
    requestedBudget: 2,
    totalSceneCapacity: 0,
    perClusterCapacity: 0,
    invalidRanges: 0,
    invalidCandidates: 0,
    budgetRejected: 0,
    budgetReduction: 0,
    frustumCulled: 0,
    overflowClusters: 0,
    overflowAssignments: 0,
    overflowLights: 0,
    maxOccupancy: 0,
    contributingLights: 0,
    fading: 0,
  };
  private cluster?: ThreeVfxClusterBackend;
  private profile: ThreeVfxLightProfile = { mode: "small", maxLights: 2 };
  private profileChanged = false;
  private readonly frustum = new Frustum();
  private readonly projectionView = new Matrix4();
  private readonly sphere = new Sphere();
  /** Install once before rendering. The host owns and disposes the backend. */
  setClusterBackend(backend?: ThreeVfxClusterBackend): void {
    if (this.cluster && backend && this.cluster !== backend)
      throw new Error("This scene already has a clustered backend.");
    this.cluster?.clear();
    this.cluster = backend;
    this.stats.supported = backend?.supported ?? false;
    this.stats.reason =
      backend?.reason ??
      "Clustered lighting requires native WebGPU. Use the small 0/2/4-light path.";
    this.setProfile(this.profile);
  }
  setProfile(profile: ThreeVfxLightProfile): void {
    if (profile.mode === "small") {
      this.setBudget(profile.maxLights);
      return;
    }
    this.profile = {
      mode: "clustered",
      maxLights: bounded(profile.maxLights, THREE_CLUSTER_LIMITS.lights),
      maxLightsPerCluster: bounded(
        profile.maxLightsPerCluster,
        THREE_CLUSTER_LIMITS.perCluster,
        1,
      ),
      totalSceneLights: bounded(
        profile.totalSceneLights,
        THREE_CLUSTER_LIMITS.lights,
      ),
    };
    this.stats.capacityClamped =
      this.profile.maxLights !== profile.maxLights ||
      this.profile.totalSceneLights !== profile.totalSceneLights ||
      this.profile.maxLightsPerCluster !== profile.maxLightsPerCluster;
    this.stats.requestedMode = "clustered";
    this.stats.requestedBudget = this.profile.maxLights;
    this.stats.totalSceneCapacity = this.profile.totalSceneLights;
    this.stats.perClusterCapacity = this.profile.maxLightsPerCluster;
    this.stats.mode = this.cluster?.supported ? "clustered" : "small";
    this.profileChanged = true;
    if (this.stats.mode === "clustered") {
      for (const light of this.pool) light.removeFromParent();
    } else {
      this.configurePool(2);
    }
  }
  private readonly producers = new Map<
    VfxLightProducer & {
      getGpuLightSources?: () => readonly ThreeGpuLightSource[];
    },
    { revision: number; ids: Set<string> }
  >();
  private readonly selector = new VfxLightSelector();
  private readonly pool: PointLight[] = [];
  private readonly cameraPosition = new Vector3();
  private budget: ThreeVfxLightBudget;
  private snapNext = false;
  /** Rebuild immediately after an explicit seek/restart, including while paused. */
  reset(): void {
    this.selector.clear();
    this.snapNext = true;
    this.cluster?.clear();
    this.apply();
  }
  constructor(
    private readonly scene: Scene,
    budget: ThreeVfxLightBudget = 2,
  ) {
    if (managers.has(scene))
      throw new Error("Use the existing VFX light manager for this scene.");
    managers.set(scene, this);
    this.budget = budget;
    this.setBudget(budget);
  }
  static forScene(
    scene: Scene,
    budget: ThreeVfxLightBudget = 2,
  ): ThreeVfxLightManager {
    return managers.get(scene) ?? new ThreeVfxLightManager(scene, budget);
  }
  add(producer: VfxLightProducer): () => void {
    if (!this.producers.has(producer))
      this.producers.set(producer, {
        revision: producer.lightRevision,
        ids: new Set(),
      });
    return () => this.remove(producer);
  }
  remove(producer: VfxLightProducer): void {
    const state = this.producers.get(producer);
    if (state) this.selector.remove(state.ids);
    this.producers.delete(producer);
    this.cluster?.clear(); // Clear stale uploaded identities before the next host update.
    this.apply();
  }
  /** Host reserves game-light costs FIRST, then assigns this remaining VFX allowance. */
  setBudget(budget: ThreeVfxLightBudget): void {
    this.profile = { mode: "small", maxLights: budget };
    this.stats.mode = this.stats.requestedMode = "small";
    this.stats.capacityClamped = false;
    this.stats.reason =
      this.cluster?.reason ??
      "Clustered lighting requires native WebGPU. Use the small 0/2/4-light path.";
    this.stats.requestedBudget = budget;
    this.stats.totalSceneCapacity = this.stats.perClusterCapacity = 0;
    this.cluster?.clear();
    this.configurePool(budget);
  }
  private configurePool(budget: ThreeVfxLightBudget): void {
    const nextBudget = budget === 4 ? 4 : budget === 2 ? 2 : 0;
    if (nextBudget !== this.budget) this.snapNext = true;
    this.budget = nextBudget;
    this.stats.budget = this.budget;
    this.selector.slots.length = Math.min(
      this.selector.slots.length,
      this.budget,
    );
    while (this.pool.length < this.budget) {
      const light = new PointLight(0xffffff, 0, 1, 2);
      light.name = "NixieFX pooled light";
      light.castShadow = false;
      this.pool.push(light);
    }
    // Stable attached pool size avoids shader recompilation as candidates change.
    for (let i = 0; i < this.pool.length; i++) {
      if (i < this.budget) this.scene.add(this.pool[i]!);
      else this.pool[i]!.removeFromParent();
    }
    this.apply();
  }
  update(dt: number, camera: Camera): void {
    const candidates: VfxLightCandidate[] = [];
    this.stats.invalidRanges =
      this.stats.invalidCandidates =
      this.stats.frustumCulled =
        0;
    this.stats.candidates = 0;
    const clustered = this.stats.mode === "clustered";
    camera.updateWorldMatrix(true, false);
    this.projectionView.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(
      this.projectionView,
      camera.coordinateSystem,
    );
    const owned = new Set(this.pool);
    this.stats.sceneLights = 0;
    this.scene.traverseVisible((object) => {
      if ((object as Light).isLight && !owned.has(object as PointLight))
        this.stats.sceneLights++;
    });
    const allowance =
      clustered && this.profile.mode === "clustered"
        ? Math.min(
            this.profile.maxLights,
            Math.max(0, this.profile.totalSceneLights - this.stats.sceneLights),
          )
        : this.budget;
    this.stats.budget = allowance;
    this.stats.budgetReduction = Math.max(
      0,
      this.stats.requestedBudget - allowance,
    );
    let discontinuity = this.snapNext;
    this.snapNext = false;
    const frozen = new Set<string>();
    for (const [producer, state] of this.producers) {
      const next = producer.getLightCandidates();
      const ids = new Set(next.map((c) => c.id));
      // Explicit hiding, removal and seek release immediately; particle deaths may fade in-place.
      if (producer.lightRevision !== state.revision || next.length === 0)
        this.selector.remove(state.ids);
      discontinuity ||= producer.lightRevision !== state.revision;
      state.revision = producer.lightRevision;
      state.ids = new Set([
        ...ids,
        ...this.selector.slots
          .map((s) => s.candidate.id)
          .filter((id) => state.ids.has(id)),
      ]);
      if (producer.lightsPaused) for (const id of ids) frozen.add(id);
      this.stats.candidates += next.length;
      this.stats.invalidRanges +=
        producer.lightCandidateStats?.invalidRanges ?? 0;
      for (const candidate of next) {
        if (!Number.isFinite(candidate.radius) || candidate.radius <= 0) {
          this.stats.invalidRanges++;
          continue;
        }
        if (
          !Number.isFinite(candidate.intensity) ||
          candidate.intensity <= 0 ||
          !candidate.position.every(Number.isFinite) ||
          !candidate.color.every(Number.isFinite)
        ) {
          this.stats.invalidCandidates++;
          continue;
        }
        if (clustered) {
          this.sphere.center.fromArray(candidate.position);
          this.sphere.radius = candidate.radius;
          if (!this.frustum.intersectsSphere(this.sphere)) {
            this.stats.frustumCulled++;
            continue;
          }
        }
        candidates.push(candidate);
      }
    }
    const sources = [...this.producers.keys()].flatMap(
      (p) => p.getGpuLightSources?.() ?? [],
    );
    const allocations: ThreeGpuLightAllocation[] = [];
    let reserved = 0;
    // Preserve CPU importance selection; GPU sources share the remaining host
    // allowance in registration order. Reservation is bounded, independent of density.
    const gpuAllowance = clustered
      ? Math.max(0, allowance - Math.min(candidates.length, allowance))
      : 0;
    for (const source of sources) {
      const count = Math.min(source.requestedLights, gpuAllowance - reserved);
      if (count > 0) allocations.push({ source, offset: reserved, count });
      reserved += Math.max(0, count);
    }
    this.stats.candidates += sources.reduce((n, s) => n + s.requestedLights, 0);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.selector.update(
      candidates,
      allowance - reserved,
      discontinuity || (this.profileChanged && dt === 0)
        ? this.selector.fadeSeconds
        : dt,
      this.cameraPosition.toArray(),
      frozen,
    );
    this.profileChanged = false;
    this.stats.budgetRejected = Math.max(
      0,
      candidates.length +
        sources.reduce((n, source) => n + source.requestedLights, 0) -
        allowance,
    );
    this.stats.fading = this.selector.slots.filter(
      (slot) => slot.retiring || slot.gain < 1,
    ).length;
    this.apply();
    this.stats.overflowClusters =
      this.stats.overflowAssignments =
      this.stats.overflowLights =
        0;
    this.stats.maxOccupancy = this.stats.contributingLights = 0;
    if (clustered && this.cluster) {
      const valid = this.cluster.update(
        this.selector.slots,
        camera,
        this.stats.perClusterCapacity,
        allocations,
      );
      Object.assign(this.stats, this.cluster.stats);
      this.stats.active += this.cluster.stats.gpuReservedLights ?? reserved;
      this.stats.budgetRejected += this.cluster.stats.gpuRejectedLights ?? 0;
      this.stats.reason = valid
        ? ""
        : "Clustered lighting needs a finite perspective or orthographic camera. Select the small path.";
    }
    if (sources.length && !clustered)
      this.stats.reason =
        "GPU particle lights require the clustered WebGPU profile; no CPU readback fallback.";
  }

  private apply(): void {
    this.stats.active = this.selector.slots.length;
    this.pool.forEach((light, index) => {
      const slot =
        this.stats.mode === "small" && index < this.budget
          ? this.selector.slots[index]
          : undefined;
      light.intensity = slot ? slot.candidate.intensity * slot.gain : 0;
      if (!slot) return;
      light.position.fromArray(slot.candidate.position);
      light.color.setRGB(...slot.candidate.color);
      light.distance = slot.candidate.radius;
    });
  }
  dispose(): void {
    for (const light of this.pool) {
      light.removeFromParent();
      light.dispose();
    }
    this.pool.length = 0;
    this.producers.clear();
    this.selector.clear();
    this.stats.active = this.stats.candidates = 0;
    this.cluster?.clear();
    this.cluster = undefined;
    managers.delete(this.scene);
  }
}
