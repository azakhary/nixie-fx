import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  ShaderMaterial,
  Texture,
  Vector3,
  type Camera,
  type Object3D,
  type Scene,
} from "three";
import type { Vec3 } from "../../engine/math";
import {
  PARTICLE_INSTANCE_STRIDE,
  PARTICLE_RUNTIME_VECTOR_STRIDE,
  ParticleEffectRunner,
  compileParticleScalarValue,
  normalizeParticleEffect,
  normalizeParticleGradient,
  normalizeParticleScalarValue,
  sampleCompiledParticleScalar,
  sampleInitialParticleColorInto,
  sampleParticleGradientAlpha,
  sampleParticleGradientColor,
  sampleParticleMotion,
  sampleParticleScalarValue,
  resolveParticleDepthWrite,
  type CompiledParticleScalarValue,
  type ParticleBurstEmitOptions,
  type ParticleColorGradientSettings,
  type ParticleEffectDefinition,
  type ParticleEffectRuntimeParameterPatch,
  type ParticleEmitterDefinition,
  type ParticleEmitterRuntimeState,
  type ParticleMotionResult,
} from "../../engine/particles";
import {
  applyCollisionResponse,
  applyPositionalMotionModules,
  computeEffectiveAlignmentVelocity,
  particleRotationBySpeedOffset,
  particleSizeBySpeedMultiplier,
  sampleParticleModuleColor,
  type ParticleMotionSample,
} from "../modules";
import {
  THREE_3D_BACKEND_CAPABILITIES,
  type VfxBackendSupportReport,
  type VfxEffectInstance,
  type VfxEffectOptions,
  type VfxRendererBackend,
  type VfxWorldTransform,
} from "../backends";
import { collectThreeBackendSupport } from "../support";
import { threeGeometryToEmissionInput } from "./emissionGeometry";
import type { MaterialFixedDescriptor } from "../materials/artifact";
import {
  materialBlendOverridesEmitter,
  resolveEffectiveParticleBlend,
  type MaterialBlend,
} from "../schema/materials";
import {
  createThreeEmitterMaterial,
  emitterTexturePath,
  isThreeParticleMaterial,
  threeBlendingForEffectiveBlend,
  type ThreeParticleMaterial,
} from "./materialAdapter";
import {
  applyThreeShaderTextureFrame,
  applyThreeTextureFrame,
  createThreeTextureFrameSet,
  selectThreeTextureFrameIndex,
  type ThreeTextureFrameSet,
} from "./textureFrames";
import { reverseGeometryWinding } from "./geometryWinding";
import {
  encodePreviewBloomHdrColor,
  toneMapPreviewHdrColorInto,
} from "./hdrColor";
import {
  canUseInstancedBillboard,
  ThreeInstancedBillboardView,
} from "./instancedBillboard";
import type {
  ThreeVfxEffectInstanceOptions,
  ThreeVfxEffectStats,
  ThreeVfxEmitterRuntimeParameterPatch,
  ThreeVfxParticleDebugTransform,
  ThreeVfxRendererOptions,
  ThreeVfxRendererStats,
} from "./types";

const DEFAULT_SEED = 0x7f4a7c15;
const FIXED_SEEK_STEP_SECONDS = 1 / 60;
const BASE_QUAD_GEOMETRY = new PlaneGeometry(1, 1);
const DEFAULT_NORMAL = new Vector3(0, 0, 1);
const DEFAULT_UP = new Vector3(0, 1, 0);

interface ThreeEmitterDrawParameters {
  sizeMultiplier: number;
  colorTint: [number, number, number, number];
  /** Compiled on set so per-particle sampling is a LUT read (no allocation). */
  sizeMultiplierValue: CompiledParticleScalarValue | null;
  colorOverLifetimeGradient: ParticleColorGradientSettings | null;
}

interface ThreeEmitterView {
  meshes: Mesh[];
  instanced: ThreeInstancedBillboardView | null;
  particleOrder: Uint32Array;
  material: ThreeParticleMaterial;
  geometry: BufferGeometry;
  ownedGeometry: BufferGeometry | null;
  pivotBoundsSize: Vec3;
  debugBounds: { min: Vec3; max: Vec3 };
  trailMesh: Mesh;
  trailGeometry: BufferGeometry;
  trailMaterial: MeshBasicMaterial;
  trailHistories: Map<string, ThreeTrailHistory>;
  trailEmitterPosition: Vec3;
  ownedTextures: Texture[];
  textureFrames: ThreeTextureFrameSet;
  materialFixed: MaterialFixedDescriptor | null;
  materialParticleColorUsage: { rgb: boolean; alpha: boolean };
  materialOpacityIsConstantOne: boolean;
  materialBlend: MaterialBlend | null;
  missingMaterialRef: string | null;
  unsupportedFeatures: string[];
  /** True when view.material is host-owned (materialProvider) — never disposed here. */
  hostMaterial: boolean;
  key: string;
  staticKey: string;
}

/** Per-view host state threaded into view construction and its cache key. */
interface ThreeViewBuildContext {
  effect: ParticleEffectDefinition;
  renderGeometryOverride: {
    geometry: BufferGeometry;
    generation: number;
  } | null;
}

interface ThreeTrailPoint {
  position: Vector3;
  timeSeconds: number;
  lifetimeSeconds: number;
  distanceFromHead: number;
  color: [number, number, number];
  alpha: number;
  width: number;
  maxLength?: number;
  seed: number;
}

interface ThreeTrailHistory {
  points: ThreeTrailPoint[];
  lastSeenFrame: number;
}

interface ParticleSample {
  visible: boolean;
  position: Vec3;
  velocity: Vec3;
  speed: number;
  normalizedAge: number;
  loopAge: number;
  start: number;
  seed: number;
  width: number;
  height: number;
  depthScale: number;
  depth: number;
  rotation: Vec3;
  color: Color;
  shaderColor: Vec3;
  alpha: number;
  alignmentAxis: Vector3;
  normal: Vector3;
  emissiveStrength: number;
  textureFrameIndex: number;
}

