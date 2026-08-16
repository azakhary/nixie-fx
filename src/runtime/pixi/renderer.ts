import {
  Container,
  Particle,
  ParticleContainer,
  Rectangle,
  Texture,
  type ColorSource,
  type Shader as PixiShader,
} from "pixi.js";
import type { Vec3, Vec4 } from "../../engine/math";
import {
  PARTICLE_INSTANCE_STRIDE,
  PARTICLE_RUNTIME_FLAG_ALIGN_TO_DIRECTION,
  PARTICLE_RUNTIME_VECTOR_STRIDE,
  ParticleEffectRunner,
  type ParticleEffectEvent,
  normalizeParticleEffect,
  sampleInitialParticleColor,
  sampleParticleMotion,
  sampleParticleGradientAlpha,
  sampleParticleGradientColor,
  sampleParticleScalarValue,
  type ParticleEffectDefinition,
  type ParticleEmitterDefinition,
  type ParticleEmitterRuntimeState,
  type ParticleSubEmitterSpawnRequest,
} from "../../engine/particles";
import {
  applyCollisionResponse,
  applyPositionalMotionModules,
  computeEffectiveAlignmentVelocity,
  particleRotationBySpeedOffset,
  particleSizeBySpeedMultiplier,
  particleTrailSample,
  sampleParticleModuleColor,
  sampleTextureSheetAnimationFrame,
  type ParticleMotionSample,
} from "../modules";
import type { VfxTextureAssetRef } from "../assets/types";
import { collectParticleTextureRefs } from "../assets/textureRefs";
import {
  derivedTextureCacheKey,
  opacitySourceNeedsDerivation,
} from "../assets/derivedTextures";
import {
  createDerivedAlphaTexture,
  createMaterialBakeTexture,
  createPremultipliedSourceTexture,
} from "./material";
import {
  compileMaterial,
  materialDigest,
  type MaterialArtifact,
  type MaterialFixedDescriptor,
} from "../materials";
import {
  createSpriteMasterGraph,
  resolveEffectiveMainTexPath,
  resolveEffectiveParticleBlend,
  materialBlendOverridesEmitter,
  SPRITE_MASTER_SHADER_ID,
  type EffectiveParticleBlend,
  type MaterialInstance,
  type MaterialRenderFace,
  type ShaderGraph,
} from "../schema/materials";
import {
  createPixiVfxTextureRef,
  collectPixiVfxUnsupportedFeatures,
  collectPixiVfxUnsupportedModules,
} from "./support";
import { createPixiVfx2dProjection } from "./projection";
import { createPixiVfxProceduralTextures } from "./proceduralTextures";
import {
  canRenderTier2ParticleContainerShader,
  createTier2ParticleMaterialShader,
  updateTier2ParticleMaterialShaderDynamicParams,
  updateTier2ParticleMaterialShaderTime,
} from "./materialShader";
import {
  createMissingMaterialGraphBlock,
  createUnsupportedTier2MaterialBlock,
  materialRenderBlockKey,
  materialRenderBlockMissingRef,
  materialRenderBlockUnsupportedFeature,
  type PixiVfxMaterialRenderBlock,
} from "./materialRenderDiagnostics";
import { projectParticleDirectionAngle } from "./particleProjection";
import type {
  PixiVfxCreateEffectOptions,
  PixiVfxEffectInstanceOptions,
  PixiVfxEffectStats,
  PixiVfxEffectProvider,
  PixiVfxEmitterRenderView,
  PixiVfxBloomOptions,
  PixiVfxFallbackTextures,
  PixiVfxMaterialGraphProvider,
  PixiVfxProceduralTextureKey,
  PixiVfxProjection,
  PixiVfxParticleDebugQuad,
  PixiVfxRendererOptions,
  PixiVfxRendererStats,
  PixiVfxRuntimeEventFrame,
  PixiVfxSpawnOptions,
  PixiVfxTextureProvider,
  PixiVfxUpdateOptions,
} from "./types";
import {
  BloomComposer,
  DISABLED_BLOOM_DRAW_SETTINGS,
  bloomDrawSettings,
  normalizeBloomConfig,
  type BloomDrawSettings,
  type ResolvedBloomConfig,
} from "./bloom";

interface EmitterView extends PixiVfxEmitterRenderView {
  pool: Particle[];
  depthSort: DepthSortEntry[];
  trailContainer: ParticleContainer;
  trailTexture: Texture;
  trailPool: Particle[];
  bloomContainer: ParticleContainer;
  bloomPool: Particle[];
  trailHistories: Map<string, TrailHistory>;
  trailEmitterPosition: Vec3;
  frameTextures: Texture[];
  ownedFrameTextures: Texture[];
  animatedUvFrames: AnimatedUvFrameTexture[];
  materialUv: MaterialAnimatedUvDescriptor | null;
  materialBlock: PixiVfxMaterialRenderBlock | null;
  materialShaders: PixiShader[];
  dynamicUvs: boolean;
  effectiveBlend: EffectiveParticleBlend;
}

interface ParticleColorUsage {
  rgb: boolean;
  alpha: boolean;
}

const APPLY_EMITTER_PARTICLE_COLOR: ParticleColorUsage = {
  rgb: true,
  alpha: true,
};

interface DepthSortEntry {
  particle: Particle;
  depth: number;
  // Stable per-particle ordering keys (B5): spawn time then per-particle seed.
  // Used so swap-remove compaction (which reshuffles engine indices when a
  // neighbour dies) never changes the relative draw order across frames.
  start: number;
  seed: number;
}

interface ParticleRenderSample {
  visible: boolean;
  x: number;
  y: number;
  depth: number;
  pixelSize: number;
  pixelsPerWorldUnit: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
  tint: number;
  alpha: number;
  baseAlpha: number;
  hdrColor: Vec3;
  emissiveStrength: number;
  texture: Texture;
  key: string;
  start: number;
  normalizedAge: number;
  loopAge: number;
  speed: number;
  seed: number;
}

interface TrailPoint {
  x: number;
  y: number;
  timeSeconds: number;
  /** Seconds this point persists before fully fading out / being pruned. */
  lifetimeSeconds: number;
  distanceFromHead: number;
  pixelSize: number;
  tint: number;
  alpha: number;
  widthPx: number;
  maxLengthPx?: number;
  seed: number;
}

interface TrailHistory {
  points: TrailPoint[];
  lastSeenFrame: number;
}

interface EmitterDrawResult {
  visibleParticles: number;
  renderGroups: number;
  bloomSourceParticles: number;
}

interface ResolvedEmitterRender {
  key: string;
  texture: Texture;
  trailTexture: Texture;
  frameTextures: Texture[];
  ownedFrameTextures: Texture[];
  animatedUvFrames: AnimatedUvFrameTexture[];
  materialUv: MaterialAnimatedUvDescriptor | null;
  materialBlock: PixiVfxMaterialRenderBlock | null;
  tier2Material: ResolvedTier2MaterialRender | null;
  dynamicUvs: boolean;
  effectiveBlend: EffectiveParticleBlend;
  materialRenderFace?: MaterialRenderFace;
  missingRef?: VfxTextureAssetRef;
  missingTrailRef?: VfxTextureAssetRef;
}

interface ResolvedEmitterMaterial {
  artifact: MaterialArtifact | null;
  graph: ShaderGraph | null;
  block?: PixiVfxMaterialRenderBlock;
}

interface ResolvedTier2MaterialRender {
  graph: ShaderGraph;
  instance: MaterialInstance;
  artifact: MaterialArtifact;
  textureSheetTiles: [number, number];
}

interface UvQuad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
}

interface AnimatedUvFrameTexture {
  texture: Texture;
  baseUvs: UvQuad;
}

interface MaterialAnimatedUvDescriptor {
  pan?: MaterialFixedDescriptor["uvPan"];
  rotate?: MaterialFixedDescriptor["uvRotate"];
}

const DEFAULT_BOUNDS = new Rectangle(
  -1_000_000,
  -1_000_000,
  2_000_000,
  2_000_000,
);
const DEFAULT_SEED = 0x7f4a7c15;
const DEFAULT_MAX_SUB_EMITTER_INSTANCES = 512;
const HDR_BLOOM_INPUT_CLAMP = 65472;
const BLOOM_SOURCE_ALPHA_STOP_RANGE = Math.log2(1 + HDR_BLOOM_INPUT_CLAMP);
const BLOOM_SOURCE_ALPHA_ENERGY_CURVE = 1.6;
const PARTICLE_DEBUG_QUAD_LIMIT = 512;
const SDR_ADDITIVE_ALPHA_GAIN_PER_STOP = 0.28;
// I13-F velocity-alignment finite-difference scratch (module scope: updateParticle
// is a free function; rendering is single-threaded, one call consumes it fully).
const pixiAnalyticVelocityScratch: Vec3 = [0, 0, 0];
const pixiPreCollisionWorldScratch: Vec3 = [0, 0, 0];
const pixiEffectiveAlignmentVelocity: Vec3 = [0, 0, 0];

export class PixiVfxEffectInstance {
  readonly root = new Container();
  readonly bloomRoot = new Container();
  readonly stats: PixiVfxEffectStats = createEmptyEffectStats();

  private readonly runner: ParticleEffectRunner;
  private readonly emitterViews: EmitterView[] = [];
  private readonly childInstances = new Set<PixiVfxEffectInstance>();
  /** Derived alpha-mask textures, cached by (sourceUid, opacitySource, invert). */
  private readonly derivedTextures = new Map<string, Texture>();
  /** Premultiplied-source textures (I13-A), cached by source uid. */
  private readonly premultipliedTextures = new Map<string | number, Texture>();
  /** Compiled material artifacts, cached by materialDigest (graph+overrides+mainTexUid). */
  private readonly materialArtifacts = new Map<string, MaterialArtifact>();
  /** The built-in "Sprite Master" graph — the implicit material of every emitter. */
  private readonly spriteMasterGraph: ShaderGraph = createSpriteMasterGraph();
  private effect: ParticleEffectDefinition;
  private textureProvider?: PixiVfxTextureProvider;
  private effectProvider?: PixiVfxEffectProvider;
  private materialGraphProvider?: PixiVfxMaterialGraphProvider;
  private fallbackTextures: PixiVfxFallbackTextures;
  private projection: PixiVfxProjection;
  private boundsArea: Rectangle;
  private position: Vec3;
  private seed: number;
  private currentTimeSeconds: number;
  private readonly subEmitterDepth: number;
  private readonly maxSubEmitterDepth: number;
  private readonly maxSubEmitterInstances: number;
  private spawnedSubEmittersLastFrame = 0;
  private ownVisibleParticles = 0;
  private ownRenderGroupsLastFrame = 0;
  private readonly ownDebugQuads: PixiVfxParticleDebugQuad[] = [];
  private ownMissingTextureRefs: VfxTextureAssetRef[] = [];
  private ownMissingSubEmitterRefs: string[] = [];
  private ownMissingMaterialRefs: string[] = [];
  private ownUnsupportedModules: PixiVfxEffectStats["unsupportedModules"] = [];
  private ownUnsupportedFeatures: PixiVfxEffectStats["unsupportedFeatures"] =
    [];
  private ownMaterialUnsupportedFeatures: PixiVfxEffectStats["unsupportedFeatures"] =
    [];
  private destroyed = false;

  constructor(options: PixiVfxEffectInstanceOptions) {
    this.effect = normalizePixiVfxEffect(options.effect);
    this.textureProvider = options.textureProvider;
    this.effectProvider = options.effectProvider;
    this.materialGraphProvider = options.materialGraphProvider;
    this.subEmitterDepth = Math.max(
      0,
      Math.floor(options.subEmitterDepth ?? 0),
    );
    this.maxSubEmitterDepth = Math.max(
      this.subEmitterDepth,
      Math.floor(options.maxSubEmitterDepth ?? 4),
    );
    this.maxSubEmitterInstances = Math.max(
      0,
      Math.floor(
        options.maxSubEmitterInstances ?? DEFAULT_MAX_SUB_EMITTER_INSTANCES,
      ),
    );
    this.runner = new ParticleEffectRunner(this.effect, {
      subEmitterDepth: this.subEmitterDepth,
      maxSubEmitterDepth: this.maxSubEmitterDepth,
      maxEventsPerFrame: options.maxEventsPerFrame,
      maxSubEmitterRequestsPerFrame: options.maxSubEmitterRequestsPerFrame,
    });
    this.fallbackTextures =
      options.fallbackTextures ?? createPixiVfxProceduralTextures();
    this.projection = options.projection ?? createPixiVfx2dProjection();
    this.boundsArea = options.boundsArea ?? DEFAULT_BOUNDS.clone();
    this.position = copyVec3(options.position ?? [0, 0, 0]);
    this.seed = normalizeSeed(options.seed);
    this.currentTimeSeconds = Math.max(0, options.timeSeconds ?? 0);
    this.refreshUnsupportedModules();
    this.ensureEmitterViews();
    if (options.autoStart !== false) {
      this.spawn({
        position: this.position,
        seed: this.seed,
        timeSeconds: this.currentTimeSeconds,
      });
    }
  }

  get definition(): ParticleEffectDefinition {
    return this.effect;
  }

  get isActive(): boolean {
    return this.runner.isActive || this.childInstances.size > 0;
  }

  setTextureProvider(provider: PixiVfxTextureProvider | undefined): void {
    this.textureProvider = provider;
    this.ensureEmitterViews();
    for (const child of this.childInstances) {
      child.setTextureProvider(provider);
    }
  }

  setEffectProvider(provider: PixiVfxEffectProvider | undefined): void {
    this.effectProvider = provider;
    for (const child of this.childInstances) {
      child.setEffectProvider(provider);
    }
  }

  setMaterialGraphProvider(
    provider: PixiVfxMaterialGraphProvider | undefined,
  ): void {
    this.materialGraphProvider = provider;
    this.materialArtifacts.clear();
    this.ensureEmitterViews();
    for (const child of this.childInstances) {
      child.setMaterialGraphProvider(provider);
    }
  }

