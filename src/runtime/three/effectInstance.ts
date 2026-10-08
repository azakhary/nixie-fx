import { BufferGeometry, Group, type Camera } from "three";
import type { Vec3 } from "../../engine/math";
import {
  ParticleEffectRunner,
  compileParticleScalarValue,
  normalizeParticleGradient,
  normalizeParticleScalarValue,
  type ParticleBurstEmitOptions,
  type ParticleEffectDefinition,
  type ParticleEffectRuntimeParameterPatch,
} from "../../engine/particles";
import { type VfxEffectInstance, type VfxWorldTransform } from "../backends";
import { collectThreeBackendSupport } from "../support";
import { threeGeometryToEmissionInput } from "./emissionGeometry";
import { clearThreeTrailView } from "./trailGeometry";
import type {
  ThreeVfxEffectInstanceOptions,
  ThreeVfxEffectStats,
  ThreeVfxEmitterRuntimeParameterPatch,
  ThreeVfxParticleDebugTransform,
} from "./types";

import { ThreeEmitterDrawer } from "./emitterDraw";
import {
  createEmitterView,
  destroyEmitterView,
  emitterStaticViewKey,
  hideViewMeshes,
} from "./emitterView";
import { normalizeThreeVfxEffect } from "./normalizeEffect";
import type {
  ThreeEmitterDrawParameters,
  ThreeEmitterView,
  ThreeViewBuildContext,
} from "./rendererState";
import {
  clamp,
  clampTintChannel,
  copyVec3,
  createEmptyEffectStats,
  normalizeSeed,
  updateEmitterLayerRanks,
} from "./rendererUtils";
const FIXED_SEEK_STEP_SECONDS = 1 / 60;
export class ThreeVfxEffectInstance implements VfxEffectInstance {
  readonly root = new Group();
  readonly stats: ThreeVfxEffectStats = createEmptyEffectStats();

  private effect: ParticleEffectDefinition;
  private readonly runner: ParticleEffectRunner;
  private readonly emitterViews: ThreeEmitterView[] = [];
  private readonly debugTransforms: ThreeVfxParticleDebugTransform[] = [];
  private readonly emitterLayerRanks: number[] = [];
  private readonly position: Vec3;
  private seed: number;
  private timeSeconds: number;
  private paused = false;
  private destroyed = false;
  private visible = true;
  private readonly captureDebugTransforms: boolean;
  private renderOrder = 0;
  private camera: Camera;
  private previewBloomEnabled: boolean;
  private previewBloomThreshold: number;
  private previewExposureStops: number;

  /** Host-injected emission geometry, taking precedence over meshProvider. */
  private readonly emissionOverrides = new Map<string, BufferGeometry>();
  /** Host-injected render geometry for meshAsset emitters (view-rebuilding). */
  private readonly renderGeometryOverrides = new Map<
    string,
    { geometry: BufferGeometry; generation: number }
  >();
  private renderGeometryGeneration = 0;
  /** Draw-time per-emitter host parameters (size multiplier, color tint). */
  private readonly emitterDrawParameters = new Map<
    string,
    ThreeEmitterDrawParameters
  >();
  /**
   * Last emission source processed per emitter (identity comparison), so the
   * per-frame sync only re-adapts when the provider/override actually swaps
   * the geometry object.
   */
  private readonly emissionBoundSources = new Map<
    string,
    BufferGeometry | null
  >();
  private readonly drawer: ThreeEmitterDrawer;