interface ThreeEmitterDrawResult {
  visibleParticles: number;
  bloomSourceParticles: number;
  drawCalls: number;
  instancedDrawCalls: number;
  legacyParticleDrawCalls: number;
}

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

  private readonly scratchWorld = new Vector3();
  private readonly scratchAlignmentAxis = new Vector3();
  private readonly scratchRight = new Vector3();
  private readonly scratchForward = new Vector3();
  private readonly scratchQuaternion = new Quaternion();
  private readonly scratchRollQuaternion = new Quaternion();
  private readonly scratchEuler = new Euler();
  private readonly scratchMatrix = new Matrix4();
  private readonly scratchBasisMatrix = new Matrix4();
  private readonly scratchPivotMatrix = new Matrix4();
  private readonly scratchScale = new Vector3();
  private readonly scratchColor = new Color();
  private readonly motionScratch: ParticleMotionResult = {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    scratchA: [0, 0, 0],
    scratchB: [0, 0, 0],
  };
  private readonly motionModuleScratch: ParticleMotionSample = {
    seed: 0,
    normalizedAge: 0,
    loopAge: 0,
    ageSeconds: 0,
    timeSeconds: 0,
    world: this.motionScratch.position,
    velocity: this.motionScratch.velocity,
  };
  private readonly sampleSizeScratch = { x: 1, y: 1, z: 1 };
  private readonly initialColorScratch: [number, number, number, number] = [
    1, 1, 1, 1,
  ];
  private readonly secondaryColorScratch: [number, number, number, number] = [
    1, 1, 1, 1,
  ];
  private readonly moduleColorScratch: [number, number, number, number] = [
    1, 1, 1, 1,
  ];
  private readonly hdrColorScratch: Vec3 = [1, 1, 1];
  private readonly renderColorScratch: Vec3 = [1, 1, 1];
  private readonly analyticVelocityScratch: Vec3 = [0, 0, 0];
  private readonly preCollisionWorldScratch: Vec3 = [0, 0, 0];
  private readonly effectiveAlignmentVelocity: Vec3 = [0, 0, 0];
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
  private readonly sampleScratch: ParticleSample = {
    visible: true,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    speed: 0,
    normalizedAge: 0,
    loopAge: 0,
    start: 0,
    seed: 0,
    width: 1,
    height: 1,
    depthScale: 1,
    depth: 0,
    rotation: [0, 0, 0],
    color: new Color(),
    shaderColor: [1, 1, 1],
    alpha: 1,
    alignmentAxis: new Vector3(),
    normal: new Vector3(),
    emissiveStrength: 0,
    textureFrameIndex: 0,
  };

  constructor(private readonly options: ThreeVfxEffectInstanceOptions) {
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
      const drawResult = this.drawEmitter(
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

  private drawEmitter(
    view: ThreeEmitterView,
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterIndex: number,
    timeSeconds: number,
  ): ThreeEmitterDrawResult {
    if (
      emitter.mode === "mesh" &&
      emitter.mesh.renderMode === "meshAsset" &&
      !this.renderGeometryOverrides.has(emitter.id) &&
      (!emitter.mesh.asset ||
        !this.options.meshProvider?.getMeshGeometry(emitter.mesh.asset))
    ) {
      hideViewMeshes(view, 0);
      view.instanced?.commit(0);
      clearThreeTrailView(view);
      view.trailMesh.removeFromParent();
      return emptyEmitterDrawResult();
    }
    const effectiveBlend = resolveEffectiveParticleBlend(
      emitter.render.blend,
      view.materialBlend,
    );
    const materialOwnsBlend = materialBlendOverridesEmitter(effectiveBlend);
    view.material.depthTest = emitter.render.depthTest;
    const depthWrite = materialOwnsBlend
      ? true
      : resolveParticleDepthWrite(emitter.render);
    const blending = threeBlendingForEffectiveBlend(effectiveBlend);
    const premultiplied = effectiveBlend === "premultiplied";
    view.material.depthWrite = depthWrite;
    view.material.blending = blending;
    view.material.premultipliedAlpha = premultiplied;
    view.instanced?.setRenderState(emitter);
    view.trailMaterial.depthTest = emitter.render.depthTest;
    view.trailMaterial.depthWrite = depthWrite;
    view.trailMaterial.blending = blending;
    view.trailMaterial.premultipliedAlpha = premultiplied;
    if (materialOwnsBlend) {
      view.material.transparent = false;
      view.trailMaterial.transparent = false;
    }
    applyThreeLocalSpaceTrailShift(view, emitter, this.position);

    let visibleCount = 0;
    let bloomSourceCount = 0;
    if (view.instanced) {
      updateInstancedParticleOrder(
        state,
        emitter.render.sortMode,
        view.particleOrder,
      );
    }
    for (let drawIndex = 0; drawIndex < state.activeCount; drawIndex++) {
      const particleIndex = view.instanced
        ? (view.particleOrder[drawIndex] ?? drawIndex)
        : drawIndex;
      const sample = this.sampleParticle(
        emitter,
        state,
        particleIndex,
        timeSeconds,
        view.materialFixed,
        view.materialParticleColorUsage,
      );
      if (!sample?.visible) continue;
      if (view.instanced) {
        this.applySampleToInstanced(
          view.instanced,
          sample,
          view,
          emitter,
          emitterIndex,
          particleIndex,
          visibleCount,
        );
      } else {
        const mesh = this.acquireMesh(view, visibleCount);
        this.applySampleToMesh(
          mesh,
          sample,
          view,
          emitter,
          emitterIndex,
          particleIndex,
          timeSeconds,
        );
      }
      visibleCount++;
      updateThreeTrailHistory(view, emitter, sample, timeSeconds);
      if (sample.emissiveStrength > this.previewBloomThreshold) {
        bloomSourceCount++;
      }
    }
    hideViewMeshes(view, visibleCount);
    view.instanced?.commit(visibleCount);
    view.instanced?.setRenderOrder(
      this.renderOrder + (this.emitterLayerRanks[emitterIndex] ?? emitterIndex),
    );
    let trailDrawCalls = 0;
    if (emitter.modules.trails) {
      if (!view.trailMesh.parent) this.root.add(view.trailMesh);
      view.trailMesh.renderOrder =
        this.renderOrder +
        (this.emitterLayerRanks[emitterIndex] ?? emitterIndex);
      drawThreeTrailView(view, emitter, this.camera, timeSeconds);
      trailDrawCalls = view.trailMesh.visible ? 1 : 0;
    } else {
      clearThreeTrailView(view);
      view.trailMesh.removeFromParent();
    }
    return {
      visibleParticles: visibleCount,
      bloomSourceParticles: bloomSourceCount,
      drawCalls:
        (visibleCount > 0 ? (view.instanced ? 1 : visibleCount) : 0) +
        trailDrawCalls,
      instancedDrawCalls: visibleCount > 0 && view.instanced ? 1 : 0,
      legacyParticleDrawCalls: view.instanced ? 0 : visibleCount,
    };
  }

  private sampleParticle(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    particleIndex: number,
    timeSeconds: number,
    materialFixed: MaterialFixedDescriptor | null,
    particleColorUsage: { rgb: boolean; alpha: boolean },
  ): ParticleSample | undefined {
    const data = state.instanceData;
    const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
    const start = data[offset + 3] ?? 0;
    const life = Math.max(0.001, data[offset + 7] ?? 0.001);
    const age = timeSeconds - start;
    const unclampedAge = age / life;
    if (unclampedAge < -0.000001 || unclampedAge > 1.000001) {
      return undefined;
    }
    const normalizedAge = clamp(unclampedAge, 0, 1);
    const ageSeconds = Math.max(0, age);
    const loopAge = clamp(state.age / Math.max(0.001, emitter.duration), 0, 1);
    const seed = data[offset + 8] ?? 0.5;
    const motion = sampleParticleMotion(
      emitter,
      state,
      particleIndex,
      ageSeconds,
      normalizedAge,
      this.position,
      this.motionScratch,
      this.runner.effectiveInitialVelocityMultiplier(emitter.id),
    );
    const velocity = motion.velocity;
    const world = motion.position;
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
    const alignToVelocity = emitter.render.alignAxis === "velocity";
    if (alignToVelocity) {
      this.analyticVelocityScratch[0] = velocity[0];
      this.analyticVelocityScratch[1] = velocity[1];
      this.analyticVelocityScratch[2] = velocity[2];
    }
    const motionModuleSample = this.motionModuleScratch;
    motionModuleSample.seed = seed;
    motionModuleSample.normalizedAge = normalizedAge;
    motionModuleSample.loopAge = loopAge;
    motionModuleSample.ageSeconds = ageSeconds;
    motionModuleSample.timeSeconds = timeSeconds;
    motionModuleSample.world = world;
    motionModuleSample.velocity = velocity;
    // Split module pass (was applyParticleMotionModulesToSample): the
    // PRE-collision displaced position feeds the effective-alignment forward
    // difference below, saving its second motion evaluation (I13-F contract:
    // collision excluded).
    applyPositionalMotionModules(emitter, motionModuleSample);
    if (alignToVelocity) {
      this.preCollisionWorldScratch[0] = world[0];
      this.preCollisionWorldScratch[1] = world[1];
      this.preCollisionWorldScratch[2] = world[2];
    }
    if (
      emitter.modules.collision &&
      !applyCollisionResponse(emitter, motionModuleSample)
    ) {
      return undefined;
    }

    const size = sampleParticleSize(
      emitter,
      state,
      particleIndex,
      normalizedAge,
      speed,
      seed,
      loopAge,
      this.sampleSizeScratch,
    );
    const rotationX =
      (data[offset + 13] ?? 0) + ageSeconds * (data[offset + 15] ?? 0);
    const rotationY =
      (data[offset + 14] ?? 0) + ageSeconds * (data[offset + 16] ?? 0);
    const rotationZ =
      (data[offset + 9] ?? 0) +
      ageSeconds * (data[offset + 10] ?? 0) +
      particleRotationBySpeedOffset(emitter, speed, ageSeconds, seed, loopAge);
    const initColor = sampleInitialParticleColorInto(
      emitter.initializeParticle.color,
      seed,
      normalizedAge,
      loopAge,
      this.initialColorScratch,
      this.secondaryColorScratch,
    );
    const intensity = Math.max(
      0,
      sampleParticleScalarValue(
        emitter.initializeParticle.color.intensity,
        normalizedAge,
        seed,
        loopAge,
      ),
    );
    const drawParameters = this.emitterDrawParameters.get(emitter.id);
    const overLife = drawParameters?.colorOverLifetimeGradient
      ? sampleGradientOverrideColor(
          drawParameters.colorOverLifetimeGradient,
          normalizedAge,
          this.moduleColorScratch,
        )
      : !emitter.modules.colorBySpeed && !emitter.modules.lights
        ? sampleSimpleParticleModuleColor(
            emitter,
            normalizedAge,
            this.moduleColorScratch,
          )
        : sampleParticleModuleColor(
            emitter,
            normalizedAge,
            speed,
            seed,
            undefined,
            loopAge,
          );
    const materialTint = materialFixed?.tint ?? [1, 1, 1, 1];
    const materialEmissive = materialFixed
      ? 1 + Math.max(0, materialFixed.emissive)
      : 1;
    const materialOpacity = materialFixed?.opacity ?? 1;
    const emitterR = particleColorUsage.rgb
      ? initColor[0] * intensity * overLife[0]
      : 1;
    const emitterG = particleColorUsage.rgb
      ? initColor[1] * intensity * overLife[1]
      : 1;
    const emitterB = particleColorUsage.rgb
      ? initColor[2] * intensity * overLife[2]
      : 1;
    const emitterA = particleColorUsage.alpha ? initColor[3] * overLife[3] : 1;
    const hdrColor = this.hdrColorScratch;
    hdrColor[0] = Math.max(0, emitterR * materialTint[0] * materialEmissive);
    hdrColor[1] = Math.max(0, emitterG * materialTint[1] * materialEmissive);
    hdrColor[2] = Math.max(0, emitterB * materialTint[2] * materialEmissive);
    const renderColor = this.previewBloomEnabled
      ? encodePreviewBloomHdrColor(
          hdrColor,
          this.previewBloomThreshold,
          this.previewExposureStops,
        )
      : toneMapPreviewHdrColorInto(
          hdrColor,
          this.previewExposureStops,
          this.renderColorScratch,
        );
    const color = this.scratchColor.setRGB(
      renderColor[0],
      renderColor[1],
      renderColor[2],
      SRGBColorSpace,
    );
    const alpha = clamp(emitterA * materialTint[3] * materialOpacity, 0, 1);
    let alignmentVelocity: Vec3 = velocity;
    let alignmentSpeed = speed;
    if (alignToVelocity) {
      const eff = computeEffectiveAlignmentVelocity(
        emitter,
        state,
        particleIndex,
        ageSeconds,
        life,
        timeSeconds,
        seed,
        loopAge,
        this.position,
        this.runner.effectiveInitialVelocityMultiplier(emitter.id),
        this.preCollisionWorldScratch,
        this.effectiveAlignmentVelocity,
      );
      // Compose I13-H's collision reflection (0 when not collided). `velocity` is
      // motion.velocity AFTER the module pass; analyticVelocityScratch is before it.
      eff[0] += velocity[0] - this.analyticVelocityScratch[0];
      eff[1] += velocity[1] - this.analyticVelocityScratch[1];
      eff[2] += velocity[2] - this.analyticVelocityScratch[2];
      alignmentVelocity = eff;
      alignmentSpeed = Math.hypot(eff[0], eff[1], eff[2]);
    }
    const alignmentAxis = this.resolveParticleAlignmentAxis(
      emitter,
      state,
      particleIndex,
      alignmentVelocity,
      alignmentSpeed,
    );

    const sample = this.sampleScratch;
    sample.visible = true;
    sample.position[0] = world[0];
    sample.position[1] = world[1];
    sample.position[2] = world[2];
    sample.velocity[0] = velocity[0];
    sample.velocity[1] = velocity[1];
    sample.velocity[2] = velocity[2];
    sample.speed = speed;
    sample.normalizedAge = normalizedAge;
    sample.loopAge = loopAge;
    sample.start = start;
    sample.seed = seed;
    sample.width = size.x;
    sample.height = size.y;
    sample.depthScale = size.z;
    sample.depth = world[2];
    sample.rotation[0] = rotationX;
    sample.rotation[1] = rotationY;
    sample.rotation[2] = rotationZ;
    sample.color.copy(color);
    sample.shaderColor[0] = renderColor[0];
    sample.shaderColor[1] = renderColor[1];
    sample.shaderColor[2] = renderColor[2];
    sample.alpha = alpha;
    sample.alignmentAxis.copy(alignmentAxis);
    sample.normal.copy(alignmentAxis);
    sample.emissiveStrength = Math.max(hdrColor[0], hdrColor[1], hdrColor[2]);
    sample.textureFrameIndex = selectThreeTextureFrameIndex(
      emitter,
      normalizedAge,
      seed,
      loopAge,
    );
    if (drawParameters) {
      let sizeScale = drawParameters.sizeMultiplier;
      if (drawParameters.sizeMultiplierValue) {
        sizeScale *= Math.max(
          0,
          sampleCompiledParticleScalar(
            drawParameters.sizeMultiplierValue,
            normalizedAge,
            seed,
          ),
        );
      }
      sample.width *= sizeScale;
      sample.height *= sizeScale;
      sample.depthScale *= sizeScale;
      const tint = drawParameters.colorTint;
      sample.color.r *= tint[0];
      sample.color.g *= tint[1];
      sample.color.b *= tint[2];
      sample.shaderColor[0] *= tint[0];
      sample.shaderColor[1] *= tint[1];
      sample.shaderColor[2] *= tint[2];
      sample.alpha *= tint[3];
    }
    return sample;
  }

  private resolveParticleAlignmentAxis(
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    particleIndex: number,
    velocity: Vec3,
    speed: number,
  ): Vector3 {
    const out = this.scratchAlignmentAxis;
    if (emitter.render.alignAxis === "screen") {
      out.copy(DEFAULT_UP).applyQuaternion(this.camera.quaternion);
      return normalizeOr(out, DEFAULT_UP);
    }
    if (emitter.render.alignAxis === "velocity") {
      out.set(velocity[0], velocity[1], velocity[2]);
      if (speed > 0.000001) return normalizeOr(out, DEFAULT_NORMAL);
      const offset = particleIndex * PARTICLE_RUNTIME_VECTOR_STRIDE;
      out.set(
        state.spawnDirectionData[offset + 0] ?? 0,
        state.spawnDirectionData[offset + 1] ?? 1,
        state.spawnDirectionData[offset + 2] ?? 0,
      );
      return normalizeOr(out, DEFAULT_NORMAL);
    }
    if (emitter.render.alignAxis === "spawnDirection") {
      const offset = particleIndex * PARTICLE_RUNTIME_VECTOR_STRIDE;
      out.set(
        state.spawnDirectionData[offset + 0] ?? 0,
        state.spawnDirectionData[offset + 1] ?? 1,
        state.spawnDirectionData[offset + 2] ?? 0,
      );
      return normalizeOr(out, DEFAULT_NORMAL);
    }
    out.set(
      emitter.render.alignmentVector[0],
      emitter.render.alignmentVector[1],
      emitter.render.alignmentVector[2],
    );
    return normalizeOr(out, DEFAULT_UP);
  }

  private applySampleOrientation(
    sample: ParticleSample,
    emitter: ParticleEmitterDefinition,
  ): void {
    if (
      emitter.render.alignAxis === "screen" &&
      emitter.render.facing === "cameraPlane"
    ) {
      this.scratchQuaternion.copy(this.camera.quaternion);
      this.camera.getWorldDirection(this.scratchForward);
      this.scratchForward.multiplyScalar(-1);
      sample.normal.copy(normalizeOr(this.scratchForward, DEFAULT_NORMAL));
      return;
    }

    const up = normalizeOr(
      this.scratchAlignmentAxis.copy(sample.alignmentAxis),
      DEFAULT_UP,
    );
    if (emitter.render.facing === "off") {
      this.scratchQuaternion.setFromUnitVectors(DEFAULT_NORMAL, up);
      sample.normal.copy(up);
      return;
    }

    if (emitter.render.facing === "cameraPosition") {
      this.scratchForward.set(
        this.camera.position.x - sample.position[0],
        this.camera.position.y - sample.position[1],
        this.camera.position.z - sample.position[2],
      );
    } else {
      this.camera.getWorldDirection(this.scratchForward);
      this.scratchForward.multiplyScalar(-1);
    }
    const forward = normalizeOr(this.scratchForward, DEFAULT_NORMAL);
    const right = this.scratchRight.crossVectors(up, forward);
    if (right.lengthSq() <= 0.000001) {
      perpendicularUnitVector(up, right);
      forward.crossVectors(right, up);
    } else {
      right.normalize();
      forward.crossVectors(right, up);
    }
    normalizeOr(forward, DEFAULT_NORMAL);
    this.scratchBasisMatrix.makeBasis(right, up, forward);
    this.scratchQuaternion.setFromRotationMatrix(this.scratchBasisMatrix);
    sample.normal.copy(forward);
  }

  private applySampleToMesh(
    mesh: Mesh,
    sample: ParticleSample,
    view: ThreeEmitterView,
    emitter: ParticleEmitterDefinition,
    emitterIndex: number,
    particleIndex: number,
    timeSeconds: number,
  ): void {
    const material = Array.isArray(mesh.material)
      ? mesh.material[0]
      : mesh.material;
    if (!material) return;
    if (!isThreeParticleMaterial(material)) return;
    if (material instanceof ShaderMaterial) {
      applyThreeShaderSample(
        material,
        emitter,
        view.textureFrames,
        sample,
        sample.textureFrameIndex,
        view.materialFixed,
        view.materialBlend,
        view.materialOpacityIsConstantOne,
        timeSeconds,
      );
    } else {
      applyThreeTextureFrame(
        material,
        view.textureFrames,
        sample.textureFrameIndex,
        view.materialFixed,
        timeSeconds,
      );
      const effectiveBlend = resolveEffectiveParticleBlend(
        emitter.render.blend,
        view.materialBlend,
      );
      material.depthTest = emitter.render.depthTest;
      material.color.copy(sample.color);
      if (materialBlendOverridesEmitter(effectiveBlend)) {
        // Material-authoritative opaque/cutout pass: depth-written and never
        // routed to the transparent pass, regardless of sample.alpha (I12-G).
        material.depthWrite = true;
        material.blending = threeBlendingForEffectiveBlend(effectiveBlend);
        material.opacity = effectiveBlend === "opaque" ? 1 : sample.alpha;
        material.transparent = false;
      } else {
        material.depthWrite = resolveParticleDepthWrite(
          emitter.render,
          sample.alpha,
        );
        material.blending = threeBlendingForEffectiveBlend(effectiveBlend);
        material.premultipliedAlpha = effectiveBlend === "premultiplied";
        material.opacity = sample.alpha;
        material.transparent =
          sample.alpha < 1 ||
          emitter.render.blend === "additive" ||
          emitter.render.blend === "premultiplied";
      }
      if ("emissive" in material) {
        material.emissive.copy(sample.color);
        material.emissiveIntensity =
          emitter.render.shading === "lit"
            ? Math.max(0, sample.emissiveStrength - 1)
            : 0;
      }
      material.needsUpdate = true;
    }

    this.scratchWorld.set(
      sample.position[0],
      sample.position[1],
      sample.position[2],
    );
    mesh.renderOrder = renderOrderForParticleSortMode(
      this.renderOrder + (this.emitterLayerRanks[emitterIndex] ?? emitterIndex),
      emitter.render.sortMode,
      this.scratchWorld.distanceToSquared(this.camera.position),
      sample.start,
    );
    const matrix = this.writeSampleMatrix(
      sample,
      view,
      emitter,
      emitterIndex,
      particleIndex,
    );

    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = true;
  }

  private applySampleToInstanced(
    instanced: ThreeInstancedBillboardView,
    sample: ParticleSample,
    view: ThreeEmitterView,
    emitter: ParticleEmitterDefinition,
    emitterIndex: number,
    particleIndex: number,
    visibleIndex: number,
  ): void {
    const matrix = this.writeSampleMatrix(
      sample,
      view,
      emitter,
      emitterIndex,
      particleIndex,
    );
    instanced.write(visibleIndex, matrix, sample.color, sample.alpha);
  }

  private writeSampleMatrix(
    sample: ParticleSample,
    view: ThreeEmitterView,
    emitter: ParticleEmitterDefinition,
    emitterIndex: number,
    particleIndex: number,
  ): Matrix4 {
    this.applySampleOrientation(sample, emitter);
    this.scratchEuler.set(
      sample.rotation[0],
      sample.rotation[1],
      sample.rotation[2],
    );
    this.scratchRollQuaternion.setFromEuler(this.scratchEuler);
    this.scratchQuaternion.multiply(this.scratchRollQuaternion);
    this.scratchScale.set(
      sample.width,
      sample.height,
      emitter.mode === "mesh" && emitter.mesh.renderMode === "meshAsset"
        ? sample.depthScale
        : 1,
    );
    this.scratchWorld.set(
      sample.position[0] - this.position[0],
      sample.position[1] - this.position[1],
      sample.position[2] - this.position[2],
    );
    this.scratchMatrix.compose(
      this.scratchWorld,
      this.scratchQuaternion,
      this.scratchScale,
    );

    const pivotX =
      emitter.mode === "mesh"
        ? emitter.mesh.pivot[0] * view.pivotBoundsSize[0]
        : emitter.billboard.pivot[0] * view.pivotBoundsSize[0];
    const pivotY =
      emitter.mode === "mesh"
        ? emitter.mesh.pivot[1] * view.pivotBoundsSize[1]
        : emitter.billboard.pivot[1] * view.pivotBoundsSize[1];
    const pivotZ =
      emitter.mode === "mesh"
        ? emitter.mesh.pivot[2] * view.pivotBoundsSize[2]
        : 0; // billboard is a unit quad; pivotBoundsSize[2]=0 → Z inert (Vec2)
    if (pivotX !== 0 || pivotY !== 0 || pivotZ !== 0) {
      this.scratchPivotMatrix.makeTranslation(-pivotX, -pivotY, -pivotZ);
      this.scratchMatrix.multiply(this.scratchPivotMatrix);
    }

    if (this.captureDebugTransforms) {
      this.debugTransforms.push({
        emitterId: emitter.id,
        emitterIndex,
        particleIndex,
        mode:
          emitter.mode === "billboard"
            ? "billboard"
            : emitter.mesh.renderMode === "meshAsset"
              ? "meshAsset"
              : "pixiShard",
        position: [...sample.position] as Vec3,
        normal: [sample.normal.x, sample.normal.y, sample.normal.z],
        width: sample.width,
        height: sample.height,
        depth: sample.depth,
        localBounds: view.debugBounds,
        matrix: this.scratchMatrix.toArray(),
      });
    }
    return this.scratchMatrix;
  }

  private acquireMesh(view: ThreeEmitterView, index: number): Mesh {
    let mesh = view.meshes[index];
    if (mesh) return mesh;
    mesh = new Mesh(view.geometry, view.material.clone());
    mesh.frustumCulled = false;
    view.meshes[index] = mesh;
    this.root.add(mesh);
    return mesh;
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
    }
    return [...missing];
  }
}

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