  /**
   * Resolve an emitter's assigned material to its compiled tier artifact
   * (techspec §6). Returns `null` for texture-only emitters (the no-material
   * path is left untouched — byte-identical rendering). The built-in
   * "sprite-master" id resolves to the seeded fixed-function graph; other ids
   * must resolve through the injected graph provider. Missing authored graphs are
   * returned as an explicit render block instead of drawing a plausible fallback.
   * Artifacts are memoized by `materialDigest` so the graph is compiled once per
   * (graph, overrides, uid).
   */
  private resolveEmitterMaterial(
    emitter: ParticleEmitterDefinition,
    mainTexUid: string | number | null,
  ): ResolvedEmitterMaterial | null {
    const instance = emitter.render.material;
    if (!instance) return null;
    const providedGraph =
      instance.shaderId === SPRITE_MASTER_SHADER_ID
        ? this.spriteMasterGraph
        : this.materialGraphProvider?.(instance.shaderId);
    if (!providedGraph) {
      return {
        artifact: null,
        graph: null,
        block: createMissingMaterialGraphBlock(instance.shaderId),
      };
    }
    const graph = providedGraph;
    const cacheKey = materialDigest(graph, instance, mainTexUid);
    let artifact = this.materialArtifacts.get(cacheKey);
    if (!artifact) {
      artifact = compileMaterial(graph, instance, { mainTexUid });
      this.materialArtifacts.set(cacheKey, artifact);
    }
    return { artifact, graph };
  }

  /**
   * The Tier-1 fixed-function descriptor to fold into the per-particle color
   * compose (tint·BaseColor × Emissive × Opacity, writer-precedence §3.1).
   * Only Tier-1 materials touch the color path; Tier-0 bakes its color into the
   * texture (so no double-apply) and Tier-2/3 are handled elsewhere / deferred.
   */
  private resolveEmitterMaterialFixed(
    emitter: ParticleEmitterDefinition,
  ): MaterialFixedDescriptor | null {
    const resolved = this.resolveEmitterMaterial(emitter, null);
    if (!resolved || resolved.artifact?.tier !== "tier1-fixed") return null;
    return resolved.artifact.fixed ?? null;
  }

  private resolveEmitterParticleColorUsage(
    emitter: ParticleEmitterDefinition,
  ): ParticleColorUsage {
    const instance = emitter.render.material;
    if (!instance || instance.shaderId === SPRITE_MASTER_SHADER_ID) {
      return APPLY_EMITTER_PARTICLE_COLOR;
    }
    const resolved = this.resolveEmitterMaterial(emitter, null);
    if (!resolved?.artifact) return APPLY_EMITTER_PARTICLE_COLOR;
    return {
      rgb: resolved.artifact.usesParticleColorRGB,
      alpha: resolved.artifact.usesParticleColorAlpha,
    };
  }

  setFallbackTextures(textures: PixiVfxFallbackTextures): void {
    this.fallbackTextures = textures;
    this.ensureEmitterViews();
    for (const child of this.childInstances) {
      child.setFallbackTextures(textures);
    }
  }

  setProjection(projection: PixiVfxProjection): void {
    this.projection = projection;
    for (const child of this.childInstances) {
      child.setProjection(projection);
    }
  }

  setBoundsArea(boundsArea: Rectangle): void {
    this.boundsArea = boundsArea;
    for (const view of this.emitterViews) {
      view.container.boundsArea = boundsArea;
      view.trailContainer.boundsArea = boundsArea;
      view.bloomContainer.boundsArea = boundsArea;
    }
    for (const child of this.childInstances) {
      child.setBoundsArea(boundsArea);
    }
  }

  setPosition(position: Vec3): void {
    this.position = copyVec3(position);
    this.runner.setPosition(this.position);
  }

  updateDefinition(effect: unknown): ParticleEffectDefinition {
    this.effect = normalizePixiVfxEffect(effect);
    this.runner.updateDefinition(this.effect);
    this.refreshUnsupportedModules();
    this.ensureEmitterViews();
    return this.effect;
  }

  preloadTextures(): Promise<void> | void {
    const refs = collectPixiVfxEffectTextureRefs(
      this.effect,
      this.materialGraphProvider,
    );
    return this.textureProvider?.preload?.(refs);
  }

  spawn(options: PixiVfxSpawnOptions = {}): void {
    if (this.destroyed) return;
    if (options.effect !== undefined) {
      this.updateDefinition(options.effect);
    }
    if (options.position) {
      this.position = copyVec3(options.position);
    }
    if (typeof options.seed === "number") {
      this.seed = normalizeSeed(options.seed);
    }
    if (typeof options.timeSeconds === "number") {
      this.currentTimeSeconds = Math.max(0, options.timeSeconds);
    }
    this.runner.reset(
      this.effect,
      this.position,
      this.currentTimeSeconds,
      this.seed,
    );
    this.clearSubEmitterInstances();
    this.spawnedSubEmittersLastFrame = 0;
    this.ownMissingSubEmitterRefs = [];
    this.syncRunnerStats(0);
    this.draw(this.currentTimeSeconds);
  }

  reset(options: PixiVfxSpawnOptions = {}): void {
    this.spawn(options);
  }

  stop(): void {
    this.runner.stop();
    this.clearSubEmitterInstances();
    this.hideEmitterViews();
    this.syncRunnerStats(0);
  }

  update(
    deltaSeconds: number,
    optionsOrTimeSeconds: PixiVfxUpdateOptions | number = {},
    bloom: BloomDrawSettings = DISABLED_BLOOM_DRAW_SETTINGS,
  ): boolean {
    if (this.destroyed) return false;
    const options =
      typeof optionsOrTimeSeconds === "number"
        ? { timeSeconds: optionsOrTimeSeconds }
        : optionsOrTimeSeconds;
    if (options.position) {
      this.setPosition(options.position);
    }
    const safeDelta = Math.max(0, finiteOr(deltaSeconds, 0));
    this.currentTimeSeconds =
      typeof options.timeSeconds === "number" &&
      Number.isFinite(options.timeSeconds)
        ? Math.max(0, options.timeSeconds)
        : this.currentTimeSeconds + safeDelta;
    const alive =
      safeDelta > 0
        ? this.runner.update(safeDelta, this.currentTimeSeconds)
        : this.runner.isActive;
    this.spawnedSubEmittersLastFrame = 0;
    this.ownMissingSubEmitterRefs = [];
    this.updateSubEmitterInstances(safeDelta, this.currentTimeSeconds);
    if (safeDelta > 0) {
      this.spawnSubEmitterRequests(this.currentTimeSeconds);
    }
    if (options.draw !== false) {
      this.draw(this.currentTimeSeconds, bloom);
    } else {
      clearStateUploadBytes(this.runner.states);
      this.syncRunnerStats(this.ownVisibleParticles);
    }
    return alive || this.childInstances.size > 0;
  }

  draw(
    timeSeconds = this.currentTimeSeconds,
    bloom: BloomDrawSettings = DISABLED_BLOOM_DRAW_SETTINGS,
  ): void {
    this.currentTimeSeconds = Math.max(0, finiteOr(timeSeconds, 0));
    this.ownVisibleParticles = this.drawParticleViews(
      this.currentTimeSeconds,
      bloom,
    );
    for (const child of this.childInstances) {
      child.draw(this.currentTimeSeconds, bloom);
    }
    this.syncRunnerStats(this.ownVisibleParticles);
  }

  getRuntimeEvents(): PixiVfxRuntimeEventFrame {
    const events: ParticleEffectEvent[] = [...this.runner.events];
    const subEmitterRequests: ParticleSubEmitterSpawnRequest[] = [
      ...this.runner.subEmitterRequests,
    ];
    for (const child of this.childInstances) {
      const childFrame = child.getRuntimeEvents();
      events.push(...childFrame.events);
      subEmitterRequests.push(...childFrame.subEmitterRequests);
    }
    return { events, subEmitterRequests };
  }

  getParticleDebugQuads(
    out: PixiVfxParticleDebugQuad[] = [],
  ): PixiVfxParticleDebugQuad[] {
    out.push(...this.ownDebugQuads);
    for (const child of this.childInstances) {
      child.getParticleDebugQuads(out);
    }
    return out;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    for (const view of this.emitterViews) {
      destroyEmitterView(this.root, this.bloomRoot, view);
    }
    this.emitterViews.length = 0;
    for (const derived of this.derivedTextures.values()) {
      derived.destroy(true);
    }
    this.derivedTextures.clear();
    for (const premultiplied of this.premultipliedTextures.values()) {
      premultiplied.destroy(true);
    }
    this.premultipliedTextures.clear();
    this.bloomRoot.destroy({ children: true });
    this.root.destroy({ children: true });
  }

  private spawnSubEmitterRequests(timeSeconds: number): void {
    if (!this.effectProvider || this.maxSubEmitterInstances <= 0) return;
    for (const request of this.runner.subEmitterRequests) {
      if (this.childInstances.size >= this.maxSubEmitterInstances) break;
      const childEffect = this.effectProvider.getEffect(request.effectFile);
      if (!childEffect) {
        this.ownMissingSubEmitterRefs.push(request.effectFile);
        continue;
      }
      const child = new PixiVfxEffectInstance({
        effect: applySubEmitterInheritance(childEffect, request),
        textureProvider: this.textureProvider,
        effectProvider: this.effectProvider,
        materialGraphProvider: this.materialGraphProvider,
        fallbackTextures: this.fallbackTextures,
        projection: this.projection,
        boundsArea: this.boundsArea,
        position: request.position,
        seed: seedFromSubEmitterRequest(request),
        timeSeconds: request.timeSeconds,
        subEmitterDepth: request.nextDepth,
        maxSubEmitterDepth: request.maxDepth,
        maxSubEmitterInstances: this.maxSubEmitterInstances,
        autoStart: true,
      });
      this.childInstances.add(child);
      this.root.addChild(child.root);
      this.bloomRoot.addChild(child.bloomRoot);
      this.spawnedSubEmittersLastFrame++;
      const catchupDelta = Math.max(0, timeSeconds - request.timeSeconds);
      if (catchupDelta > 0) {
        child.update(catchupDelta, {
          timeSeconds,
          draw: false,
        });
      }
    }
  }

  private updateSubEmitterInstances(
    deltaSeconds: number,
    timeSeconds: number,
  ): void {
    for (const child of [...this.childInstances]) {
      const alive = child.update(deltaSeconds, {
        timeSeconds,
        draw: false,
      });
      if (alive || child.stats.activeParticles > 0) continue;
      this.childInstances.delete(child);
      this.root.removeChild(child.root);
      this.bloomRoot.removeChild(child.bloomRoot);
      child.destroy();
    }
  }

  private clearSubEmitterInstances(): void {
    for (const child of [...this.childInstances]) {
      this.root.removeChild(child.root);
      this.bloomRoot.removeChild(child.bloomRoot);
      child.destroy();
    }
    this.childInstances.clear();
  }

  private drawParticleViews(
    timeSeconds: number,
    bloom: BloomDrawSettings,
  ): number {
    if (!this.runner.isActive) {
      this.hideEmitterViews();
      clearStateUploadBytes(this.runner.states);
      this.ownRenderGroupsLastFrame = 0;
      this.ownDebugQuads.length = 0;
      this.stats.bloomSourceParticles = 0;
      return 0;
    }
    this.ensureEmitterViews();
    this.ownDebugQuads.length = 0;
    let visibleParticles = 0;
    let renderGroups = 0;
    let bloomSourceParticles = 0;
    for (let i = 0; i < this.emitterViews.length; i++) {
      const emitter = this.runner.definition.emitters[i];
      const state = this.runner.states[i];
      const view = this.emitterViews[i];
      if (!emitter || !state || !view || !emitter.enabled) {
        if (view) clearEmitterView(view);
        if (state) state.uploadBytesLastFrame = 0;
        continue;
      }
      const drawResult = drawEmitterView(
        view,
        emitter,
        state,
        timeSeconds,
        this.projection,
        this.position,
        bloom,
        this.ownDebugQuads,
        i,
        this.resolveEmitterMaterialFixed(emitter),
        this.resolveEmitterParticleColorUsage(emitter),
      );
      visibleParticles += drawResult.visibleParticles;
      renderGroups += drawResult.renderGroups;
      bloomSourceParticles += drawResult.bloomSourceParticles;
    }
    this.ownRenderGroupsLastFrame = renderGroups;
    this.stats.bloomSourceParticles = bloomSourceParticles;
    return visibleParticles;
  }

  private hideEmitterViews(): void {
    for (const view of this.emitterViews) {
      clearEmitterView(view);
    }
    this.stats.bloomSourceParticles = 0;
  }