  constructor(private readonly options: ThreeVfxEffectInstanceOptions) {
    // Getters retain live host state without allocating a context every frame.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const owner = this;
    this.drawer = new ThreeEmitterDrawer({
      get root() {
        return owner.root;
      },
      get runner() {
        return owner.runner;
      },
      get position() {
        return owner.position;
      },
      get camera() {
        return owner.camera;
      },
      get emitterDrawParameters() {
        return owner.emitterDrawParameters;
      },
      get renderOrder() {
        return owner.renderOrder;
      },
      get emitterLayerRanks() {
        return owner.emitterLayerRanks;
      },
      get captureDebugTransforms() {
        return owner.captureDebugTransforms;
      },
      get debugTransforms() {
        return owner.debugTransforms;
      },
      get previewBloomEnabled() {
        return owner.previewBloomEnabled;
      },
      get previewBloomThreshold() {
        return owner.previewBloomThreshold;
      },
      get previewExposureStops() {
        return owner.previewExposureStops;
      },
      get renderGeometryOverrides() {
        return owner.renderGeometryOverrides;
      },
      get options() {
        return owner.options;
      },
    });
    this.effect = normalizeThreeVfxEffect(options.effect);
    this.camera = options.camera;
    this.runner = new ParticleEffectRunner(this.effect);
    this.position = copyVec3(options.position ?? [0, 0, 0]);
    this.captureDebugTransforms = options.captureDebugTransforms !== false;
    this.seed = normalizeSeed(options.seed);
    this.timeSeconds = Math.max(0, options.timeSeconds ?? 0);
    this.previewBloomThreshold = Math.max(
      0,
      options.previewBloomThreshold ?? 1,
    );
    this.previewBloomEnabled = options.previewBloomEnabled === true;
    this.previewExposureStops = clamp(options.previewExposureStops ?? 0, -2, 2);
    this.runner.setRuntimeParameters(options.runtimeParameters ?? {});
    this.syncEmissionGeometries();
    this.setTransform({
      position: this.position,
      rotation: options.rotation,
      scale: options.scale,
    });
    if (options.autoStart !== false) {
      this.play();
    }
  }

  get isActive(): boolean {
    return this.runner.isActive;
  }

  play(): void {
    if (this.destroyed) return;
    this.paused = false;
    if (!this.runner.isActive) {
      this.runner.reset(
        this.effect,
        this.position,
        this.timeSeconds,
        this.seed,
      );
    } else {
      this.runner.resumeEmission();
    }
    this.draw(this.timeSeconds);
  }

  pause(): void {
    this.paused = true;
  }

  stop(): void {
    this.runner.stop();
    this.clearViews();
    this.syncStats(0, 0, 0, 0, 0);
  }

  allowCompletion(): void {
    this.runner.allowCompletion();
  }

  setRuntimeParameters(parameters: ParticleEffectRuntimeParameterPatch): void {
    this.runner.setRuntimeParameters(parameters);
  }

  setRenderOrder(renderOrder: number): void {
    this.renderOrder = Number.isFinite(renderOrder) ? renderOrder : 0;
    this.root.renderOrder = this.renderOrder;
    for (let i = 0; i < this.emitterViews.length; i++) {
      const view = this.emitterViews[i];
      if (!view) continue;
      const emitterOrder = this.emitterLayerRanks[i] ?? i;
      view.instanced?.setRenderOrder(this.renderOrder + emitterOrder);
      view.trailMesh.renderOrder = this.renderOrder + emitterOrder;
    }
  }