export function normalizeThreeVfxEffect(
  value: unknown,
): ParticleEffectDefinition {
  if (isExportedEffect(value)) {
    return normalizeParticleEffect({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      targetProfile: value.targetProfile,
      id: value.id,
      name: value.name,
      timeline: value.timeline,
      emitters: value.emitters,
    });
  }
  return normalizeParticleEffect(value);
}

function createEmitterView(
  emitter: ParticleEmitterDefinition,
  options: ThreeVfxEffectInstanceOptions,
  context: ThreeViewBuildContext,
): ThreeEmitterView {
  const meshAssetRender =
    emitter.mode === "mesh" && emitter.mesh.renderMode === "meshAsset";
  const meshAsset = meshAssetRender ? emitter.mesh.asset : null;
  // A host-injected render geometry overrides the authored asset — and also
  // works with no authored asset at all (host-only geometry).
  const meshGeometry = meshAssetRender
    ? (context.renderGeometryOverride?.geometry ??
      (meshAsset ? options.meshProvider?.getMeshGeometry(meshAsset) : null))
    : null;
  const geometry = meshGeometry ?? BASE_QUAD_GEOMETRY;
  const ownedGeometry =
    meshAssetRender &&
    (emitter.mesh.flipWinding || emitter.mesh.recomputeNormals)
      ? geometry.clone()
      : null;
  const viewGeometry = ownedGeometry ?? geometry;
  if (ownedGeometry && emitter.mesh.flipWinding) {
    reverseGeometryWinding(ownedGeometry);
  }
  if (ownedGeometry && emitter.mesh.recomputeNormals) {
    ownedGeometry.computeVertexNormals();
  }
  const pivotBoundsSize = geometryBoundsSize(viewGeometry);
  const debugBounds = geometryDebugBounds(viewGeometry);
  // A host material (ThreeVfxMaterialProvider.getParticleMaterial) replaces
  // the whole built-in surface pipeline for this emitter: no texture frames,
  // no material graph, no instanced fast path — the host owns the look.
  const providedMaterial =
    options.materialProvider?.getParticleMaterial?.(
      context.effect,
      emitter.id,
    ) ?? null;
  const hostMaterial =
    providedMaterial && isThreeParticleMaterial(providedMaterial)
      ? providedMaterial
      : null;
  const material = createThreeEmitterMaterial(emitter, options);
  if (hostMaterial) material.material.dispose();
  const sourceMap = hostMaterial
    ? null
    : material.material instanceof ShaderMaterial
      ? textureUniformValue(material.material, "uTexture")
      : material.material.map;
  const sourceAlphaMap =
    hostMaterial || material.material instanceof ShaderMaterial
      ? null
      : material.material.alphaMap;
  const textureFrames = createThreeTextureFrameSet(
    sourceMap,
    sourceAlphaMap,
    emitter,
    hostMaterial ? null : material.fixed,
  );
  const instanced =
    !hostMaterial && canUseInstancedBillboard(emitter, sourceMap)
      ? new ThreeInstancedBillboardView(
          viewGeometry,
          sourceMap!,
          emitter.maxParticles,
          emitter,
        )
      : null;
  const trailGeometry = new BufferGeometry();
  const trailMaterial = new MeshBasicMaterial({
    transparent: true,
    vertexColors: true,
    depthTest: emitter.render.depthTest,
    depthWrite: resolveParticleDepthWrite(emitter.render),
    blending:
      emitter.render.blend === "additive" ? AdditiveBlending : NormalBlending,
    premultipliedAlpha: emitter.render.blend === "premultiplied",
    side: DoubleSide,
  });
  const trailMesh = new Mesh(trailGeometry, trailMaterial);
  trailMesh.frustumCulled = false;
  trailMesh.visible = false;
  return {
    key: emitterViewKey(emitter, hostMaterial ? "host" : material.key),
    staticKey: emitterStaticViewKey(emitter, options, context),
    meshes: [],
    instanced,
    particleOrder: new Uint32Array(Math.max(1, emitter.maxParticles)),
    geometry: viewGeometry,
    ownedGeometry,
    pivotBoundsSize,
    debugBounds,
    trailMesh,
    trailGeometry,
    trailMaterial,
    trailHistories: new Map(),
    trailEmitterPosition: [0, 0, 0],
    material: hostMaterial ?? material.material,
    ownedTextures: [...material.ownedTextures, ...textureFrames.ownedTextures],
    textureFrames,
    materialFixed: hostMaterial ? null : material.fixed,
    materialParticleColorUsage: hostMaterial
      ? { rgb: true, alpha: true }
      : material.particleColorUsage,
    materialOpacityIsConstantOne: hostMaterial
      ? false
      : material.opacityIsConstantOne,
    materialBlend: hostMaterial ? null : material.materialBlend,
    missingMaterialRef: hostMaterial ? null : material.missingMaterialRef,
    unsupportedFeatures: material.unsupportedFeatures,
    hostMaterial: hostMaterial !== null,
  };
}