  private ensureEmitterViews(): void {
    const missingTextureRefs: VfxTextureAssetRef[] = [];
    const missingMaterialRefs: string[] = [];
    const materialUnsupportedFeatures: PixiVfxEffectStats["unsupportedFeatures"] =
      [];
    for (let i = 0; i < this.effect.emitters.length; i++) {
      const emitter = this.effect.emitters[i]!;
      const render = this.resolveEmitterRender(emitter);
      if (render.missingRef) missingTextureRefs.push(render.missingRef);
      if (render.missingTrailRef)
        missingTextureRefs.push(render.missingTrailRef);
      const missingMaterialRef = materialRenderBlockMissingRef(
        render.materialBlock,
      );
      if (missingMaterialRef) missingMaterialRefs.push(missingMaterialRef);
      const materialUnsupportedFeature = materialRenderBlockUnsupportedFeature(
        render.materialBlock,
        emitter,
        i,
      );
      if (materialUnsupportedFeature)
        materialUnsupportedFeatures.push(materialUnsupportedFeature);
      if (render.materialRenderFace && render.materialRenderFace !== "double") {
        materialUnsupportedFeatures.push({
          emitterId: emitter.id,
          emitterIndex: i,
          featureKey: "material.renderFaces",
          path: `emitters.${i}.render.material`,
          reason:
            "Material Render Faces has no effect in the Pixi flat-particle backend; use the Three 3D/world backend for front/back face culling.",
        });
      }
      const existing = this.emitterViews[i];
      if (existing?.key === render.key) continue;
      if (existing) {
        destroyEmitterView(this.root, this.bloomRoot, existing);
      }
      const materialShader = createEmitterTier2MaterialShader(
        render.tier2Material,
        render.texture,
      );
      const trailMaterialShader = createEmitterTier2MaterialShader(
        render.tier2Material,
        render.trailTexture,
      );
      const bloomMaterialShader = createEmitterTier2MaterialShader(
        render.tier2Material,
        render.texture,
      );
      const container = new ParticleContainer({
        texture: render.texture,
        shader: materialShader ?? undefined,
        dynamicProperties: {
          vertex: true,
          position: true,
          rotation: true,
          uvs: render.dynamicUvs,
          color: true,
        },
        boundsArea: this.boundsArea,
      });
      const trailContainer = new ParticleContainer({
        texture: render.trailTexture,
        shader: trailMaterialShader ?? undefined,
        dynamicProperties: {
          vertex: true,
          position: true,
          rotation: true,
          uvs: false,
          color: true,
        },
        boundsArea: this.boundsArea,
      });
      const bloomContainer = new ParticleContainer({
        texture: render.texture,
        shader: bloomMaterialShader ?? undefined,
        dynamicProperties: {
          vertex: true,
          position: true,
          rotation: true,
          uvs: render.dynamicUvs,
          color: true,
        },
        boundsArea: this.boundsArea,
      });
      bloomContainer.blendMode = "add";
      this.root.addChild(trailContainer);
      this.root.addChild(container);
      this.bloomRoot.addChild(bloomContainer);
      this.emitterViews[i] = {
        key: render.key,
        texture: render.texture,
        container,
        pool: [],
        depthSort: [],
        trailContainer,
        trailTexture: render.trailTexture,
        trailPool: [],
        bloomContainer,
        bloomPool: [],
        trailHistories: new Map(),
        trailEmitterPosition: copyVec3(this.position),
        frameTextures: render.frameTextures,
        ownedFrameTextures: render.ownedFrameTextures,
        animatedUvFrames: render.animatedUvFrames,
        materialUv: render.materialUv,
        materialBlock: render.materialBlock,
        materialShaders: [
          materialShader,
          trailMaterialShader,
          bloomMaterialShader,
        ].filter((shader): shader is PixiShader => shader !== null),
        dynamicUvs: render.dynamicUvs,
        effectiveBlend: render.effectiveBlend,
      };
    }
    while (this.emitterViews.length > this.effect.emitters.length) {
      const view = this.emitterViews.pop();
      if (!view) continue;
      destroyEmitterView(this.root, this.bloomRoot, view);
    }
    this.ownMissingTextureRefs = missingTextureRefs;
    this.ownMissingMaterialRefs = dedupeStrings(missingMaterialRefs);
    this.ownMaterialUnsupportedFeatures = materialUnsupportedFeatures;
    this.applyEmitterRenderOrder();
  }

  /**
   * Order emitter render views by `render.orderInLayer` (ascending, so lower
   * orders draw behind higher ones), keeping the authored emitter array order
   * as a stable tiebreaker. Each emitter keeps its trail container immediately
   * before its main container. Sub-emitter child instance roots are left after
   * the emitter views, so they continue to draw on top.
   */
  private applyEmitterRenderOrder(): void {
    const order = this.effect.emitters
      .map((emitter, index) => ({
        index,
        orderInLayer: emitter.render.orderInLayer,
      }))
      .sort((a, b) => a.orderInLayer - b.orderInLayer || a.index - b.index);
    let childIndex = 0;
    for (const { index } of order) {
      const view = this.emitterViews[index];
      if (!view) continue;
      this.root.setChildIndex(view.trailContainer, childIndex++);
      this.root.setChildIndex(view.container, childIndex++);
    }
  }

  private resolveEmitterRender(
    emitter: ParticleEmitterDefinition,
  ): ResolvedEmitterRender {
    const fallbackKey = fallbackTextureKeyForEmitter(emitter);
    const fallback = this.fallbackTextures[fallbackKey];
    // Material XOR texture (techspec §8): when a material is assigned, its
    // MainTex feeds the shared container texture; if the material declares no
    // MainTex the legacy render.texture fills it. Texture-only emitters are
    // unchanged (the implicit material is "sprite-master").
    const material = emitter.render.material;
    const materialGraph =
      material?.shaderId === SPRITE_MASTER_SHADER_ID
        ? this.spriteMasterGraph
        : material
          ? this.materialGraphProvider?.(material.shaderId)
          : undefined;
    const path = material
      ? resolveEffectiveMainTexPath(materialGraph, material) ||
        emitter.render.texture
      : emitter.render.texture;
    const renderKeyParts = [
      `mode:${emitter.mode}`,
      `blend:${emitter.render.blend}`,
      `depth:${Number(emitter.render.depthTest)}${Number(
        emitter.render.depthWrite,
      )}${Number(emitter.render.depthInk)}`,
      `opacity:${emitter.render.opacitySource}:${Number(
        emitter.render.opacityInvert,
      )}`,
      textureSheetRenderKey(emitter),
    ];
    let sourceTexture = fallback;
    let mainKey = `fallback:${fallbackKey}:uid:${fallback.uid}`;
    let missingRef: VfxTextureAssetRef | undefined;
    let artifact: MaterialArtifact | null = null;
    let resolvedMaterial: ResolvedEmitterMaterial | null = null;
    let materialBlock: PixiVfxMaterialRenderBlock | null = null;
    let materialMainTexUid: string | number | null = null;
    if (path) {
      const ref = createPixiVfxTextureRef(path);
      const resolved = this.textureProvider?.getTexture(ref);
      if (resolved) {
        sourceTexture = resolved;
        const resolvedMat = this.resolveEmitterMaterial(emitter, resolved.uid);
        resolvedMaterial = resolvedMat;
        artifact = resolvedMat?.artifact ?? null;
        materialBlock = resolvedMat?.block ?? null;
        materialMainTexUid = resolved.uid;
        mainKey = `texture:${path}:uid:${resolved.uid}`;
      } else {
        mainKey = `fallback:${fallbackKey}:missing:${path}:uid:${fallback.uid}`;
        missingRef = ref;
      }
    }
    // A material may still apply over the fallback texture (e.g. a Tier-1 tint
    // material with no MainTex), so resolve it for the render key even when the
    // texture didn't resolve.
    if (!resolvedMaterial && material) {
      resolvedMaterial = this.resolveEmitterMaterial(
        emitter,
        sourceTexture.uid,
      );
      artifact = resolvedMaterial?.artifact ?? null;
      materialBlock = resolvedMaterial?.block ?? null;
      materialMainTexUid = sourceTexture.uid;
    }
    if (
      !materialBlock &&
      material &&
      artifact?.tier === "tier2-shader" &&
      !canRenderTier2ParticleContainerShader(artifact)
    ) {
      materialBlock = createUnsupportedTier2MaterialBlock(
        material.shaderId,
        artifact,
      );
    }
    // Tier 0 BAKE supersedes per-emitter opacity derivation (the material's
    // own opacity output is baked in); other tiers keep the legacy path. A
    // blocked material never renders with a legacy/default shader.
    const texture =
      !materialBlock &&
      material &&
      resolvedMaterial?.graph &&
      artifact?.tier === "tier0-bake"
        ? this.resolveMaterialBakeTexture(
            sourceTexture,
            resolvedMaterial.graph,
            material,
            artifact,
          )
        : sourceTexture;
    let renderedTexture = materialBlock
      ? texture
      : artifact?.tier === "tier0-bake"
        ? texture
        : this.resolveDerivedTexture(texture, emitter);
    // I13-A: a texture-only premultiplied emitter binds an already-premultiplied
    // source (no upload multiply, no normal→normal-npm swap). Layered AFTER the
    // opacity derivation so both compose.
    if (
      !materialBlock &&
      artifact?.tier !== "tier0-bake" &&
      emitter.render.blend === "premultiplied"
    ) {
      renderedTexture = this.resolvePremultipliedTexture(renderedTexture);
    }
    const frames = createTextureSheetFrameTextures(renderedTexture, emitter);
    // materialShaderId render-key axis (techspec §6.5): Tier 0/1/3 collapse to
    // "sprite-master" (no variant entropy); Tier 2 mints a distinct id counted
    // against the ≤4-6 cap. Empty for texture-only emitters (filtered out below,
    // so their key stays byte-identical). The Tier-0 bake hash forks the key so
    // an override change rebuilds the baked texture.
    const materialKey = materialBlock
      ? materialRenderBlockKey(materialBlock)
      : material && artifact && resolvedMaterial?.graph
        ? `materialShaderId:${artifact.shaderId}` +
          (artifact.tier === "tier0-bake" && artifact.bakeHash
            ? `:bake:${artifact.bakeHash}`
            : "") +
          (artifact.tier === "tier2-shader"
            ? `:material:${materialDigest(
                resolvedMaterial.graph,
                material,
                materialMainTexUid,
              )}`
            : "")
        : "";
    const materialUv =
      !materialBlock && material && artifact
        ? materialAnimatedUvFromArtifact(artifact)
        : null;
    const tier2Material =
      !materialBlock &&
      material &&
      resolvedMaterial &&
      resolvedMaterial.graph &&
      artifact?.tier === "tier2-shader" &&
      canRenderTier2ParticleContainerShader(artifact)
        ? {
            graph: resolvedMaterial.graph,
            instance: material,
            artifact,
            textureSheetTiles: textureSheetTiles(emitter),
          }
        : null;
    const materialUvKey = materialUvRenderKey(materialUv);
    // Material-authoritative blends (masked/opaque) fork the batch key; the
    // legacy emitter-blend axis above stays byte-identical for normal/add.
    const effectiveBlend = resolveEffectiveParticleBlend(
      emitter.render.blend,
      artifact?.blend ?? null,
    );
    const materialBlendKey = materialBlendOverridesEmitter(artifact?.blend)
      ? `materialBlend:${effectiveBlend}`
      : "";
    // The trail container can use its own authored texture. When unset (the
    // default), trails reuse the particle texture. Missing trail textures fall
    // back to the particle texture and are reported through missing-texture
    // stats so they validate like the main texture.
    let trailTexture = renderedTexture;
    let trailKey = "trail:particle";
    let missingTrailRef: VfxTextureAssetRef | undefined;
    const trailPath = emitter.modules.trails
      ? emitter.advanced.trails.texture
      : null;
    if (trailPath) {
      const trailRef = createPixiVfxTextureRef(trailPath);
      const resolvedTrail = this.textureProvider?.getTexture(trailRef);
      if (resolvedTrail) {
        trailTexture = resolvedTrail;
        trailKey = `trail:${trailPath}:uid:${resolvedTrail.uid}`;
      } else {
        trailKey = `trail:missing:${trailPath}`;
        missingTrailRef = trailRef;
      }
    }
    let frameTextures = frames.textures;
    let ownedFrameTextures = [...frames.ownedTextures];
    let animatedUvFrames: AnimatedUvFrameTexture[] = [];
    if (materialUv) {
      const animatedFrames = createAnimatedUvFrameTextures(frameTextures);
      frameTextures = animatedFrames.textures;
      ownedFrameTextures = [
        ...ownedFrameTextures,
        ...animatedFrames.ownedTextures,
      ];
      animatedUvFrames = animatedFrames.frames;
    }
    return {
      key: [
        mainKey,
        ...renderKeyParts,
        materialKey,
        materialBlendKey,
        materialUvKey,
        trailKey,
      ]
        .filter(Boolean)
        .join("|"),
      texture: renderedTexture,
      trailTexture,
      frameTextures,
      ownedFrameTextures,
      animatedUvFrames,
      materialUv,
      materialBlock,
      tier2Material,
      dynamicUvs:
        !materialBlock && (frameTextures.length > 1 || materialUv != null),
      effectiveBlend,
      materialRenderFace: resolvedMaterial?.graph?.side ?? "double",
      missingRef,
      missingTrailRef,
    };
  }

  /**
   * Tier-0 BAKE: evaluate the material's static graph per-texel into a derived
   * texture, cached alongside legacy alpha-derivation. The cache key carries the
   * artifact's deterministic `bakeHash` (graph+overrides+mainTexUid) so bakes
   * are reused across frames/emitters and never collide with legacy derivation
   * (which passes no bake hash). Falls back to the source when baking is
   * unavailable (headless / unreadable pixels), mirroring resolveDerivedTexture.
   */
  private resolveMaterialBakeTexture(
    source: Texture,
    graph: ShaderGraph,
    instance: MaterialInstance,
    artifact: MaterialArtifact,
  ): Texture {
    // opacitySource/invert are irrelevant for a material bake (the graph owns
    // its opacity); the bakeHash fully disambiguates, so pass the no-derivation
    // default and let the hash separate this from any legacy alpha derivation.
    const key = derivedTextureCacheKey(
      source.uid,
      "textureAlpha",
      false,
      artifact.bakeHash,
    );
    const cached = this.derivedTextures.get(key);
    if (cached) return cached;
    const baked = createMaterialBakeTexture(source, graph, instance, {
      samplerForPath: (path, uv, node) =>
        samplePixiTexturePath(path, uv, node, this.textureProvider) ?? null,
    });
    if (!baked) return source;
    this.derivedTextures.set(key, baked);
    return baked;
  }

  /**
   * Resolve the texture used for rendering, applying texture-channel/luminance
   * alpha derivation when the emitter's opacity source requires it. Derived
   * textures are cached per (source, opacity source, invert) so we never
   * regenerate them per frame. Falls back to the source texture when derivation
   * is unavailable (no DOM canvas / unreadable pixels, e.g. headless tests).
   */
  private resolveDerivedTexture(
    source: Texture,
    emitter: ParticleEmitterDefinition,
  ): Texture {
    const opacitySource = emitter.render.opacitySource;
    if (!opacitySourceNeedsDerivation(opacitySource)) return source;
    const invert = emitter.render.opacityInvert;
    const key = derivedTextureCacheKey(source.uid, opacitySource, invert);
    const cached = this.derivedTextures.get(key);
    if (cached) return cached;
    const derived = createDerivedAlphaTexture(source, opacitySource, invert);
    if (!derived) return source;
    this.derivedTextures.set(key, derived);
    return derived;
  }

