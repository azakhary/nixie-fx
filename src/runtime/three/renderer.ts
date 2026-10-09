import { Group, type Camera, type Object3D, type Scene } from "three";
import { type ParticleEffectDefinition } from "../../engine/particles";
import {
  THREE_3D_BACKEND_CAPABILITIES,
  type VfxBackendSupportReport,
  type VfxEffectOptions,
  type VfxRendererBackend,
} from "../backends";
import { collectThreeBackendSupport } from "../support";
import type { ThreeVfxRendererOptions, ThreeVfxRendererStats } from "./types";

import { ThreeVfxEffectInstance } from "./effectInstance";
import { clamp, createEmptyEffectStats } from "./rendererUtils";
export { ThreeVfxEffectInstance } from "./effectInstance";
export { normalizeThreeVfxEffect } from "./normalizeEffect";
export { updateInstancedParticleOrder } from "./rendererUtils";
export class ThreeVfxRenderer implements VfxRendererBackend<Object3D | Scene> {
  readonly backendId = "three3d" as const;
  readonly capabilities = THREE_3D_BACKEND_CAPABILITIES;
  readonly root = new Group();
  readonly stats: ThreeVfxRendererStats = {
    ...createEmptyEffectStats(),
    effectCount: 0,
  };

  private readonly instances = new Set<ThreeVfxEffectInstance>();
  private camera: Camera;
  private previewBloomEnabled: boolean;
  private previewBloomThreshold: number;
  private previewExposureStops: number;
  private destroyed = false;

  constructor(private readonly options: ThreeVfxRendererOptions) {
    this.camera = options.camera;
    this.previewBloomThreshold = Math.max(
      0,
      options.previewBloomThreshold ?? 1,
    );
    this.previewBloomEnabled = options.previewBloomEnabled === true;
    this.previewExposureStops = clamp(options.previewExposureStops ?? 0, -2, 2);
    const parent = options.parent ?? options.scene;
    if (parent) this.mount(parent);
  }

  mount(container: Object3D | Scene): void {
    if (this.root.parent !== container) container.add(this.root);
  }

  unmount(): void {
    this.root.removeFromParent();
  }

  createEffect(
    effect: unknown,
    options: VfxEffectOptions = {},
  ): ThreeVfxEffectInstance {
    if (this.destroyed) throw new Error("ThreeVfxRenderer is destroyed.");
    const instance = new ThreeVfxEffectInstance({
      effect,
      renderAdapter: this.options.renderAdapter,
      camera: this.camera,
      textureProvider: this.options.textureProvider,
      meshProvider: this.options.meshProvider,
      materialProvider: this.options.materialProvider,
      materialGraphProvider: this.options.materialGraphProvider,
      position: options.position,
      rotation: options.rotation,
      scale: options.scale,
      seed: options.seed,
      timeSeconds: options.timeSeconds,
      autoStart: options.autoStart,
      runtimeParameters: options.runtimeParameters,
      previewBloomEnabled: this.previewBloomEnabled,
      previewBloomThreshold: this.previewBloomThreshold,
      previewExposureStops: this.previewExposureStops,
      captureDebugTransforms: this.options.captureDebugTransforms,
    });
    this.instances.add(instance);
    this.root.add(instance.root);
    this.refreshStats();
    return instance;
  }

  removeEffect(instance: ThreeVfxEffectInstance, destroy = true): void {
    if (!this.instances.delete(instance)) return;
    this.root.remove(instance.root);
    if (destroy) instance.destroy();
    this.refreshStats();
  }

  update(deltaSeconds: number): void {
    for (const instance of this.instances) instance.update(deltaSeconds);
    this.refreshStats();
  }

  getSupport(effect: ParticleEffectDefinition): VfxBackendSupportReport {
    return collectThreeBackendSupport(effect);
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    for (const instance of this.instances) instance.setCamera(camera);
  }

  setPreviewBloomOptions(options: {
    enabled?: boolean;
    threshold?: number;
    exposureStops?: number;
  }): void {
    if (typeof options.enabled === "boolean") {
      this.previewBloomEnabled = options.enabled;
    }
    this.previewBloomThreshold = Math.max(
      0,
      options.threshold ?? this.previewBloomThreshold,
    );
    this.previewExposureStops = clamp(
      options.exposureStops ?? this.previewExposureStops,
      -2,
      2,
    );
    for (const instance of this.instances) {
      instance.setPreviewBloomOptions({
        enabled: this.previewBloomEnabled,
        threshold: this.previewBloomThreshold,
        exposureStops: this.previewExposureStops,
      });
    }
    this.refreshStats();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const instance of [...this.instances])
      this.removeEffect(instance, true);
    this.unmount();
  }

  private refreshStats(): void {
    const aggregate = createEmptyEffectStats();
    for (const instance of this.instances) {
      aggregate.activeParticles += instance.stats.activeParticles;
      aggregate.visibleParticles += instance.stats.visibleParticles;
      aggregate.capacity += instance.stats.capacity;
      aggregate.emittedLastFrame += instance.stats.emittedLastFrame;
      aggregate.bloomSourceParticles += instance.stats.bloomSourceParticles;
      aggregate.drawCalls += instance.stats.drawCalls;
      aggregate.instancedDrawCalls += instance.stats.instancedDrawCalls;
      aggregate.legacyParticleDrawCalls +=
        instance.stats.legacyParticleDrawCalls;
      aggregate.missingMeshRefs.push(...instance.stats.missingMeshRefs);
      aggregate.missingMaterialRefs.push(...instance.stats.missingMaterialRefs);
      aggregate.unsupportedFeatures.push(...instance.stats.unsupportedFeatures);
    }
    Object.assign(this.stats, aggregate, { effectCount: this.instances.size });
  }
}