function applyThreeShaderSample(
  material: ShaderMaterial,
  emitter: ParticleEmitterDefinition,
  textureFrames: ThreeTextureFrameSet,
  sample: ParticleSample,
  frameIndex: number,
  materialFixed: MaterialFixedDescriptor | null,
  materialBlend: MaterialBlend | null,
  opacityIsConstantOne: boolean,
  timeSeconds: number,
): void {
  applyThreeShaderTextureFrame(
    material,
    textureFrames,
    frameIndex,
    materialFixed,
    timeSeconds,
  );
  const color = material.uniforms.uParticleColor?.value as
    { set: (x: number, y: number, z: number, w: number) => void } | undefined;
  color?.set(
    sample.shaderColor[0],
    sample.shaderColor[1],
    sample.shaderColor[2],
    sample.alpha,
  );
  const effectiveBlend = resolveEffectiveParticleBlend(
    emitter.render.blend,
    materialBlend,
  );
  material.depthTest = emitter.render.depthTest;
  if (materialBlendOverridesEmitter(effectiveBlend)) {
    // Masked/opaque bypass the I12-A gate: opaque ignores alpha by definition
    // and masked resolves translucency via the fragment discard (I12-G).
    material.transparent = false;
    material.depthWrite = true;
    material.blending = threeBlendingForEffectiveBlend(effectiveBlend);
  } else {
    // I12-A: only a provably constant-1 graph opacity lets sample.alpha decide
    // the opaque pass — a live opacity output owns per-pixel translucency.
    material.transparent =
      !opacityIsConstantOne ||
      sample.alpha < 1 ||
      emitter.render.blend === "additive" ||
      emitter.render.blend === "premultiplied";
    material.depthWrite = resolveParticleDepthWrite(
      emitter.render,
      opacityIsConstantOne ? sample.alpha : 0,
    );
    material.blending = threeBlendingForEffectiveBlend(effectiveBlend);
    material.premultipliedAlpha = effectiveBlend === "premultiplied";
  }
  material.needsUpdate = true;
  const dynamicParams = material.uniforms.uDynamicParams?.value as
    { set: (x: number, y: number, z: number, w: number) => void } | undefined;
  const dynamicValues = sampleEmitterDynamicParams(emitter, sample);
  dynamicParams?.set(
    dynamicValues[0],
    dynamicValues[1],
    dynamicValues[2],
    dynamicValues[3],
  );
  if (material.uniforms.uTime) {
    material.uniforms.uTime.value = timeSeconds;
  }
  material.uniformsNeedUpdate = true;
}