  /**
   * Resolve the premultiplied-alpha source texture (I13-A) for a texture-only
   * emitter whose `render.blend === "premultiplied"`. The bound source is tagged
   * `alphaMode:"premultiplied-alpha"` so Pixi does not premultiply-on-upload and
   * does not swap the `normal` container blend to `normal-npm`. Cached by source
   * uid so we never rebuild it per frame; falls back to the source when the
   * resource is unreadable (headless), mirroring resolveDerivedTexture.
   */
  private resolvePremultipliedTexture(source: Texture): Texture {
    const cached = this.premultipliedTextures.get(source.uid);
    if (cached) return cached;
    const premultiplied = createPremultipliedSourceTexture(source);
    if (premultiplied === source) return source;
    this.premultipliedTextures.set(source.uid, premultiplied);
    return premultiplied;
  }

  private refreshUnsupportedModules(): void {
    this.ownUnsupportedModules = collectPixiVfxUnsupportedModules(this.effect);
    this.ownUnsupportedFeatures = collectPixiVfxUnsupportedFeatures(
      this.effect,
    );
  }

  private syncRunnerStats(visibleParticles: number): void {
    let childActiveParticles = 0;
    let childVisibleParticles = 0;
    let childCapacity = 0;
    let childEmittedLastFrame = 0;
    let childUploadBytesLastFrame = 0;
    let childSpawnedSubEmittersLastFrame = 0;
    let childRenderGroupsLastFrame = 0;
    let childBloomSourceParticles = 0;
    const missingTextureRefs = [...this.ownMissingTextureRefs];
    const missingSubEmitterRefs = [...this.ownMissingSubEmitterRefs];
    const missingMaterialRefs = [...this.ownMissingMaterialRefs];
    const unsupportedModules = [...this.ownUnsupportedModules];
    const unsupportedFeatures = [
      ...this.ownUnsupportedFeatures,
      ...this.ownMaterialUnsupportedFeatures,
    ];
    for (const child of this.childInstances) {
      childActiveParticles += child.stats.activeParticles;
      childVisibleParticles += child.stats.visibleParticles;
      childCapacity += child.stats.capacity;
      childEmittedLastFrame += child.stats.emittedLastFrame;
      childUploadBytesLastFrame += child.stats.uploadBytesLastFrame;
      childSpawnedSubEmittersLastFrame +=
        child.stats.spawnedSubEmittersLastFrame;
      childRenderGroupsLastFrame += child.stats.renderGroupsLastFrame;
      childBloomSourceParticles += child.stats.bloomSourceParticles;
      missingTextureRefs.push(...child.stats.missingTextureRefs);
      missingSubEmitterRefs.push(...child.stats.missingSubEmitterRefs);
      missingMaterialRefs.push(...child.stats.missingMaterialRefs);
      unsupportedModules.push(...child.stats.unsupportedModules);
      unsupportedFeatures.push(...child.stats.unsupportedFeatures);
    }
    this.stats.activeParticles =
      this.runner.stats.activeParticles + childActiveParticles;
    this.stats.visibleParticles = visibleParticles + childVisibleParticles;
    this.stats.capacity = this.runner.stats.capacity + childCapacity;
    this.stats.emittedLastFrame =
      this.runner.stats.emittedLastFrame + childEmittedLastFrame;
    this.stats.uploadBytesLastFrame =
      sumStateUploadBytes(this.runner.states) + childUploadBytesLastFrame;
    this.stats.spawnedSubEmittersLastFrame =
      this.spawnedSubEmittersLastFrame + childSpawnedSubEmittersLastFrame;
    this.stats.renderGroupsLastFrame =
      this.ownRenderGroupsLastFrame + childRenderGroupsLastFrame;
    this.stats.bloomSourceParticles += childBloomSourceParticles;
    this.stats.missingTextureRefs = dedupeTextureRefs(missingTextureRefs);
    this.stats.missingSubEmitterRefs = dedupeStrings(missingSubEmitterRefs);
    this.stats.missingMaterialRefs = dedupeStrings(missingMaterialRefs);
    this.stats.unsupportedModules = unsupportedModules;
    this.stats.unsupportedFeatures = unsupportedFeatures;
  }
}

export class PixiVfxRenderer {
  readonly root: Container;
  readonly bloomSourceRoot = new Container();
  readonly stats: PixiVfxRendererStats = {
    ...createEmptyEffectStats(),
    effectCount: 0,
  };

  private readonly instances = new Set<PixiVfxEffectInstance>();
  private readonly bloomComposer?: BloomComposer;
  private bloomConfig: ResolvedBloomConfig;
  private textureProvider?: PixiVfxTextureProvider;
  private effectProvider?: PixiVfxEffectProvider;
  private materialGraphProvider?: PixiVfxMaterialGraphProvider;
  private fallbackTextures?: PixiVfxFallbackTextures;
  private projection: PixiVfxProjection;
  private boundsArea: Rectangle;
  private readonly maxSubEmitterDepth?: number;
  private readonly maxSubEmitterInstances?: number;
  private readonly maxEventsPerFrame?: number;
  private readonly maxSubEmitterRequestsPerFrame?: number;

  constructor(options: PixiVfxRendererOptions = {}) {
    this.root = new Container();
    this.bloomConfig = normalizeBloomConfig(options.bloom);
    this.bloomComposer = options.pixiRenderer
      ? new BloomComposer(options.pixiRenderer)
      : undefined;
    this.textureProvider = options.textureProvider;
    this.effectProvider = options.effectProvider;
    this.materialGraphProvider = options.materialGraphProvider;
    this.fallbackTextures = options.fallbackTextures;
    this.projection = options.projection ?? createPixiVfx2dProjection();
    this.boundsArea = options.boundsArea ?? DEFAULT_BOUNDS.clone();
    this.maxSubEmitterDepth = options.maxSubEmitterDepth;
    this.maxSubEmitterInstances = options.maxSubEmitterInstances;
    this.maxEventsPerFrame = options.maxEventsPerFrame;
    this.maxSubEmitterRequestsPerFrame = options.maxSubEmitterRequestsPerFrame;
    if (this.bloomComposer) {
      this.root.addChild(this.bloomComposer.outputSprite);
    }
    options.parent?.addChild(this.root);
  }

  createEffect(
    effect: unknown,
    options: PixiVfxCreateEffectOptions = {},
  ): PixiVfxEffectInstance {
    const instance = new PixiVfxEffectInstance({
      effect,
      textureProvider: options.textureProvider ?? this.textureProvider,
      effectProvider: options.effectProvider ?? this.effectProvider,
      materialGraphProvider:
        options.materialGraphProvider ?? this.materialGraphProvider,
      fallbackTextures: options.fallbackTextures ?? this.fallbackTextures,
      projection: options.projection ?? this.projection,
      boundsArea: options.boundsArea ?? this.boundsArea,
      position: options.position,
      seed: options.seed,
      timeSeconds: options.timeSeconds,
      autoStart: options.autoStart,
      subEmitterDepth: options.subEmitterDepth,
      maxSubEmitterDepth: options.maxSubEmitterDepth ?? this.maxSubEmitterDepth,
      maxSubEmitterInstances:
        options.maxSubEmitterInstances ?? this.maxSubEmitterInstances,
      maxEventsPerFrame: options.maxEventsPerFrame ?? this.maxEventsPerFrame,
      maxSubEmitterRequestsPerFrame:
        options.maxSubEmitterRequestsPerFrame ??
        this.maxSubEmitterRequestsPerFrame,
    });
    this.instances.add(instance);
    this.bloomSourceRoot.addChild(instance.bloomRoot);
    if (options.addToStage !== false) {
      this.root.addChild(instance.root);
      this.keepBloomOverlayBehindScene();
    }
    this.refreshStats();
    return instance;
  }

  removeEffect(instance: PixiVfxEffectInstance, destroy = true): void {
    if (!this.instances.delete(instance)) return;
    this.root.removeChild(instance.root);
    this.bloomSourceRoot.removeChild(instance.bloomRoot);
    if (destroy) instance.destroy();
    this.refreshStats();
  }

  setTextureProvider(provider: PixiVfxTextureProvider | undefined): void {
    this.textureProvider = provider;
    for (const instance of this.instances) {
      instance.setTextureProvider(provider);
    }
    this.refreshStats();
  }

  setEffectProvider(provider: PixiVfxEffectProvider | undefined): void {
    this.effectProvider = provider;
    for (const instance of this.instances) {
      instance.setEffectProvider(provider);
    }
    this.refreshStats();
  }

  setMaterialGraphProvider(
    provider: PixiVfxMaterialGraphProvider | undefined,
  ): void {
    this.materialGraphProvider = provider;
    for (const instance of this.instances) {
      instance.setMaterialGraphProvider(provider);
    }
    this.refreshStats();
  }

  setFallbackTextures(textures: PixiVfxFallbackTextures): void {
    this.fallbackTextures = textures;
    for (const instance of this.instances) {
      instance.setFallbackTextures(textures);
    }
    this.refreshStats();
  }

  setProjection(projection: PixiVfxProjection): void {
    this.projection = projection;
    for (const instance of this.instances) {
      instance.setProjection(projection);
    }
  }

  setBoundsArea(boundsArea: Rectangle): void {
    this.boundsArea = boundsArea;
    for (const instance of this.instances) {
      instance.setBoundsArea(boundsArea);
    }
  }

  update(
    deltaSeconds: number,
    optionsOrTimeSeconds: PixiVfxUpdateOptions | number = {},
  ): PixiVfxRendererStats {
    const options =
      typeof optionsOrTimeSeconds === "number"
        ? { timeSeconds: optionsOrTimeSeconds }
        : optionsOrTimeSeconds;
    const bloom = this.bloomDrawSettings();
    for (const instance of this.instances) {
      instance.update(deltaSeconds, optionsOrTimeSeconds, bloom);
    }
    if (options.draw !== false) {
      this.renderBloom();
    } else {
      if (this.bloomComposer) this.bloomComposer.outputSprite.visible = false;
      this.stats.bloomActive = false;
      this.stats.bloomPasses = 0;
      this.stats.bloomRenderScale = 0;
    }
    this.refreshStats();
    return this.stats;
  }

  draw(timeSeconds?: number): PixiVfxRendererStats {
    const bloom = this.bloomDrawSettings();
    for (const instance of this.instances) {
      instance.draw(timeSeconds, bloom);
    }
    this.renderBloom();
    this.refreshStats();
    return this.stats;
  }

  getParticleDebugQuads(): PixiVfxParticleDebugQuad[] {
    const quads: PixiVfxParticleDebugQuad[] = [];
    for (const instance of this.instances) {
      instance.getParticleDebugQuads(quads);
    }
    return quads;
  }

  destroy(): void {
    for (const instance of [...this.instances]) {
      this.removeEffect(instance, true);
    }
    if (this.bloomComposer?.outputSprite.parent === this.root) {
      this.root.removeChild(this.bloomComposer.outputSprite);
    }
    this.bloomComposer?.destroy();
    this.bloomSourceRoot.destroy({ children: false });
    this.root.destroy({ children: true });
  }

  setBloomOptions(options: PixiVfxBloomOptions | undefined): void {
    this.bloomConfig = normalizeBloomConfig(options);
    if (!this.bloomConfig.enabled) {
      this.bloomSourceRoot.visible = false;
      if (this.bloomComposer) this.bloomComposer.outputSprite.visible = false;
      this.stats.bloomActive = false;
      this.stats.bloomSourceParticles = 0;
      this.stats.bloomPasses = 0;
      this.stats.bloomRenderScale = 0;
    }
  }

  private refreshStats(): void {
    const aggregate = createEmptyEffectStats();
    aggregate.unsupportedModules = [];
    aggregate.unsupportedFeatures = [];
    aggregate.missingTextureRefs = [];
    aggregate.missingMaterialRefs = [];
    for (const instance of this.instances) {
      aggregate.activeParticles += instance.stats.activeParticles;
      aggregate.visibleParticles += instance.stats.visibleParticles;
      aggregate.capacity += instance.stats.capacity;
      aggregate.emittedLastFrame += instance.stats.emittedLastFrame;
      aggregate.uploadBytesLastFrame += instance.stats.uploadBytesLastFrame;
      aggregate.spawnedSubEmittersLastFrame +=
        instance.stats.spawnedSubEmittersLastFrame;
      aggregate.renderGroupsLastFrame += instance.stats.renderGroupsLastFrame;
      aggregate.bloomSourceParticles += instance.stats.bloomSourceParticles;
      aggregate.unsupportedModules.push(...instance.stats.unsupportedModules);
      aggregate.unsupportedFeatures.push(...instance.stats.unsupportedFeatures);
      aggregate.missingTextureRefs.push(...instance.stats.missingTextureRefs);
      aggregate.missingMaterialRefs.push(...instance.stats.missingMaterialRefs);
      aggregate.missingSubEmitterRefs.push(
        ...instance.stats.missingSubEmitterRefs,
      );
    }
    this.stats.activeParticles = aggregate.activeParticles;
    this.stats.visibleParticles = aggregate.visibleParticles;
    this.stats.capacity = aggregate.capacity;
    this.stats.emittedLastFrame = aggregate.emittedLastFrame;
    this.stats.uploadBytesLastFrame = aggregate.uploadBytesLastFrame;
    this.stats.spawnedSubEmittersLastFrame =
      aggregate.spawnedSubEmittersLastFrame;
    this.stats.renderGroupsLastFrame = aggregate.renderGroupsLastFrame;
    this.stats.bloomSourceParticles = aggregate.bloomSourceParticles;
    if (aggregate.bloomSourceParticles <= 0) {
      this.stats.bloomActive = false;
      this.stats.bloomPasses = 0;
      this.stats.bloomRenderScale = 0;
    }
    this.stats.missingTextureRefs = aggregate.missingTextureRefs;
    this.stats.missingSubEmitterRefs = aggregate.missingSubEmitterRefs;
    this.stats.missingMaterialRefs = aggregate.missingMaterialRefs;
    this.stats.unsupportedModules = aggregate.unsupportedModules;
    this.stats.unsupportedFeatures = aggregate.unsupportedFeatures;
    this.stats.effectCount = this.instances.size;
  }

  private bloomDrawSettings(): BloomDrawSettings {
    return bloomDrawSettings(this.bloomConfig);
  }