  seek(timeSeconds: number): void {
    if (this.destroyed) return;
    const target = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0);
    // A reset reuses particle seeds/timestamps; old trails must not join the
    // new run or survive a backwards seek.
    for (const view of this.emitterViews) if (view) clearThreeTrailView(view);
    this.timeSeconds = 0;
    this.runner.reset(this.effect, this.position, 0, this.seed);
    let cursor = 0;
    while (cursor < target) {
      const dt = Math.min(FIXED_SEEK_STEP_SECONDS, target - cursor);
      cursor += dt;
      this.runner.update(dt, cursor);
    }
    this.timeSeconds = target;
    this.draw(target);
  }

  update(deltaSeconds: number): void {
    if (this.destroyed || this.paused) return;
    const dt = Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
    this.timeSeconds += dt;
    this.syncEmissionGeometries();
    if (dt > 0) {
      this.runner.update(dt, this.timeSeconds);
    }
    this.draw(this.timeSeconds);
  }

  /**
   * Merges emitter-scoped runtime parameters. Emission-rate and
   * initial-velocity multipliers reach the shared engine runner; size
   * multiplier (scalar and over-lifetime value) plus color tint / gradient
   * override apply at draw time. Identity values (1 / [1,1,1,1] / null)
   * restore authored behavior.
   */
  setEmitterRuntimeParameters(
    emitterId: string,
    parameters: ThreeVfxEmitterRuntimeParameterPatch,
  ): void {
    if (this.destroyed) return;
    const {
      sizeMultiplier,
      colorTint,
      sizeMultiplierValue,
      colorOverLifetimeGradient,
      ...engineParameters
    } = parameters;
    if (
      engineParameters.emissionRateMultiplier !== undefined ||
      engineParameters.initialVelocityMultiplier !== undefined
    ) {
      this.runner.setEmitterRuntimeParameters(emitterId, engineParameters);
    }
    if (
      sizeMultiplier === undefined &&
      colorTint === undefined &&
      sizeMultiplierValue === undefined &&
      colorOverLifetimeGradient === undefined
    ) {
      return;
    }
    const current = this.emitterDrawParameters.get(emitterId) ?? {
      sizeMultiplier: 1,
      colorTint: [1, 1, 1, 1] as [number, number, number, number],
      sizeMultiplierValue: null,
      colorOverLifetimeGradient: null,
    };
    if (sizeMultiplier !== undefined) {
      current.sizeMultiplier = Number.isFinite(sizeMultiplier)
        ? Math.max(0, sizeMultiplier)
        : 1;
    }
    if (colorTint !== undefined) {
      current.colorTint = [
        clampTintChannel(colorTint[0]),
        clampTintChannel(colorTint[1]),
        clampTintChannel(colorTint[2]),
        clampTintChannel(colorTint[3]),
      ];
    }
    if (sizeMultiplierValue !== undefined) {
      current.sizeMultiplierValue = sizeMultiplierValue
        ? compileParticleScalarValue(
            normalizeParticleScalarValue(sizeMultiplierValue, 1, 0, 100),
          )
        : null;
    }
    if (colorOverLifetimeGradient !== undefined) {
      current.colorOverLifetimeGradient = colorOverLifetimeGradient
        ? normalizeParticleGradient(
            colorOverLifetimeGradient,
            [1, 1, 1, 1],
            [1, 1, 1, 1],
          )
        : null;
    }
    this.emitterDrawParameters.set(emitterId, current);
  }

  /**
   * Emits an immediate burst from one emitter (capacity-clamped; returns the
   * emitted count). If the effect already completed, it is restarted first so
   * the burst always lands — the way hosts trigger moments like "the digit
   * changed" without authoring burst schedules around wall-clock time.
   */
  emitBurst(emitterId: string, options: ParticleBurstEmitOptions = {}): number {
    if (this.destroyed) return 0;
    this.paused = false;
    if (!this.runner.isActive) this.play();
    this.syncEmissionGeometries();
    return this.runner.emitBurst(emitterId, options);
  }

  /** Rewinds to t=0 and plays — one call for "run the one-shot again". */
  restart(): void {
    if (this.destroyed) return;
    this.paused = false;
    this.seek(0);
  }

  /**
   * Injects live geometry for a meshAsset-rendered emitter (each particle
   * renders as a copy of it), overriding the authored mesh.asset — or
   * supplying one when no asset is authored. Passing null returns to the
   * provider/asset. Rebuilds that emitter's view (the swap is intentional and
   * identity-keyed, so mutating a bound geometry requires re-injecting it).
   */
  setRenderGeometry(emitterId: string, geometry: BufferGeometry | null): void {
    if (this.destroyed) return;
    if (geometry) {
      this.renderGeometryOverrides.set(emitterId, {
        geometry,
        generation: ++this.renderGeometryGeneration,
      });
    } else {
      if (!this.renderGeometryOverrides.has(emitterId)) return;
      this.renderGeometryOverrides.delete(emitterId);
    }
    this.ensureViews();
  }

  /**
   * Injects live geometry as the emission source for a "mesh"-shaped emitter,
   * overriding the authored spawn.meshAsset. Passing null returns the emitter
   * to provider/asset-driven emission. The geometry is copied on bind; later
   * mutations require calling this again with the (new) geometry object.
   */
  setEmissionGeometry(
    emitterId: string,
    geometry: BufferGeometry | null,
  ): void {
    if (this.destroyed) return;
    if (geometry) this.emissionOverrides.set(emitterId, geometry);
    else this.emissionOverrides.delete(emitterId);
    this.emissionBoundSources.delete(emitterId);
    this.syncEmissionGeometries();
  }

  /**
   * Keeps the runner's emission bindings in step with host overrides and the
   * mesh provider. Runs per frame: identity checks make the steady state
   * cheap, while provider lookups double as load triggers for editor-style
   * async mesh providers.
   */
  private syncEmissionGeometries(): void {
    for (const emitter of this.effect.emitters) {
      if (emitter.spawn.shape !== "mesh") continue;
      const override = this.emissionOverrides.get(emitter.id);
      const provided =
        !override && emitter.spawn.meshAsset
          ? (this.options.meshProvider?.getMeshGeometry(
              emitter.spawn.meshAsset,
            ) ?? null)
          : null;
      const source = override ?? provided;
      const previous = this.emissionBoundSources.get(emitter.id);
      if (previous === source && this.emissionBoundSources.has(emitter.id)) {
        continue;
      }
      const input = source ? threeGeometryToEmissionInput(source) : null;
      this.runner.setEmissionGeometry(emitter.id, input);
      this.emissionBoundSources.set(emitter.id, source);
    }
  }

  setTransform(transform: VfxWorldTransform): void {
    if (transform.position) {
      this.position[0] = transform.position[0];
      this.position[1] = transform.position[1];
      this.position[2] = transform.position[2];
      this.runner.setPosition(this.position);
      this.root.position.set(
        transform.position[0],
        transform.position[1],
        transform.position[2],
      );
    }
    if (transform.rotation) {
      this.root.rotation.set(
        transform.rotation[0],
        transform.rotation[1],
        transform.rotation[2],
      );
    }
    if (transform.scale) {
      this.root.scale.set(
        transform.scale[0],
        transform.scale[1],
        transform.scale[2],
      );
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.draw(this.timeSeconds);
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
    this.draw(this.timeSeconds);
  }

  updateDefinition(
    effect: unknown,
    options: { preserveViews?: boolean } = {},
  ): ParticleEffectDefinition {
    this.effect = normalizeThreeVfxEffect(effect);
    this.runner.updateDefinition(this.effect);
    // Re-resolve emission sources: the edited definition may have switched an
    // emitter's spawn shape or its emission mesh asset.
    this.emissionBoundSources.clear();
    this.syncEmissionGeometries();
    if (!options.preserveViews) {
      this.rebuildViews();
    }
    return this.effect;
  }

  getParticleDebugTransforms(
    out: ThreeVfxParticleDebugTransform[] = [],
  ): ThreeVfxParticleDebugTransform[] {
    out.push(...this.debugTransforms);
    return out;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.rebuildViews();
    this.root.removeFromParent();
  }

  private draw(timeSeconds: number): void {
    if (!this.visible) return;
    this.ensureViews();
    this.debugTransforms.length = 0;
    updateEmitterLayerRanks(
      this.runner.definition.emitters,
      this.emitterLayerRanks,
    );
    let visibleParticles = 0;
    let bloomSourceParticles = 0;
    let drawCalls = 0;
    let instancedDrawCalls = 0;
    let legacyParticleDrawCalls = 0;
    for (
      let emitterIndex = 0;
      emitterIndex < this.effect.emitters.length;
      emitterIndex++
    ) {
      const emitter = this.runner.definition.emitters[emitterIndex];
      const state = this.runner.states[emitterIndex];
      const view = this.emitterViews[emitterIndex];
      if (!emitter || !state || !view || !emitter.enabled) {
        if (view) {
          hideViewMeshes(view, 0);
          view.instanced?.commit(0);
          clearThreeTrailView(view);
          view.trailMesh.removeFromParent();
        }
        continue;
      }
      const drawResult = this.drawer.drawEmitter(
        view,
        emitter,
        state,
        emitterIndex,
        timeSeconds,
      );
      visibleParticles += drawResult.visibleParticles;
      bloomSourceParticles += drawResult.bloomSourceParticles;
      drawCalls += drawResult.drawCalls;
      instancedDrawCalls += drawResult.instancedDrawCalls;
      legacyParticleDrawCalls += drawResult.legacyParticleDrawCalls;
    }
    this.syncStats(
      visibleParticles,
      bloomSourceParticles,
      drawCalls,
      instancedDrawCalls,
      legacyParticleDrawCalls,
    );
  }

  private ensureViews(): void {
    for (let i = 0; i < this.effect.emitters.length; i++) {
      const emitter = this.effect.emitters[i]!;
      const context: ThreeViewBuildContext = {
        effect: this.effect,
        renderGeometryOverride:
          this.renderGeometryOverrides.get(emitter.id) ?? null,
      };
      const key = emitterStaticViewKey(emitter, this.options, context);
      if (this.emitterViews[i]?.staticKey === key) continue;
      if (this.emitterViews[i]) destroyEmitterView(this.emitterViews[i]!);
      const view = createEmitterView(emitter, this.options, context);
      this.emitterViews[i] = view;
      if (view.instanced) this.root.add(view.instanced.mesh);
    }
    while (this.emitterViews.length > this.effect.emitters.length) {
      const view = this.emitterViews.pop();
      if (view) destroyEmitterView(view);
    }
  }

  private rebuildViews(): void {
    for (const view of this.emitterViews) destroyEmitterView(view);
    this.emitterViews.length = 0;
  }

  private clearViews(): void {
    for (const view of this.emitterViews) {
      hideViewMeshes(view, 0);
      view.instanced?.commit(0);
    }
  }

  private syncStats(
    visibleParticles: number,
    bloomSourceParticles: number,
    drawCalls: number,
    instancedDrawCalls: number,
    legacyParticleDrawCalls: number,
  ): void {
    this.stats.activeParticles = this.runner.stats.activeParticles;
    this.stats.visibleParticles = visibleParticles;
    this.stats.capacity = this.runner.stats.capacity;
    this.stats.emittedLastFrame = this.runner.stats.emittedLastFrame;
    this.stats.bloomSourceParticles = bloomSourceParticles;
    this.stats.drawCalls = drawCalls;
    this.stats.instancedDrawCalls = instancedDrawCalls;
    this.stats.legacyParticleDrawCalls = legacyParticleDrawCalls;
    this.stats.missingMeshRefs = this.collectMissingMeshRefs();
    this.stats.missingMaterialRefs = this.collectMissingMaterialRefs();
    const materialUnsupported = this.emitterViews.flatMap(
      (view) => view.unsupportedFeatures,
    );
    this.stats.unsupportedFeatures = [
      ...collectThreeBackendSupport(this.effect).blockers.map(
        (blocker) => `${blocker.path}: ${blocker.message}`,
      ),
      ...materialUnsupported,
    ];
  }

  private collectMissingMeshRefs(): ThreeVfxEffectStats["missingMeshRefs"] {
    const missing: ThreeVfxEffectStats["missingMeshRefs"] = [];
    for (const emitter of this.effect.emitters) {
      if (emitter.mode === "mesh" && emitter.mesh.renderMode === "meshAsset") {
        if (
          emitter.mesh.asset &&
          !this.renderGeometryOverrides.has(emitter.id) &&
          !this.options.meshProvider?.getMeshGeometry(emitter.mesh.asset)
        ) {
          missing.push(emitter.mesh.asset);
        }
      }
      if (
        emitter.spawn.shape === "mesh" &&
        emitter.spawn.meshAsset &&
        !this.emissionOverrides.has(emitter.id) &&
        !this.options.meshProvider?.getMeshGeometry(emitter.spawn.meshAsset)
      ) {
        missing.push(emitter.spawn.meshAsset);
      }
    }
    return missing;
  }

  private collectMissingMaterialRefs(): ThreeVfxEffectStats["missingMaterialRefs"] {
    const missing = new Set<string>();
    for (const view of this.emitterViews) {
      if (view.missingMaterialRef) missing.add(view.missingMaterialRef);
      if (view.trailResolution?.missingMaterialRef)
        missing.add(view.trailResolution.missingMaterialRef);
    }
    return [...missing];
  }
}