function sampleEmitterDynamicParams(
  emitter: ParticleEmitterDefinition,
  sample: ParticleSample,
): [number, number, number, number] {
  if (!emitter.modules.customData) return [0, 0, 0, 0];
  const channels = emitter.advanced.customData.channels;
  return [
    sampleParticleScalarValue(
      channels[0],
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
    sampleParticleScalarValue(
      channels[1],
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
    sampleParticleScalarValue(
      channels[2],
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
    sampleParticleScalarValue(
      channels[3],
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  ];
}

function updateThreeTrailHistory(
  view: ThreeEmitterView,
  emitter: ParticleEmitterDefinition,
  sample: ParticleSample,
  timeSeconds: number,
): void {
  if (!emitter.modules.trails) return;
  const settings = emitter.advanced.trails;
  if (sample.seed >= settings.ratio) return;
  const lifetimeSeconds = Math.max(
    0.001,
    sampleParticleScalarValue(
      settings.lifetime,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  const length = Math.max(
    0,
    sampleParticleScalarValue(
      settings.length,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  const width = Math.max(
    0.001,
    sampleParticleScalarValue(
      settings.width,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  const key = `${sample.start.toFixed(6)}:${sample.seed.toFixed(6)}`;
  let history = view.trailHistories.get(key);
  if (!history) {
    history = { points: [], lastSeenFrame: timeSeconds };
    view.trailHistories.set(key, history);
  }
  const position = new Vector3(
    sample.position[0],
    sample.position[1],
    sample.position[2],
  );
  const points = history.points;
  const last = points[points.length - 1];
  if (
    !last ||
    last.position.distanceTo(position) >= settings.minVertexDistance
  ) {
    points.push({
      position,
      timeSeconds,
      lifetimeSeconds,
      distanceFromHead: 0,
      color: [sample.color.r, sample.color.g, sample.color.b],
      alpha: sample.alpha,
      width,
      maxLength: length > 0 ? length : undefined,
      seed: sample.seed,
    });
  } else {
    last.position.copy(position);
    last.timeSeconds = timeSeconds;
    last.lifetimeSeconds = lifetimeSeconds;
    last.color = [sample.color.r, sample.color.g, sample.color.b];
    last.alpha = sample.alpha;
    last.width = width;
    last.maxLength = length > 0 ? length : undefined;
    last.seed = sample.seed;
  }
  history.lastSeenFrame = timeSeconds;
  pruneThreeTrailPoints(points, length > 0 ? length : undefined, timeSeconds);
}

function applyThreeLocalSpaceTrailShift(
  view: ThreeEmitterView,
  emitter: ParticleEmitterDefinition,
  emitterPosition: Vec3,
): void {
  const previous = view.trailEmitterPosition;
  if (
    emitter.modules.trails &&
    !emitter.advanced.trails.worldSpace &&
    view.trailHistories.size > 0
  ) {
    const dx = emitterPosition[0] - previous[0];
    const dy = emitterPosition[1] - previous[1];
    const dz = emitterPosition[2] - previous[2];
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      for (const history of view.trailHistories.values()) {
        for (const point of history.points) {
          point.position.x += dx;
          point.position.y += dy;
          point.position.z += dz;
        }
      }
    }
  }
  previous[0] = emitterPosition[0];
  previous[1] = emitterPosition[1];
  previous[2] = emitterPosition[2];
}

function drawThreeTrailView(
  view: ThreeEmitterView,
  emitter: ParticleEmitterDefinition,
  camera: Camera,
  timeSeconds: number,
): void {
  if (!emitter.modules.trails) {
    clearThreeTrailView(view);
    return;
  }
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const settings = emitter.advanced.trails;
  const srgbColor = new Color();
  for (const [key, history] of view.trailHistories) {
    pruneThreeTrailPoints(history.points, undefined, timeSeconds);
    if (history.points.length < 2) {
      if (history.points.length === 0) view.trailHistories.delete(key);
      continue;
    }
    const points = history.points;
    const fallbackLength = Math.max(points[0]?.distanceFromHead ?? 1, 1);
    const startVertex = positions.length / 3;
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      const next = points[Math.min(i + 1, points.length - 1)] ?? point;
      const prev = points[Math.max(i - 1, 0)] ?? point;
      const maxLength = point.maxLength;
      if (maxLength !== undefined && point.distanceFromHead > maxLength)
        continue;
      const trailT = clamp(
        point.distanceFromHead / (maxLength ?? fallbackLength),
        0,
        1,
      );
      const ageFade =
        1 -
        clamp((timeSeconds - point.timeSeconds) / point.lifetimeSeconds, 0, 1);
      let r = point.color[0];
      let g = point.color[1];
      let b = point.color[2];
      let alpha = point.alpha;
      if (settings.color) {
        const rgb = sampleParticleGradientColor(settings.color, trailT);
        srgbColor.setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
        r = srgbColor.r;
        g = srgbColor.g;
        b = srgbColor.b;
        alpha = sampleParticleGradientAlpha(settings.color, trailT);
      } else if (!settings.inheritColor) {
        r = 1;
        g = 1;
        b = 1;
      }
      alpha *= (1 - trailT) * ageFade;
      const width =
        point.width *
        Math.max(
          0,
          sampleParticleScalarValue(
            settings.widthOverTrail,
            trailT,
            point.seed,
          ),
        );
      if (alpha <= 0.01 || width <= 0.0001) continue;
      const dir = new Vector3().subVectors(next.position, prev.position);
      if (dir.lengthSq() <= 0.0000001) dir.set(0, 1, 0);
      dir.normalize();
      const viewDir = new Vector3().subVectors(camera.position, point.position);
      if (viewDir.lengthSq() <= 0.0000001) viewDir.set(0, 0, 1);
      viewDir.normalize();
      const side = new Vector3().crossVectors(dir, viewDir);
      if (side.lengthSq() <= 0.0000001) side.copy(DEFAULT_UP);
      side.normalize().multiplyScalar(width * 0.5);
      positions.push(
        point.position.x - side.x,
        point.position.y - side.y,
        point.position.z - side.z,
        point.position.x + side.x,
        point.position.y + side.y,
        point.position.z + side.z,
      );
      colors.push(r, g, b, alpha, r, g, b, alpha);
    }
    const vertexCount = positions.length / 3 - startVertex;
    for (let i = 0; i < vertexCount / 2 - 1; i++) {
      const a = startVertex + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  if (positions.length === 0 || indices.length === 0) {
    clearThreeTrailGeometry(view);
    return;
  }
  view.trailGeometry.setAttribute(
    "position",
    new Float32BufferAttribute(positions, 3),
  );
  view.trailGeometry.setAttribute(
    "color",
    new Float32BufferAttribute(colors, 4),
  );
  view.trailGeometry.setIndex(indices);
  view.trailGeometry.computeBoundingSphere();
  view.trailMesh.visible = true;
}

function clearThreeTrailView(view: ThreeEmitterView): void {
  view.trailHistories.clear();
  clearThreeTrailGeometry(view);
}

function clearThreeTrailGeometry(view: ThreeEmitterView): void {
  view.trailMesh.visible = false;
  view.trailGeometry.setIndex([]);
  view.trailGeometry.deleteAttribute("position");
  view.trailGeometry.deleteAttribute("color");
}

function pruneThreeTrailPoints(
  points: ThreeTrailPoint[],
  maxLength: number | undefined,
  timeSeconds: number,
): void {
  let distanceFromHead = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]!;
    const next = points[i + 1];
    if (next) distanceFromHead += point.position.distanceTo(next.position);
    point.distanceFromHead = distanceFromHead;
  }
  while (
    points.length > 0 &&
    ((maxLength !== undefined &&
      points[0]!.distanceFromHead > maxLength &&
      points.length > 1) ||
      timeSeconds - points[0]!.timeSeconds > points[0]!.lifetimeSeconds)
  ) {
    points.shift();
  }
}

function textureUniformValue(
  material: ShaderMaterial,
  uniformName: string,
): Texture | null {
  const value = material.uniforms[uniformName]?.value;
  return value && value instanceof Texture ? value : null;
}

function updateEmitterLayerRanks(
  emitters: readonly ParticleEmitterDefinition[],
  out: number[],
): void {
  out.length = emitters.length;
  const ranked = emitters.map((emitter, index) => ({
    index,
    orderInLayer: emitter.render.orderInLayer,
  }));
  ranked.sort((a, b) => a.orderInLayer - b.orderInLayer || a.index - b.index);
  let layerRank = -1;
  let previousOrder: number | null = null;
  for (const item of ranked) {
    if (previousOrder === null || item.orderInLayer !== previousOrder) {
      layerRank += 1;
      previousOrder = item.orderInLayer;
    }
    out[item.index] = layerRank;
  }
}

function renderOrderForParticleSortMode(
  emitterRank: number,
  sortMode: ParticleEmitterDefinition["render"]["sortMode"],
  distanceSquared: number,
  start: number,
): number {
  const base = emitterRank;
  switch (sortMode) {
    case "distanceNearFirst":
      return (
        base +
        Math.min(
          0.999999,
          Math.max(0, distanceSquared) / (1 + Math.max(0, distanceSquared)),
        )
      );
    case "oldestFirst":
      return base + 0.5 - 0.499999 * Math.tanh(start);
    case "youngestFirst":
      return base + 0.5 + 0.499999 * Math.tanh(start);
    case "none":
    case "distanceFarFirst":
    default:
      return base;
  }
}

function geometryBoundsSize(geometry: BufferGeometry): Vec3 {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return [1, 1, 0];
  return [
    Math.max(0, box.max.x - box.min.x),
    Math.max(0, box.max.y - box.min.y),
    Math.max(0, box.max.z - box.min.z),
  ];
}

function geometryDebugBounds(geometry: BufferGeometry): {
  min: Vec3;
  max: Vec3;
} {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] };
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

function emitterStaticViewKey(
  emitter: ParticleEmitterDefinition,
  options: ThreeVfxEffectInstanceOptions,
  context: ThreeViewBuildContext,
): string {
  const materialGraph = emitter.render.material
    ? options.materialGraphProvider?.(emitter.render.material.shaderId)
    : undefined;
  const hostMaterial = options.materialProvider?.getParticleMaterial?.(
    context.effect,
    emitter.id,
  );
  return [
    emitter.mode,
    emitter.maxParticles,
    emitter.mesh.renderMode,
    emitter.mesh.asset?.path ?? "",
    // Host injections are part of the view identity: a swapped render
    // geometry bumps its generation, and a (re)provided host material keys by
    // uuid, so stale views can never survive an injection change.
    context.renderGeometryOverride
      ? `hostgeo:${context.renderGeometryOverride.generation}`
      : "",
    hostMaterial ? `hostmat:${hostMaterial.uuid}` : "",
    Number(emitter.mesh.flipWinding),
    Number(emitter.mesh.recomputeNormals),
    emitterTexturePath(emitter) ?? "",
    emitter.render.material?.shaderId ?? "",
    materialGraph?.side ?? "double",
    materialGraph?.blend ?? "normal",
    emitter.render.shading,
    emitter.render.blend,
    Number(emitter.render.depthTest),
    Number(resolveParticleDepthWrite(emitter.render)),
  ].join("|");
}

function emitterViewKey(
  emitter: ParticleEmitterDefinition,
  materialKey: string,
): string {
  return [
    emitter.mode,
    emitter.maxParticles,
    emitter.mesh.renderMode,
    emitter.mesh.asset?.path ?? "",
    Number(emitter.mesh.flipWinding),
    Number(emitter.mesh.recomputeNormals),
    materialKey,
    emitter.render.shading,
    emitter.render.blend,
    Number(emitter.render.depthTest),
    Number(resolveParticleDepthWrite(emitter.render)),
  ].join("|");
}

export function updateInstancedParticleOrder(
  state: Pick<ParticleEmitterRuntimeState, "activeCount" | "instanceData">,
  sortMode: ParticleEmitterDefinition["render"]["sortMode"],
  out: Uint32Array,
): void {
  const count = Math.min(state.activeCount, out.length);
  for (let i = 0; i < count; i++) out[i] = i;
  if (sortMode !== "oldestFirst") return;
  const data = state.instanceData;
  for (let i = 1; i < count; i++) {
    const index = out[i] ?? i;
    const start = data[index * PARTICLE_INSTANCE_STRIDE + 3] ?? 0;
    let insertAt = i;
    while (insertAt > 0) {
      const previousIndex = out[insertAt - 1] ?? insertAt - 1;
      const previousStart =
        data[previousIndex * PARTICLE_INSTANCE_STRIDE + 3] ?? 0;
      if (previousStart <= start) break;
      out[insertAt] = previousIndex;
      insertAt -= 1;
    }
    out[insertAt] = index;
  }
}

function sampleParticleSize(
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  particleIndex: number,
  normalizedAge: number,
  speed: number,
  seed: number,
  loopAge: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const offset = particleIndex * PARTICLE_INSTANCE_STRIDE;
  const initSizeX = Math.max(0, state.instanceData[offset + 11] ?? 1);
  const initSizeY = Math.max(0, state.instanceData[offset + 12] ?? initSizeX);
  const initSizeZ =
    emitter.mode === "mesh"
      ? Math.max(0, state.instanceData[offset + 17] ?? initSizeX)
      : initSizeX;
  const sizeSettingsX =
    emitter.mode === "billboard"
      ? emitter.billboard.sizeValue
      : emitter.mesh.sizeValue;
  const sizeSettingsY =
    emitter.mode === "billboard"
      ? emitter.billboard.separateAxes
        ? emitter.billboard.sizeValueY
        : sizeSettingsX
      : emitter.mesh.separateAxes
        ? emitter.mesh.sizeValueY
        : sizeSettingsX;
  const sizeSettingsZ =
    emitter.mode === "mesh" && emitter.mesh.separateAxes
      ? emitter.mesh.sizeValueZ
      : sizeSettingsX;
  const overLifeX = emitter.modules.size
    ? Math.max(
        0,
        sampleParticleScalarValue(sizeSettingsX, normalizedAge, seed, loopAge),
      )
    : 1;
  const overLifeY = emitter.modules.size
    ? Math.max(
        0,
        sampleParticleScalarValue(sizeSettingsY, normalizedAge, seed, loopAge),
      )
    : 1;
  const overLifeZ = emitter.modules.size
    ? Math.max(
        0,
        sampleParticleScalarValue(sizeSettingsZ, normalizedAge, seed, loopAge),
      )
    : 1;
  const bySpeed = particleSizeBySpeedMultiplier(emitter, speed, seed, loopAge);
  out.x = Math.max(0.0001, initSizeX * overLifeX * bySpeed);
  out.y = Math.max(0.0001, initSizeY * overLifeY * bySpeed);
  out.z = Math.max(0.0001, initSizeZ * overLifeZ * bySpeed);
  return out;
}

/**
 * Samples a host-injected color-over-lifetime gradient with the exact same
 * samplers as the authored path, so an override equal to the authored
 * gradient renders identically.
 */
function sampleGradientOverrideColor(
  gradient: ParticleColorGradientSettings,
  normalizedAge: number,
  out: [number, number, number, number],
): [number, number, number, number] {
  sampleParticleGradientColor(gradient, normalizedAge, out);
  out[3] = sampleParticleGradientAlpha(gradient, normalizedAge);
  return out;
}

function sampleSimpleParticleModuleColor(
  emitter: ParticleEmitterDefinition,
  normalizedAge: number,
  out: [number, number, number, number],
): [number, number, number, number] {
  if (!emitter.modules.color) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = 1;
    return out;
  }
  sampleParticleGradientColor(emitter.color.gradient, normalizedAge, out);
  out[3] = sampleParticleGradientAlpha(emitter.color.gradient, normalizedAge);
  return out;
}

function hideViewMeshes(view: ThreeEmitterView, visibleCount: number): void {
  for (let i = visibleCount; i < view.meshes.length; i++) {
    const mesh = view.meshes[i];
    if (mesh) mesh.visible = false;
  }
}

function destroyEmitterView(view: ThreeEmitterView): void {
  for (const mesh of view.meshes) {
    mesh.removeFromParent();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) material.dispose();
    } else {
      mesh.material.dispose();
    }
  }
  view.meshes.length = 0;
  view.instanced?.dispose();
  view.trailMesh.removeFromParent();
  view.trailGeometry.dispose();
  view.trailMaterial.dispose();
  view.trailHistories.clear();
  if (!view.hostMaterial) view.material.dispose();
  view.ownedGeometry?.dispose();
  for (const texture of view.ownedTextures) texture.dispose();
  view.ownedTextures.length = 0;
}

function createEmptyEffectStats(): ThreeVfxEffectStats {
  return {
    activeParticles: 0,
    visibleParticles: 0,
    capacity: 0,
    emittedLastFrame: 0,
    bloomSourceParticles: 0,
    drawCalls: 0,
    instancedDrawCalls: 0,
    legacyParticleDrawCalls: 0,
    missingMeshRefs: [],
    missingMaterialRefs: [],
    unsupportedFeatures: [],
  };
}

function emptyEmitterDrawResult(): ThreeEmitterDrawResult {
  return {
    visibleParticles: 0,
    bloomSourceParticles: 0,
    drawCalls: 0,
    instancedDrawCalls: 0,
    legacyParticleDrawCalls: 0,
  };
}

function normalizeOr(value: Vector3, fallback: Vector3): Vector3 {
  return value.lengthSq() > 0.000001 ? value.normalize() : value.copy(fallback);
}

function perpendicularUnitVector(value: Vector3, out: Vector3): Vector3 {
  if (Math.abs(value.y) < 0.9) {
    out.set(0, 1, 0);
  } else {
    out.set(1, 0, 0);
  }
  return out.cross(value).normalize();
}

function copyVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function clampTintChannel(value: number): number {
  // Allow >1 for HDR-ish boosts, but keep it sane and non-negative.
  return Number.isFinite(value) ? Math.min(8, Math.max(0, value)) : 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSeed(value: number | undefined): number {
  return Number.isFinite(value) ? Math.floor(value as number) : DEFAULT_SEED;
}

function isExportedEffect(value: unknown): value is {
  kind: "vfx-effect";
  id: string;
  name?: string;
  targetProfile?: unknown;
  timeline?: unknown;
  emitters?: unknown;
} {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "vfx-effect",
  );
}