  private renderBloom(): void {
    const sourceParticles = sumBloomSourceParticles(this.instances);
    this.bloomSourceRoot.visible =
      Boolean(this.bloomComposer) &&
      this.bloomConfig.enabled &&
      this.bloomConfig.intensity > 0 &&
      sourceParticles > 0;
    this.syncBloomCoordinateSpace();
    const passes =
      this.bloomComposer?.render(
        this.bloomSourceRoot,
        sourceParticles,
        this.bloomConfig,
      ) ?? 0;
    this.stats.bloomActive =
      Boolean(this.bloomComposer) && this.bloomConfig.enabled && passes > 0;
    this.stats.bloomSourceParticles = sourceParticles;
    this.stats.bloomPasses = passes;
    this.stats.bloomRenderScale = this.stats.bloomActive
      ? this.bloomConfig.renderScale
      : 0;
  }

  private syncBloomCoordinateSpace(): void {
    const overlay = this.bloomComposer?.outputSprite;
    if (!overlay) return;
    const globalPosition = this.root.getGlobalPosition();
    this.bloomSourceRoot.position.set(globalPosition.x, globalPosition.y);
    overlay.position.set(-globalPosition.x, -globalPosition.y);
  }

  private keepBloomOverlayBehindScene(): void {
    const overlay = this.bloomComposer?.outputSprite;
    if (overlay?.parent === this.root) {
      this.root.setChildIndex(overlay, 0);
    }
  }
}

export function normalizePixiVfxEffect(
  value: unknown,
): ParticleEffectDefinition {
  if (isRecord(value) && value.kind === "vfx-effect") {
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

export function collectPixiVfxEffectTextureRefs(
  effect: unknown,
  materialGraphProvider?: PixiVfxMaterialGraphProvider,
): VfxTextureAssetRef[] {
  const normalized = normalizePixiVfxEffect(effect);
  return collectParticleTextureRefs(normalized, { materialGraphProvider });
}

function drawEmitterView(
  view: EmitterView,
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  timeSeconds: number,
  projection: PixiVfxProjection,
  emitterPosition: Vec3,
  bloom: BloomDrawSettings,
  debugQuads?: PixiVfxParticleDebugQuad[],
  emitterIndex = 0,
  materialFixed: MaterialFixedDescriptor | null = null,
  particleColorUsage: ParticleColorUsage = APPLY_EMITTER_PARTICLE_COLOR,
): EmitterDrawResult {
  // Effective blend is resolved at view-build time (it forks the render key,
  // so any blend change rebuilds the view before this runs). Opaque means "no
  // blending, overwrite destination"; masked keeps normal blending and relies
  // on the Tier-2 discard / baked binary alpha (no depth semantics on Pixi).
  // Premultiplied (I13-A) also maps to "normal" (= [ONE, 1-SA]); its source is
  // tagged premultiplied-alpha at view-build so the blend stays glow-capable.
  view.container.blendMode =
    view.effectiveBlend === "opaque"
      ? "none"
      : view.effectiveBlend === "additive"
        ? "add"
        : "normal";
  view.trailContainer.blendMode = view.container.blendMode;
  if (view.materialBlock) {
    clearEmitterView(view);
    state.uploadBytesLastFrame = 0;
    return {
      visibleParticles: 0,
      renderGroups: 0,
      bloomSourceParticles: 0,
    };
  }
  for (const shader of view.materialShaders) {
    updateTier2ParticleMaterialShaderTime(shader, timeSeconds);
    updateTier2ParticleMaterialShaderDynamicParams(
      shader,
      sampleEmitterDynamicParamsRepresentative(emitter),
    );
  }
  updateAnimatedUvFrameTextures(view, timeSeconds);
  applyLocalSpaceTrailShift(view, emitter, projection, emitterPosition);
  view.depthSort.length = 0;
  let visibleCount = 0;
  let bloomSourceCount = 0;
  for (let i = 0; i < state.activeCount; i++) {
    const particle =
      view.pool[visibleCount] ??
      createParticle(view.frameTextures[0] ?? view.texture);
    const sample = updateParticle(
      particle,
      emitter,
      state,
      i,
      timeSeconds,
      projection,
      view.frameTextures,
      emitterPosition,
      bloom,
      materialFixed,
      particleColorUsage,
      view.effectiveBlend,
    );
    if (!sample) continue;
    appendParticleDebugQuad(debugQuads, emitter, emitterIndex, i, sample);
    if (!sample.visible) continue;
    view.pool[visibleCount] = particle;
    updateTrailHistory(view, emitter, sample, timeSeconds);
    if (bloom.enabled && sample.emissiveStrength > bloom.threshold) {
      const bloomParticle =
        view.bloomPool[bloomSourceCount] ?? createParticle(sample.texture);
      copyBloomParticle(bloomParticle, sample, bloom);
      view.bloomPool[bloomSourceCount] = bloomParticle;
      view.bloomContainer.particleChildren[bloomSourceCount] = bloomParticle;
      bloomSourceCount++;
    }
    view.depthSort.push({
      particle,
      depth: sample.depth,
      start: sample.start,
      seed: sample.seed,
    });
    visibleCount++;
  }
  // Draw in a stable per-particle order. ParticleContainer paints in array
  // order (index 0 first/bottom, last last/top), so distanceFarFirst sorts the
  // larger projected depth values first and leaves nearest particles on top.
  sortPixiDepthEntries(view.depthSort, emitter.render.sortMode);
  for (let i = 0; i < view.depthSort.length; i++) {
    view.container.particleChildren[i] = view.depthSort[i]!.particle;
  }
  view.container.particleChildren.length = visibleCount;
  view.container.update();
  view.bloomContainer.particleChildren.length = bloomSourceCount;
  view.bloomContainer.update();
  const trailCount = drawTrailView(view, emitter, timeSeconds);
  state.uploadBytesLastFrame = estimateParticleUploadBytes({
    liveParticles: visibleCount,
    trailParticles: trailCount,
    bloomParticles: bloomSourceCount,
    dynamicUvs: view.dynamicUvs,
  });
  return {
    visibleParticles: visibleCount + trailCount,
    renderGroups:
      (visibleCount > 0 ? 1 : 0) +
      (trailCount > 0 ? 1 : 0) +
      (bloomSourceCount > 0 ? 1 : 0),
    bloomSourceParticles: bloomSourceCount,
  };
}

function sortPixiDepthEntries(
  entries: DepthSortEntry[],
  sortMode: ParticleEmitterDefinition["render"]["sortMode"],
): void {
  switch (sortMode) {
    case "distanceNearFirst":
      entries.sort(
        (a, b) => a.depth - b.depth || a.start - b.start || a.seed - b.seed,
      );
      return;
    case "oldestFirst":
      entries.sort((a, b) => b.start - a.start || b.seed - a.seed);
      return;
    case "none":
    case "youngestFirst":
      entries.sort((a, b) => a.start - b.start || a.seed - b.seed);
      return;
    case "distanceFarFirst":
    default:
      entries.sort(
        (a, b) => b.depth - a.depth || a.start - b.start || a.seed - b.seed,
      );
      return;
  }
}

function appendParticleDebugQuad(
  debugQuads: PixiVfxParticleDebugQuad[] | undefined,
  emitter: ParticleEmitterDefinition,
  emitterIndex: number,
  particleIndex: number,
  sample: ParticleRenderSample,
): void {
  if (!debugQuads || debugQuads.length >= PARTICLE_DEBUG_QUAD_LIMIT) return;
  debugQuads.push({
    emitterId: emitter.id,
    emitterIndex,
    particleIndex,
    mode: emitter.mode,
    x: sample.x,
    y: sample.y,
    width: Math.max(
      2,
      Math.abs(sample.scaleX) * Math.max(1, sample.texture.width),
    ),
    height: Math.max(
      2,
      Math.abs(sample.scaleY) * Math.max(1, sample.texture.height),
    ),
    anchorX: sample.anchorX,
    anchorY: sample.anchorY,
    rotation: sample.rotation,
    depth: sample.depth,
    alpha: sample.alpha,
  });
}

function updateParticle(
  particle: Particle,
  emitter: ParticleEmitterDefinition,
  state: ParticleEmitterRuntimeState,
  index: number,
  timeSeconds: number,
  projection: PixiVfxProjection,
  frameTextures: Texture[],
  emitterPosition: Vec3,
  bloom: BloomDrawSettings,
  materialFixed: MaterialFixedDescriptor | null = null,
  particleColorUsage: ParticleColorUsage = APPLY_EMITTER_PARTICLE_COLOR,
  effectiveBlend: EffectiveParticleBlend = emitter.render.blend,
): ParticleRenderSample | undefined {
  const data = state.instanceData;
  const offset = index * PARTICLE_INSTANCE_STRIDE;
  const start = data[offset + 3] ?? 0;
  const life = Math.max(0.001, data[offset + 7] ?? 0);
  const age = timeSeconds - start;
  const unclampedAge = age / life;
  if (unclampedAge < -0.000001 || unclampedAge > 1.000001) return undefined;
  const normalizedAge = clamp(unclampedAge, 0, 1);
  const ageSeconds = Math.max(0, age);
  const loopAge = clamp(state.age / Math.max(0.001, emitter.duration), 0, 1);

  const seed = data[offset + 8] ?? 0.5;
  // Unified analytic motion (gravity/drag + velocity-over-lifetime), the same
  // evaluator events/collision/sub-emitters use, so they agree with the render.
  const motion = sampleParticleMotion(
    emitter,
    state,
    index,
    ageSeconds,
    normalizedAge,
    emitterPosition,
  );
  const velocity = motion.velocity;
  const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
  const alignToVelocity = emitter.render.alignAxis === "velocity";
  if (alignToVelocity) {
    pixiAnalyticVelocityScratch[0] = velocity[0];
    pixiAnalyticVelocityScratch[1] = velocity[1];
    pixiAnalyticVelocityScratch[2] = velocity[2];
  }
  const world: Vec3 = [
    motion.position[0],
    motion.position[1],
    motion.position[2],
  ];
  // Split module pass (was applyParticleMotionModules): the PRE-collision
  // displaced position feeds the effective-alignment forward difference
  // below, saving its second motion evaluation (I13-F: collision excluded).
  const motionModuleSample: ParticleMotionSample = {
    seed,
    normalizedAge,
    loopAge,
    ageSeconds,
    timeSeconds,
    world,
    velocity,
  };
  applyPositionalMotionModules(emitter, motionModuleSample);
  if (alignToVelocity) {
    pixiPreCollisionWorldScratch[0] = world[0];
    pixiPreCollisionWorldScratch[1] = world[1];
    pixiPreCollisionWorldScratch[2] = world[2];
  }
  if (
    emitter.modules.collision &&
    !applyCollisionResponse(emitter, motionModuleSample)
  ) {
    return undefined;
  }
  const projected = projection.project(world);
  if (!projected || projected.visible === false) return undefined;

  const runtimeVectorOffset = index * PARTICLE_RUNTIME_VECTOR_STRIDE;
  const flags = state.runtimeFlagsData[index] ?? 0;
  const spawnDirection: Vec3 = [
    state.spawnDirectionData[runtimeVectorOffset + 0] ?? 0,
    state.spawnDirectionData[runtimeVectorOffset + 1] ?? 1,
    state.spawnDirectionData[runtimeVectorOffset + 2] ?? 0,
  ];
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
  // Slots 11/12 hold per-particle INITIAL X/Y size. Old/uniform effects write
  // the same value into both slots.
  const initSizeX = Math.max(0, data[offset + 11] ?? 1);
  const initSizeY = Math.max(0, data[offset + 12] ?? initSizeX);
  const overLifeSizeX = emitter.modules.size
    ? Math.max(
        0,
        sampleParticleScalarValue(sizeSettingsX, normalizedAge, seed, loopAge),
      )
    : 1;
  const overLifeSizeY = emitter.modules.size
    ? Math.max(
        0,
        sampleParticleScalarValue(sizeSettingsY, normalizedAge, seed, loopAge),
      )
    : 1;
  const sizeBySpeed = particleSizeBySpeedMultiplier(
    emitter,
    speed,
    seed,
    loopAge,
  );
  const sizeX = initSizeX * overLifeSizeX * sizeBySpeed;
  const sizeY = initSizeY * overLifeSizeY * sizeBySpeed;
  const pixelsPerWorldUnit = Math.max(
    0.000001,
    projection.pixelsPerWorldUnit(world),
  );
  const pixelSizeX = Math.max(0.01, sizeX * pixelsPerWorldUnit);
  const pixelSizeY = Math.max(0.01, sizeY * pixelsPerWorldUnit);
  const pixelSize = Math.max(pixelSizeX, pixelSizeY);
  const nextTexture = selectParticleFrameTexture(
    frameTextures,
    emitter,
    normalizedAge,
    seed,
    loopAge,
  );
  if (particle.texture !== nextTexture) {
    particle.texture = nextTexture;
  }
  const texture = particle.texture;
  const trail = particleTrailSample(
    emitter,
    normalizedAge,
    speed,
    seed,
    loopAge,
  );
  // I13-F: velocity-aligned sprites follow the effective (noise/force-inclusive)
  // velocity. Trail-stretch keeps analytic velocity (Non-Goals) — the two paths
  // are mutually exclusive (stretchesAlongMotion), so one variable serves both.
  const useEffectiveAlignment = alignToVelocity && !trail.stretchesAlongMotion;
  let alignmentSourceVelocity: Vec3 = velocity;
  let alignmentSpeed = speed;
  if (useEffectiveAlignment) {
    const eff = computeEffectiveAlignmentVelocity(
      emitter,
      state,
      index,
      ageSeconds,
      life,
      timeSeconds,
      seed,
      loopAge,
      emitterPosition,
      1,
      pixiPreCollisionWorldScratch,
      pixiEffectiveAlignmentVelocity,
    );
    eff[0] += velocity[0] - pixiAnalyticVelocityScratch[0];
    eff[1] += velocity[1] - pixiAnalyticVelocityScratch[1];
    eff[2] += velocity[2] - pixiAnalyticVelocityScratch[2];
    alignmentSourceVelocity = eff;
    alignmentSpeed = Math.hypot(eff[0], eff[1], eff[2]);
  }
  const motionDirection: Vec3 =
    alignmentSpeed > 0.000001
      ? [
          alignmentSourceVelocity[0],
          alignmentSourceVelocity[1],
          alignmentSourceVelocity[2],
        ]
      : spawnDirection;
  const alignDirection = !trail.stretchesAlongMotion
    ? particleAlignmentDirection(
        emitter,
        flags,
        motionDirection,
        alignmentSpeed,
        spawnDirection,
      )
    : null;
  const renderScaleX =
    emitter.mode === "mesh"
      ? Math.max(0.02, emitter.mesh.thickness)
      : trail.scaleX;
  const facingScaleY =
    alignDirection && emitter.render.facing !== "off"
      ? particleProjectedAlignmentScale(world, alignDirection, projection)
      : 1;
  const renderScaleY =
    (emitter.mode === "mesh" ? 1 : trail.scaleY) * facingScaleY;
  const desiredAnchorX =
    emitter.mode === "mesh"
      ? 0.5 + emitter.mesh.pivot[0]
      : 0.5 + emitter.billboard.pivot[0];
  // Y-sign parity (I13-B D4): Three applies the pivot in Y-up local quad space
  // (canonical). Pixi's sprite anchor is screen-space (Y-down), so the billboard
  // Y offset is NEGATED to make the two previews move the pivot the same way.
  // Mesh keeps its pre-existing +Y convention (out of scope — do NOT touch).
  const desiredAnchorY =
    emitter.mode === "mesh"
      ? 0.5 + emitter.mesh.pivot[1]
      : 0.5 - emitter.billboard.pivot[1];
  const anchorX = clamp(desiredAnchorX, 0, 1);
  const anchorY = clamp(desiredAnchorY, 0, 1);
  particle.anchorX = anchorX;
  particle.anchorY = anchorY;
  particle.scaleX = (pixelSizeX * renderScaleX) / Math.max(1, texture.width);
  particle.scaleY = (pixelSizeY * renderScaleY) / Math.max(1, texture.height);
  const baseRotation =
    (data[offset + 9] ?? 0) +
    ageSeconds * (data[offset + 10] ?? 0) +
    particleRotationBySpeedOffset(emitter, speed, ageSeconds, seed, loopAge);
  const trailRotation = trail.stretchesAlongMotion
    ? projectParticleDirectionAngle(world, motionDirection, projection) -
      Math.PI * 0.5
    : 0;
  const alignRotation = !trail.stretchesAlongMotion
    ? particleAlignmentRotation(world, alignDirection, projection)
    : 0;
  particle.rotation =
    baseRotation + (trail.stretchesAlongMotion ? trailRotation : alignRotation);
  const pivotOverflowX = (anchorX - desiredAnchorX) * pixelSizeX * renderScaleX;
  const pivotOverflowY = (anchorY - desiredAnchorY) * pixelSizeY * renderScaleY;
  if (pivotOverflowX !== 0 || pivotOverflowY !== 0) {
    const c = Math.cos(particle.rotation);
    const s = Math.sin(particle.rotation);
    particle.x = projected.x + pivotOverflowX * c - pivotOverflowY * s;
    particle.y = projected.y + pivotOverflowX * s + pivotOverflowY * c;
  } else {
    particle.x = projected.x;
    particle.y = projected.y;
  }

  const depth = projection.depth?.(world) ?? world[2];
  // Initialize Particle color * intensity, then Color over Lifetime multiplies.
  const initColor = sampleInitialParticleColor(
    emitter.initializeParticle.color,
    seed,
    normalizedAge,
    loopAge,
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
  const overLife = sampleRuntimeParticleColor(
    emitter,
    normalizedAge,
    speed,
    seed,
    loopAge,
  );
  // B7/BF8: HDR color intensity is exposure stops converted by the
  // UI into the stored linear multiplier before runtime. Keep the resulting HDR
  // RGB unclamped for bloom, then map it to the SDR preview. With preview bloom
  // enabled, an ACES-fitted preview transform lets overbright warm colors move
  // through orange/yellow/white; with it disabled, keep
  // the older hue-preserving fallback so low-cost runtime usage is stable.
  // Tier-1 material fixed-function fold (techspec §3.1 writer-precedence:
  // module color × material tint·BaseColor). `materialFixed` is non-null ONLY
  // for Tier-1 materials; with sprite-master defaults (tint
  // [1,1,1,1], emissive 0, opacity 1) every factor is exactly 1.0, so the
  // texture-only / no-material path stays byte-identical.
  const mTintR = materialFixed ? materialFixed.tint[0] : 1;
  const mTintG = materialFixed ? materialFixed.tint[1] : 1;
  const mTintB = materialFixed ? materialFixed.tint[2] : 1;
  const mTintA = materialFixed ? materialFixed.tint[3] : 1;
  // Emissive is unlit brightness: scale RGB so bright cores cross the bloom
  // threshold (Unreal-parity, no per-material bloom toggle, §0.1-Q8).
  const mEmissive = materialFixed ? 1 + Math.max(0, materialFixed.emissive) : 1;
  const mOpacity = materialFixed ? materialFixed.opacity : 1;
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
  const litR = Math.max(0, emitterR * mTintR * mEmissive);
  const litG = Math.max(0, emitterG * mTintG * mEmissive);
  const litB = Math.max(0, emitterB * mTintB * mEmissive);
  const hdrColor: Vec3 = [litR, litG, litB];
  const peak = Math.max(litR, litG, litB);
  const overbright = peak > 1 ? peak : 1;
  const baseAlpha = clamp(emitterA * mTintA * mOpacity, 0, 1);
  const sdrRgb = bloom.enabled
    ? toneMapPreviewHdrColor(hdrColor, bloom.exposure)
    : huePreservingHdrToSdrColor(hdrColor);
  const composed: Vec4 = [sdrRgb[0], sdrRgb[1], sdrRgb[2], baseAlpha];
  const color = applyDepthInk(composed, depth, emitter.render.depthInk);
  // B5 cause 1: grain is an intentional per-particle brightness variation. Key
  // it on the stable per-particle seed only (NOT normalizedAge, which changes
  // every frame and produced a visible per-frame sparkle).
  const grain = 0.94 + hash2(seed, 0) * 0.12;
  const tint = rgbToTint(color[0] * grain, color[1] * grain, color[2] * grain);
  particle.tint = tint as ColorSource;
  // B7: on additive blend the HDR stops read as a brighter LDR contribution.
  // Using the raw multiplier here clamps common alpha values by +2/+3 stops,
  // making higher intensity values visually meaningless. Gate on
  // the EFFECTIVE blend (I12-G): a masked/opaque material overrides the
  // emitter's additive blend, so the additive-only boost must not apply.
  const overbrightAlpha =
    effectiveBlend === "additive" ? sdrAdditiveAlphaBoost(overbright) : 1;
  particle.alpha = clamp(color[3] * overbrightAlpha, 0, 1);
  const visible = particle.alpha > 0.01 && pixelSize > 0.01;
  return {
    visible,
    x: projected.x,
    y: projected.y,
    depth,
    pixelSize,
    pixelsPerWorldUnit,
    rotation: particle.rotation,
    scaleX: particle.scaleX,
    scaleY: particle.scaleY,
    anchorX: particle.anchorX,
    anchorY: particle.anchorY,
    tint,
    alpha: particle.alpha,
    baseAlpha,
    hdrColor,
    emissiveStrength: peak,
    texture,
    key: `${start.toFixed(6)}:${seed.toFixed(6)}`,
    start,
    normalizedAge,
    loopAge,
    speed,
    seed,
  };
}

function sampleEmitterDynamicParamsRepresentative(
  emitter: ParticleEmitterDefinition,
): Vec4 {
  if (!emitter.modules.customData) return [0, 0, 0, 0];
  const channels = emitter.advanced.customData.channels;
  return [
    sampleParticleScalarValue(channels[0], 0, 0.5, 0),
    sampleParticleScalarValue(channels[1], 0, 0.5, 0),
    sampleParticleScalarValue(channels[2], 0, 0.5, 0),
    sampleParticleScalarValue(channels[3], 0, 0.5, 0),
  ];
}

function updateTrailHistory(
  view: EmitterView,
  emitter: ParticleEmitterDefinition,
  sample: ParticleRenderSample,
  timeSeconds: number,
): void {
  if (!emitter.modules.trails) return;
  const settings = emitter.advanced.trails;
  // `ratio` is the fraction of particles that emit a trail. Gate on the stable
  // per-particle seed so it is deterministic: ratio 1 = all, 0 = none.
  if (sample.seed >= settings.ratio) return;
  const lengthWorld = Math.max(
    0,
    sampleParticleScalarValue(
      settings.length,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  const widthWorld = Math.max(
    0.01,
    sampleParticleScalarValue(
      settings.width,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  // Authored trail-point lifetime (seconds). Replaces the previously hard-coded
  // fade/prune durations.
  const lifetimeSeconds = Math.max(
    0.001,
    sampleParticleScalarValue(
      settings.lifetime,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  const maxLengthPx =
    lengthWorld > 0
      ? Math.max(1, lengthWorld * sample.pixelsPerWorldUnit)
      : undefined;
  const widthPx = Math.max(0.5, widthWorld * sample.pixelsPerWorldUnit);
  let history = view.trailHistories.get(sample.key);
  if (!history) {
    history = { points: [], lastSeenFrame: timeSeconds };
    view.trailHistories.set(sample.key, history);
  }
  const points = history.points;
  const last = points[points.length - 1];
  const minDistancePx = Math.max(
    0.5,
    emitter.advanced.trails.minVertexDistance * sample.pixelsPerWorldUnit,
  );
  if (
    !last ||
    distance2d(last.x, last.y, sample.x, sample.y) >= minDistancePx
  ) {
    points.push({
      x: sample.x,
      y: sample.y,
      timeSeconds,
      lifetimeSeconds,
      distanceFromHead: 0,
      pixelSize: sample.pixelSize,
      tint: sample.tint,
      alpha: sample.alpha,
      widthPx,
      maxLengthPx,
      seed: sample.seed,
    });
  } else {
    last.x = sample.x;
    last.y = sample.y;
    last.timeSeconds = timeSeconds;
    last.lifetimeSeconds = lifetimeSeconds;
    last.pixelSize = sample.pixelSize;
    last.tint = sample.tint;
    last.alpha = sample.alpha;
    last.widthPx = widthPx;
    last.maxLengthPx = maxLengthPx;
    last.seed = sample.seed;
  }
  history.lastSeenFrame = timeSeconds;
  pruneTrailPoints(points, maxLengthPx, timeSeconds);
}

/**
 * When trails are local-space (`worldSpace === false`) the captured trail
 * points must follow the emitter as it moves. We translate every stored point
 * by the emitter's projected movement delta each frame. World-space (default)
 * trails keep their captured positions.
 */
function applyLocalSpaceTrailShift(
  view: EmitterView,
  emitter: ParticleEmitterDefinition,
  projection: PixiVfxProjection,
  emitterPosition: Vec3,
): void {
  const previous = view.trailEmitterPosition;
  if (
    emitter.modules.trails &&
    !emitter.advanced.trails.worldSpace &&
    view.trailHistories.size > 0
  ) {
    const before = projection.project(previous);
    const after = projection.project(emitterPosition);
    if (
      before &&
      after &&
      before.visible !== false &&
      after.visible !== false
    ) {
      const dx = after.x - before.x;
      const dy = after.y - before.y;
      if (dx !== 0 || dy !== 0) {
        for (const history of view.trailHistories.values()) {
          for (const point of history.points) {
            point.x += dx;
            point.y += dy;
          }
        }
      }
    }
  }
  previous[0] = emitterPosition[0];
  previous[1] = emitterPosition[1];
  previous[2] = emitterPosition[2];
}

function drawTrailView(
  view: EmitterView,
  emitter: ParticleEmitterDefinition,
  timeSeconds: number,
): number {
  if (!emitter.modules.trails) {
    view.trailHistories.clear();
    view.trailContainer.particleChildren.length = 0;
    view.trailContainer.update();
    return 0;
  }
  const settings = emitter.advanced.trails;
  const gradient = settings.color;
  let visibleCount = 0;
  for (const [key, history] of view.trailHistories) {
    pruneTrailPoints(history.points, undefined, timeSeconds);
    if (history.points.length === 0) {
      view.trailHistories.delete(key);
      continue;
    }
    const points = history.points;
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      const maxLengthPx = point.maxLengthPx;
      if (maxLengthPx !== undefined && point.distanceFromHead > maxLengthPx) {
        continue;
      }
      const fallbackLength = Math.max(point.widthPx, point.distanceFromHead, 1);
      const trailT = clamp(
        point.distanceFromHead / (maxLengthPx ?? fallbackLength),
        0,
        1,
      );
      const distanceFade = 1 - trailT;
      // Older trail points fade out over the authored lifetime.
      const ageFade =
        1 -
        clamp((timeSeconds - point.timeSeconds) / point.lifetimeSeconds, 0, 1);
      let tint = point.tint;
      let pointAlpha = point.alpha;
      if (gradient) {
        // Authored trail gradient: sample by normalized trail position.
        const rgb = sampleParticleGradientColor(gradient, trailT);
        tint = rgbToTint(rgb[0], rgb[1], rgb[2]);
        pointAlpha = sampleParticleGradientAlpha(gradient, trailT);
      } else if (!settings.inheritColor) {
        tint = 0xffffff;
      }
      const alpha = pointAlpha * distanceFade * ageFade;
      if (alpha <= 0.01) continue;
      const texture = view.trailTexture;
      const widthOverTrail = Math.max(
        0,
        sampleParticleScalarValue(settings.widthOverTrail, trailT, point.seed),
      );
      const widthPx = point.widthPx * widthOverTrail;
      if (widthPx <= 0.01) continue;
      const particle = view.trailPool[visibleCount] ?? createParticle(texture);
      view.trailPool[visibleCount] = particle;
      particle.texture = texture;
      particle.x = point.x;
      particle.y = point.y;
      const next = points[Math.min(i + 1, points.length - 1)] ?? point;
      const dx = next.x - point.x;
      const dy = next.y - point.y;
      const segmentLength = Math.max(widthPx, Math.hypot(dx, dy));
      particle.rotation =
        segmentLength > widthPx ? Math.atan2(dy, dx) - Math.PI * 0.5 : 0;
      particle.scaleX = widthPx / Math.max(1, texture.width);
      particle.scaleY =
        settings.textureMode === "stretch"
          ? segmentLength / Math.max(1, texture.height)
          : widthPx / Math.max(1, texture.height);
      particle.tint = tint as ColorSource;
      particle.alpha = alpha;
      view.trailContainer.particleChildren[visibleCount] = particle;
      visibleCount++;
    }
  }
  view.trailContainer.particleChildren.length = visibleCount;
  view.trailContainer.update();
  return visibleCount;
}

function pruneTrailPoints(
  points: TrailPoint[],
  maxLengthPx: number | undefined,
  timeSeconds: number,
): void {
  let distanceFromHead = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]!;
    const next = points[i + 1];
    if (next) {
      distanceFromHead += distance2d(point.x, point.y, next.x, next.y);
    }
    point.distanceFromHead = distanceFromHead;
  }
  while (
    points.length > 0 &&
    ((maxLengthPx !== undefined &&
      points[0]!.distanceFromHead > maxLengthPx &&
      points.length > 1) ||
      timeSeconds - points[0]!.timeSeconds > points[0]!.lifetimeSeconds)
  ) {
    points.shift();
  }
}

function sampleRuntimeParticleColor(
  emitter: ParticleEmitterDefinition,
  normalizedAge: number,
  speed: number,
  seed: number,
  loopAge: number,
): Vec4 {
  const baseColor: Vec4 = emitter.modules.color
    ? [
        ...sampleParticleGradientColor(emitter.color.gradient, normalizedAge),
        sampleParticleGradientAlpha(emitter.color.gradient, normalizedAge),
      ]
    : [1, 1, 1, 1];
  return sampleParticleModuleColor(
    emitter,
    normalizedAge,
    speed,
    seed,
    baseColor,
    loopAge,
  );
}

function applyDepthInk(color: Vec4, depth: number, enabled: boolean): Vec4 {
  if (!enabled) return color;
  const depthInk = clamp(depth * 0.035, -0.28, 0.28);
  const brightness = 1 - depthInk;
  return [
    color[0] * brightness,
    color[1] * brightness,
    color[2] * brightness,
    color[3],
  ];
}

interface TextureSheetFrameSet {
  textures: Texture[];
  ownedTextures: Texture[];
}

interface AnimatedUvFrameSet {
  textures: Texture[];
  ownedTextures: Texture[];
  frames: AnimatedUvFrameTexture[];
}

function createEmitterTier2MaterialShader(
  material: ResolvedTier2MaterialRender | null,
  texture: Texture,
): PixiShader | null {
  if (!material) return null;
  return createTier2ParticleMaterialShader({
    graph: material.graph,
    instance: material.instance,
    artifact: material.artifact,
    texture,
    textureSheetTiles: material.textureSheetTiles,
  });
}

function textureSheetTiles(
  emitter: ParticleEmitterDefinition,
): [number, number] {
  if (!emitter.modules.textureSheetAnimation) return [1, 1];
  const settings = emitter.advanced.textureSheetAnimation;
  return [
    Math.max(1, Math.round(settings.tiles[0])),
    Math.max(1, Math.round(settings.tiles[1])),
  ];
}

function materialAnimatedUvFromArtifact(
  artifact: MaterialArtifact,
): MaterialAnimatedUvDescriptor | null {
  if (artifact.tier !== "tier1-fixed") return null;
  const fixed = artifact.fixed;
  const pan = fixed?.uvPan;
  const rotate = fixed?.uvRotate;
  const hasPan =
    pan != null &&
    (Math.abs(pan.speed[0]) > 0.000001 || Math.abs(pan.speed[1]) > 0.000001);
  const hasRotate = rotate != null && Math.abs(rotate.speed) > 0.000001;
  if (!hasPan && !hasRotate) return null;
  return {
    pan: hasPan ? pan : undefined,
    rotate: hasRotate ? rotate : undefined,
  };
}

function materialUvRenderKey(
  materialUv: MaterialAnimatedUvDescriptor | null,
): string {
  if (!materialUv) return "";
  const parts: string[] = [];
  if (materialUv.pan) {
    parts.push(
      `uvPan:${numberKey(materialUv.pan.speed[0])}:${numberKey(
        materialUv.pan.speed[1],
      )}`,
    );
  }
  if (materialUv.rotate) {
    parts.push(
      `uvRotate:${numberKey(materialUv.rotate.speed)}:${numberKey(
        materialUv.rotate.center[0],
      )}:${numberKey(materialUv.rotate.center[1])}`,
    );
  }
  return parts.join(":");
}

function numberKey(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function createTextureSheetFrameTextures(
  texture: Texture,
  emitter: ParticleEmitterDefinition,
): TextureSheetFrameSet {
  if (!emitter.modules.textureSheetAnimation) {
    return { textures: [texture], ownedTextures: [] };
  }
  const settings = emitter.advanced.textureSheetAnimation;
  const tilesX = Math.max(1, Math.round(settings.tiles[0]));
  const tilesY = Math.max(1, Math.round(settings.tiles[1]));
  const totalFrames = tilesX * tilesY;
  if (totalFrames <= 1) return { textures: [texture], ownedTextures: [] };

  const sourceFrame = texture.frame;
  const cellWidth = sourceFrame.width / tilesX;
  const cellHeight = sourceFrame.height / tilesY;
  if (
    !Number.isFinite(cellWidth) ||
    !Number.isFinite(cellHeight) ||
    cellWidth <= 0 ||
    cellHeight <= 0
  ) {
    return { textures: [texture], ownedTextures: [] };
  }

  const textures: Texture[] = [];
  for (let frame = 0; frame < totalFrames; frame++) {
    const column = frame % tilesX;
    const row = Math.floor(frame / tilesX);
    textures.push(
      new Texture({
        source: texture.source,
        frame: new Rectangle(
          sourceFrame.x + column * cellWidth,
          sourceFrame.y + row * cellHeight,
          cellWidth,
          cellHeight,
        ),
        orig: new Rectangle(0, 0, cellWidth, cellHeight),
        defaultAnchor: texture.defaultAnchor,
        rotate: texture.rotate,
      }),
    );
  }
  return { textures, ownedTextures: textures };
}

function createAnimatedUvFrameTextures(
  baseTextures: Texture[],
): AnimatedUvFrameSet {
  const frames: AnimatedUvFrameTexture[] = [];
  const textures: Texture[] = [];
  for (const base of baseTextures) {
    requestRepeatSampling(base);
    const texture = new Texture({
      source: base.source,
      frame: cloneRectangle(base.frame),
      orig: cloneRectangle(base.orig),
      trim: base.trim ? cloneRectangle(base.trim) : undefined,
      defaultAnchor: base.defaultAnchor,
      rotate: base.rotate,
      dynamic: true,
    });
    const frame = {
      texture,
      baseUvs: cloneUvs(base.uvs),
    };
    frames.push(frame);
    textures.push(texture);
  }
  return { textures, ownedTextures: textures, frames };
}

function samplePixiTexturePath(
  path: string,
  uv: [number, number],
  _node: unknown,
  textureProvider: PixiVfxTextureProvider | undefined,
): Vec4 | null {
  const texture = textureProvider?.getTexture(createPixiVfxTextureRef(path));
  const canvas = pixiTextureImageToCanvas(texture);
  if (!canvas) return null;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const x = Math.min(
    canvas.width - 1,
    Math.max(0, Math.round(uv[0] * (canvas.width - 1))),
  );
  const y = Math.min(
    canvas.height - 1,
    Math.max(0, Math.round(uv[1] * (canvas.height - 1))),
  );
  const data = context.getImageData(x, y, 1, 1).data;
  return [
    (data[0] ?? 0) / 255,
    (data[1] ?? 0) / 255,
    (data[2] ?? 0) / 255,
    (data[3] ?? 0) / 255,
  ];
}

function pixiTextureImageToCanvas(
  texture: Texture | undefined,
): HTMLCanvasElement | null {
  if (!texture || typeof document === "undefined") return null;
  const source = texture.source;
  const resource = source?.resource as CanvasImageSource | undefined;
  const frame = texture.frame;
  const sourceX = frame?.x ?? 0;
  const sourceY = frame?.y ?? 0;
  const width = frame?.width ?? source?.pixelWidth ?? 0;
  const height = frame?.height ?? source?.pixelHeight ?? 0;
  if (!resource || width <= 0 || height <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(
      resource,
      sourceX,
      sourceY,
      width,
      height,
      0,
      0,
      width,
      height,
    );
  } catch {
    return null;
  }
  return canvas;
}

function updateAnimatedUvFrameTextures(
  view: EmitterView,
  timeSeconds: number,
): void {
  if (!view.materialUv || view.animatedUvFrames.length === 0) return;
  for (const frame of view.animatedUvFrames) {
    const uv0 = transformMaterialUv(0, 0, view.materialUv, timeSeconds);
    const uv1 = transformMaterialUv(1, 0, view.materialUv, timeSeconds);
    const uv2 = transformMaterialUv(1, 1, view.materialUv, timeSeconds);
    const uv3 = transformMaterialUv(0, 1, view.materialUv, timeSeconds);
    const p0 = mapUnitUvToBase(frame.baseUvs, uv0[0], uv0[1]);
    const p1 = mapUnitUvToBase(frame.baseUvs, uv1[0], uv1[1]);
    const p2 = mapUnitUvToBase(frame.baseUvs, uv2[0], uv2[1]);
    const p3 = mapUnitUvToBase(frame.baseUvs, uv3[0], uv3[1]);
    const target = frame.texture.uvs;
    target.x0 = p0[0];
    target.y0 = p0[1];
    target.x1 = p1[0];
    target.y1 = p1[1];
    target.x2 = p2[0];
    target.y2 = p2[1];
    target.x3 = p3[0];
    target.y3 = p3[1];
  }
}

function transformMaterialUv(
  u: number,
  v: number,
  materialUv: MaterialAnimatedUvDescriptor,
  timeSeconds: number,
): [number, number] {
  let outU = u;
  let outV = v;
  if (materialUv.pan) {
    outU += materialUv.pan.speed[0] * timeSeconds;
    outV += materialUv.pan.speed[1] * timeSeconds;
  }
  if (materialUv.rotate) {
    const angle = materialUv.rotate.speed * timeSeconds * Math.PI * 2;
    const c = materialUv.rotate.center;
    const dx = outU - c[0];
    const dy = outV - c[1];
    const cs = Math.cos(angle);
    const sn = Math.sin(angle);
    outU = c[0] + dx * cs - dy * sn;
    outV = c[1] + dx * sn + dy * cs;
  }
  return [outU, outV];
}

function mapUnitUvToBase(base: UvQuad, u: number, v: number): [number, number] {
  const topX = base.x0 + (base.x1 - base.x0) * u;
  const topY = base.y0 + (base.y1 - base.y0) * u;
  const bottomX = base.x3 + (base.x2 - base.x3) * u;
  const bottomY = base.y3 + (base.y2 - base.y3) * u;
  return [topX + (bottomX - topX) * v, topY + (bottomY - topY) * v];
}

function cloneUvs(uvs: Texture["uvs"]): UvQuad {
  return {
    x0: uvs.x0,
    y0: uvs.y0,
    x1: uvs.x1,
    y1: uvs.y1,
    x2: uvs.x2,
    y2: uvs.y2,
    x3: uvs.x3,
    y3: uvs.y3,
  };
}

function cloneRectangle(rect: Rectangle): Rectangle {
  return new Rectangle(rect.x, rect.y, rect.width, rect.height);
}

function requestRepeatSampling(texture: Texture): void {
  texture.source.addressMode = "repeat";
}

function textureSheetRenderKey(emitter: ParticleEmitterDefinition): string {
  if (!emitter.modules.textureSheetAnimation) return "";
  const settings = emitter.advanced.textureSheetAnimation;
  return [
    "sheet",
    Math.max(1, Math.round(settings.tiles[0])),
    Math.max(1, Math.round(settings.tiles[1])),
    settings.startFrame,
    settings.cycles,
    Number(settings.randomStartFrame),
  ].join(":");
}

function selectParticleFrameTexture(
  frameTextures: Texture[],
  emitter: ParticleEmitterDefinition,
  normalizedAge: number,
  seed: number,
  loopAge: number,
): Texture {
  const fallback = frameTextures[0] ?? Texture.EMPTY;
  if (!emitter.modules.textureSheetAnimation || frameTextures.length <= 1) {
    return fallback;
  }
  const frame = sampleTextureSheetAnimationFrame(
    emitter.advanced.textureSheetAnimation,
    normalizedAge,
    seed,
    loopAge,
  );
  return frameTextures[frame.frame % frameTextures.length] ?? fallback;
}

function particleAlignmentRotation(
  world: Vec3,
  direction: Vec3 | null,
  projection: PixiVfxProjection,
): number {
  return direction
    ? projectParticleDirectionAngle(world, direction, projection)
    : 0;
}

function particleAlignmentDirection(
  emitter: ParticleEmitterDefinition,
  flags: number,
  motionDirection: Vec3,
  speed: number,
  spawnDirection: Vec3,
): Vec3 | null {
  let direction: Vec3 | null = null;
  if (emitter.render.alignAxis === "spawnDirection") {
    direction = spawnDirection;
  } else if (emitter.render.alignAxis === "velocity") {
    direction = speed > 0.000001 ? motionDirection : spawnDirection;
  } else if (emitter.render.alignAxis === "vector") {
    direction = emitter.render.alignmentVector;
  } else if (flags & PARTICLE_RUNTIME_FLAG_ALIGN_TO_DIRECTION) {
    // Back-compat for runtime states created from old spawn.alignToDirection.
    direction = spawnDirection;
  }
  return direction;
}

function particleProjectedAlignmentScale(
  world: Vec3,
  direction: Vec3,
  projection: PixiVfxProjection,
): number {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length <= 0.000001) return 1;
  const inverseLength = 1 / length;
  const tip: Vec3 = [
    world[0] + direction[0] * inverseLength,
    world[1] + direction[1] * inverseLength,
    world[2] + direction[2] * inverseLength,
  ];
  const start = projection.project(world);
  const end = projection.project(tip);
  if (!start || !end || start.visible === false || end.visible === false) {
    return 1;
  }
  const projectedLength = Math.hypot(end.x - start.x, end.y - start.y);
  const worldLength = Math.max(0.000001, projection.pixelsPerWorldUnit(world));
  return clamp(projectedLength / worldLength, 0.02, 1);
}

function clearEmitterView(view: EmitterView): void {
  view.container.particleChildren.length = 0;
  view.trailContainer.particleChildren.length = 0;
  view.bloomContainer.particleChildren.length = 0;
  view.trailHistories.clear();
  view.container.update();
  view.trailContainer.update();
  view.bloomContainer.update();
}

function destroyEmitterView(
  root: Container,
  bloomRoot: Container,
  view: EmitterView,
): void {
  root.removeChild(view.container);
  root.removeChild(view.trailContainer);
  bloomRoot.removeChild(view.bloomContainer);
  view.container.destroy();
  view.trailContainer.destroy();
  view.bloomContainer.destroy();
  for (const texture of view.ownedFrameTextures) {
    texture.destroy(false);
  }
  view.ownedFrameTextures.length = 0;
  view.frameTextures.length = 0;
  view.animatedUvFrames.length = 0;
}

function fallbackTextureKeyForEmitter(
  emitter: ParticleEmitterDefinition,
): PixiVfxProceduralTextureKey {
  if (emitter.mode === "mesh") return emitter.mesh.template;
  // Engine contract: an assetless billboard falls back to the procedural
  // billboard shape (F12) — honor `billboard.shape` instead of always square.
  return emitter.billboard.shape === "square" ? "square" : "circle";
}

function createParticle(texture: Texture): Particle {
  return new Particle({
    texture,
    anchorX: 0.5,
    anchorY: 0.5,
  });
}

function copyBloomParticle(
  particle: Particle,
  sample: ParticleRenderSample,
  bloom: BloomDrawSettings,
): void {
  if (particle.texture !== sample.texture) {
    particle.texture = sample.texture;
  }
  particle.x = sample.x;
  particle.y = sample.y;
  particle.rotation = sample.rotation;
  const brightPass = hdrBrightPassColor(
    sample.hdrColor,
    bloom.threshold,
    bloom.softKnee,
  );
  const brightPeak = Math.max(brightPass[0], brightPass[1], brightPass[2]);
  particle.anchorX = sample.anchorX;
  particle.anchorY = sample.anchorY;
  particle.scaleX = sample.scaleX;
  particle.scaleY = sample.scaleY;
  const sourcePeak = Math.max(
    sample.hdrColor[0],
    sample.hdrColor[1],
    sample.hdrColor[2],
  );
  const tintScale = brightPeak > 0 ? (sourcePeak > 1 ? 1 / brightPeak : 1) : 0;
  particle.tint = rgbToTint(
    brightPass[0] * tintScale,
    brightPass[1] * tintScale,
    brightPass[2] * tintScale,
  ) as ColorSource;
  particle.alpha = bloomSourceAlpha(sample.baseAlpha, brightPeak);
}

function huePreservingHdrToSdrColor(hdrColor: Vec3): Vec3 {
  const peak = Math.max(hdrColor[0], hdrColor[1], hdrColor[2]);
  const norm = peak > 1 ? 1 / peak : 1;
  return [hdrColor[0] * norm, hdrColor[1] * norm, hdrColor[2] * norm];
}

function toneMapPreviewHdrColor(hdrColor: Vec3, exposureStops: number): Vec3 {
  const exposure = 2 ** clamp(exposureStops, -2, 2);
  const exposed: Vec3 = [
    hdrColor[0] * exposure,
    hdrColor[1] * exposure,
    hdrColor[2] * exposure,
  ];
  const peak = Math.max(exposed[0], exposed[1], exposed[2]);
  if (peak <= 1) return exposed;
  return acesFittedPreviewToneMap(exposed);
}

function acesFittedPreviewToneMap(color: Vec3): Vec3 {
  const acesInput: Vec3 = [
    color[0] * 0.59719 + color[1] * 0.35458 + color[2] * 0.04823,
    color[0] * 0.076 + color[1] * 0.90834 + color[2] * 0.01566,
    color[0] * 0.0284 + color[1] * 0.13383 + color[2] * 0.83777,
  ];
  const fit: Vec3 = [
    acesRrtAndOdtFit(acesInput[0]),
    acesRrtAndOdtFit(acesInput[1]),
    acesRrtAndOdtFit(acesInput[2]),
  ];
  return warmHdrPreviewShoulder(color, [
    clamp(fit[0] * 1.60475 + fit[1] * -0.53108 + fit[2] * -0.07367, 0, 1),
    clamp(fit[0] * -0.10208 + fit[1] * 1.10813 + fit[2] * -0.00605, 0, 1),
    clamp(fit[0] * -0.00327 + fit[1] * -0.07276 + fit[2] * 1.07602, 0, 1),
  ]);
}

function acesRrtAndOdtFit(value: number): number {
  const v = Math.max(0, value);
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return b > 0 ? a / b : 0;
}

function warmHdrPreviewShoulder(source: Vec3, mapped: Vec3): Vec3 {
  const peak = Math.max(source[0], source[1], source[2]);
  if (peak <= 1 || source[0] < peak) return mapped;
  const nextChannel = Math.max(source[1], source[2]);
  const redDominance = clamp((source[0] - nextChannel) / source[0], 0, 1);
  const stops = Math.log2(Math.max(1, peak));
  const amount = redDominance * clamp((stops - 1) / 8, 0, 1);
  if (amount <= 0) return mapped;
  const warm: Vec3 = [
    1,
    0.92 * (1 - Math.exp(-stops / 10)),
    0.62 * (1 - Math.exp(-stops / 16)),
  ];
  return [
    lerp(mapped[0], warm[0], amount),
    lerp(mapped[1], warm[1], amount),
    lerp(mapped[2], warm[2], amount),
  ];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hdrBrightPassColor(
  hdrColor: Vec3,
  threshold: number,
  softKnee: number,
): Vec3 {
  const peak = Math.max(hdrColor[0], hdrColor[1], hdrColor[2]);
  if (peak <= 0) return [0, 0, 0];
  const brightScale = hdrBrightPassScale(peak, threshold, softKnee);
  return [
    hdrColor[0] * brightScale,
    hdrColor[1] * brightScale,
    hdrColor[2] * brightScale,
  ];
}

function hdrBrightPassScale(
  peak: number,
  threshold: number,
  softKnee: number,
): number {
  if (threshold <= 0) return 1;
  const knee = Math.max(0, threshold * softKnee);
  const hard = Math.max(peak - threshold, 0);
  if (knee <= 0) return clamp(hard / peak, 0, 1);
  const soft = clamp(peak - threshold + knee, 0, knee * 2);
  const softContribution = (soft * soft) / (4 * knee);
  return clamp(Math.max(hard, softContribution) / peak, 0, 1);
}

function emissiveStopsAboveThreshold(
  strength: number,
  threshold: number,
): number {
  const normalized =
    threshold > 0 ? strength / threshold : Math.max(0, strength);
  return Math.max(0, Math.log2(Math.max(1, normalized)));
}

function sdrAdditiveAlphaBoost(overbright: number): number {
  const stops = emissiveStopsAboveThreshold(overbright, 1);
  return 1 + stops * SDR_ADDITIVE_ALPHA_GAIN_PER_STOP;
}

function bloomSourceAlpha(baseAlpha: number, brightPeak: number): number {
  const clampedPeak = clamp(Math.max(0, brightPeak), 0, HDR_BLOOM_INPUT_CLAMP);
  const encodedPeak =
    BLOOM_SOURCE_ALPHA_STOP_RANGE > 0
      ? Math.pow(
          Math.log2(1 + clampedPeak) / BLOOM_SOURCE_ALPHA_STOP_RANGE,
          BLOOM_SOURCE_ALPHA_ENERGY_CURVE,
        )
      : 0;
  return clamp(baseAlpha * encodedPeak, 0, 1);
}

function estimateParticleUploadBytes({
  liveParticles,
  trailParticles,
  bloomParticles = 0,
  dynamicUvs,
}: {
  liveParticles: number;
  trailParticles: number;
  bloomParticles?: number;
  dynamicUvs: boolean;
}): number {
  const particleCount =
    Math.max(0, liveParticles) +
    Math.max(0, trailParticles) +
    Math.max(0, bloomParticles);
  if (particleCount <= 0) return 0;
  const positionBytes = 2 * Float32Array.BYTES_PER_ELEMENT;
  const rotationBytes = Float32Array.BYTES_PER_ELEMENT;
  const vertexBytes = 4 * Float32Array.BYTES_PER_ELEMENT;
  const colorBytes = Uint32Array.BYTES_PER_ELEMENT;
  const uvBytes = dynamicUvs ? 4 * Float32Array.BYTES_PER_ELEMENT : 0;
  return (
    particleCount *
    (positionBytes + rotationBytes + vertexBytes + colorBytes + uvBytes)
  );
}

function sumStateUploadBytes(
  states: readonly ParticleEmitterRuntimeState[],
): number {
  let total = 0;
  for (const state of states) total += state.uploadBytesLastFrame;
  return total;
}

function clearStateUploadBytes(
  states: readonly ParticleEmitterRuntimeState[],
): void {
  for (const state of states) state.uploadBytesLastFrame = 0;
}

function applySubEmitterInheritance(
  effect: unknown,
  request: ParticleSubEmitterSpawnRequest,
): ParticleEffectDefinition {
  const normalized = normalizePixiVfxEffect(effect);
  if (!request.inheritedColor && !request.inheritedSize) return normalized;
  const color = request.inheritedColor;
  const size = Math.max(0.001, request.inheritedSize ?? 1);
  return {
    ...normalized,
    emitters: normalized.emitters.map((emitter) => ({
      ...emitter,
      color: color
        ? {
            ...emitter.color,
            gradient: {
              ...emitter.color.gradient,
              colorStops: emitter.color.gradient.colorStops.map((stop) => ({
                ...stop,
                color: [
                  stop.color[0] * color[0],
                  stop.color[1] * color[1],
                  stop.color[2] * color[2],
                ],
              })),
              alphaStops: emitter.color.gradient.alphaStops.map((stop) => ({
                ...stop,
                alpha: stop.alpha * color[3],
              })),
            },
          }
        : emitter.color,
      initializeParticle:
        request.inheritedSize && !emitter.modules.size
          ? {
              ...emitter.initializeParticle,
              size: scaleParticleScalarValue(
                emitter.initializeParticle.size,
                size,
              ),
              size3D: scaleParticleVec3ScalarValue(
                emitter.initializeParticle.size3D,
                size,
              ),
            }
          : emitter.initializeParticle,
      billboard:
        request.inheritedSize && emitter.modules.size
          ? {
              ...emitter.billboard,
              sizeValue: scaleParticleScalarValue(
                emitter.billboard.sizeValue,
                size,
              ),
              sizeValueY: scaleParticleScalarValue(
                emitter.billboard.sizeValueY,
                size,
              ),
            }
          : emitter.billboard,
      mesh:
        request.inheritedSize && emitter.modules.size
          ? {
              ...emitter.mesh,
              sizeValue: scaleParticleScalarValue(emitter.mesh.sizeValue, size),
            }
          : emitter.mesh,
    })),
  };
}

function scaleParticleVec3ScalarValue(
  value: ParticleEmitterDefinition["initializeParticle"]["size3D"],
  factor: number,
): ParticleEmitterDefinition["initializeParticle"]["size3D"] {
  return {
    x: scaleParticleScalarValue(value.x, factor),
    y: scaleParticleScalarValue(value.y, factor),
    z: scaleParticleScalarValue(value.z, factor),
  };
}

function scaleParticleScalarValue(
  value: ParticleEmitterDefinition["billboard"]["sizeValue"],
  factor: number,
): ParticleEmitterDefinition["billboard"]["sizeValue"] {
  return {
    ...value,
    value: value.value * factor,
    min: value.min * factor,
    max: value.max * factor,
    curve: value.curve.map((point) => ({ ...point, y: point.y * factor })),
    curveB: value.curveB.map((point) => ({ ...point, y: point.y * factor })),
    editorMin: value.editorMin * factor,
    editorMax: value.editorMax * factor,
  };
}

function seedFromSubEmitterRequest(
  request: ParticleSubEmitterSpawnRequest,
): number {
  const sourceSeed = Math.floor(
    Math.abs(request.sourceParticleSeed) * 0xffffffff,
  );
  return (
    sourceSeed ^
    hashStringLocal(request.effectFile) ^
    Math.imul(request.nextDepth + 1, 0x9e3779b1) ^
    Math.imul(request.sourceParticleIndex + 1, 0x85ebca6b)
  );
}

function dedupeTextureRefs(
  refs: readonly VfxTextureAssetRef[],
): VfxTextureAssetRef[] {
  const byPath = new Map<string, VfxTextureAssetRef>();
  for (const ref of refs) {
    if (!byPath.has(ref.path)) byPath.set(ref.path, ref);
  }
  return [...byPath.values()];
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sumBloomSourceParticles(
  instances: ReadonlySet<PixiVfxEffectInstance>,
): number {
  let total = 0;
  for (const instance of instances) {
    total += instance.stats.bloomSourceParticles;
  }
  return total;
}

function createEmptyEffectStats(): PixiVfxEffectStats {
  return {
    activeParticles: 0,
    visibleParticles: 0,
    capacity: 0,
    emittedLastFrame: 0,
    uploadBytesLastFrame: 0,
    spawnedSubEmittersLastFrame: 0,
    renderGroupsLastFrame: 0,
    bloomActive: false,
    bloomSourceParticles: 0,
    bloomPasses: 0,
    bloomRenderScale: 0,
    missingSubEmitterRefs: [],
    missingTextureRefs: [],
    missingMaterialRefs: [],
    unsupportedModules: [],
    unsupportedFeatures: [],
  };
}

function normalizeSeed(seed: number | undefined): number {
  return typeof seed === "number" && Number.isFinite(seed)
    ? seed >>> 0
    : DEFAULT_SEED;
}

function copyVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function rgbToTint(r: number, g: number, b: number): number {
  const channel = (value: number): number =>
    Math.round(clamp(value, 0, 1) * 255);
  return (channel(r) << 16) | (channel(g) << 8) | channel(b);
}

function hash2(a: number, b: number): number {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function hashStringLocal(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function distance2d(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
