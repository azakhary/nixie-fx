import type { Container, ParticleContainer, Rectangle, Texture } from "pixi.js";
import type { Vec3 } from "../../engine/math";
import type { Vec4 } from "../../engine/math";
import type {
  ParticleEffectDefinition,
  ParticleEffectEvent,
  ParticleSubEmitterSpawnRequest,
} from "../../engine/particles";
import type { VfxTextureAssetRef, VfxTextureProvider } from "../assets/types";
import type { ShaderGraph } from "../schema/materials";
import type {
  PixiVfxUnsupportedFeature,
  PixiVfxUnsupportedModule,
} from "./support";

export type {
  PixiVfxUnsupportedFeature,
  PixiVfxUnsupportedModule,
} from "./support";

export type PixiVfxTextureProvider = VfxTextureProvider<Texture>;

/**
 * Resolves a material's `shaderId` to its authored `ShaderGraph` so the
 * renderer can compile it to a tier artifact (techspec §6.5). The built-in
 * "sprite-master" graph is handled by the renderer directly; this provider
 * supplies project `.material` graphs. Synchronous — the editor preloads the
 * graphs into a registry and returns them by id.
 */
export type PixiVfxMaterialGraphProvider = (
  shaderId: string,
) => ShaderGraph | undefined;

export interface PixiVfxProjectionPoint {
  x: number;
  y: number;
  visible?: boolean;
}

export interface PixiVfxProjection {
  project(world: Vec3): PixiVfxProjectionPoint | undefined;
  pixelsPerWorldUnit(world: Vec3): number;
  depth?(world: Vec3): number;
}

export interface PixiVfx2dProjectionOptions {
  originX?: number;
  originY?: number;
  pixelsPerUnit?: number;
  yAxis?: "up" | "down";
}

export type PixiVfxProceduralTextureKey =
  "circle" | "square" | "triangleShard" | "quadShard" | "grassShard";

export type PixiVfxFallbackTextures = Record<
  PixiVfxProceduralTextureKey,
  Texture
>;

export interface PixiVfxProceduralTextureOptions {
  size?: number;
  document?: Pick<Document, "createElement">;
}

export interface PixiVfxEmitterRenderView {
  key: string;
  texture: Texture;
  container: ParticleContainer;
}

export interface PixiVfxEffectStats {
  activeParticles: number;
  visibleParticles: number;
  capacity: number;
  emittedLastFrame: number;
  uploadBytesLastFrame: number;
  spawnedSubEmittersLastFrame: number;
  renderGroupsLastFrame: number;
  bloomActive: boolean;
  bloomSourceParticles: number;
  bloomPasses: number;
  bloomRenderScale: number;
  missingSubEmitterRefs: string[];
  missingTextureRefs: VfxTextureAssetRef[];
  missingMaterialRefs: string[];
  unsupportedModules: PixiVfxUnsupportedModule[];
  unsupportedFeatures: PixiVfxUnsupportedFeature[];
}

export interface PixiVfxRendererStats extends PixiVfxEffectStats {
  effectCount: number;
}

export interface PixiVfxEffectInstanceOptions {
  effect: unknown;
  textureProvider?: PixiVfxTextureProvider;
  effectProvider?: PixiVfxEffectProvider;
  materialGraphProvider?: PixiVfxMaterialGraphProvider;
  fallbackTextures?: PixiVfxFallbackTextures;
  projection?: PixiVfxProjection;
  boundsArea?: Rectangle;
  position?: Vec3;
  seed?: number;
  timeSeconds?: number;
  autoStart?: boolean;
  subEmitterDepth?: number;
  maxSubEmitterDepth?: number;
  maxSubEmitterInstances?: number;
  maxEventsPerFrame?: number;
  maxSubEmitterRequestsPerFrame?: number;
}

export interface PixiVfxSpawnOptions {
  effect?: unknown;
  position?: Vec3;
  seed?: number;
  timeSeconds?: number;
}

export interface PixiVfxUpdateOptions {
  timeSeconds?: number;
  position?: Vec3;
  draw?: boolean;
}

export type PixiVfxBloomQuality = "off" | "low" | "high";

export interface PixiVfxBloomOptions {
  enabled?: boolean;
  quality?: PixiVfxBloomQuality;
  renderScale?: number;
  threshold?: number;
  intensity?: number;
  radius?: number;
  softKnee?: number;
  exposure?: number;
}

export interface PixiVfxRenderTargetRenderer {
  screen: { width: number; height: number };
  render(
    options:
      | Container
      | {
          container: Container;
          target?: Texture;
          clear?: boolean;
          clearColor?: number | string;
        },
  ): void;
}

export interface PixiVfxRendererOptions {
  parent?: Container;
  pixiRenderer?: PixiVfxRenderTargetRenderer;
  bloom?: PixiVfxBloomOptions;
  textureProvider?: PixiVfxTextureProvider;
  effectProvider?: PixiVfxEffectProvider;
  materialGraphProvider?: PixiVfxMaterialGraphProvider;
  fallbackTextures?: PixiVfxFallbackTextures;
  projection?: PixiVfxProjection;
  boundsArea?: Rectangle;
  maxSubEmitterDepth?: number;
  maxSubEmitterInstances?: number;
  maxEventsPerFrame?: number;
  maxSubEmitterRequestsPerFrame?: number;
}

export interface PixiVfxParticleDebugQuad {
  emitterId: string;
  emitterIndex: number;
  particleIndex: number;
  mode: "billboard" | "mesh";
  x: number;
  y: number;
  width: number;
  height: number;
  screenCorners?: { x: number; y: number }[];
  anchorX: number;
  anchorY: number;
  rotation: number;
  depth: number;
  alpha: number;
}

export interface PixiVfxEffectProvider {
  getEffect(effectFile: string): unknown | undefined;
}

export interface PixiVfxRuntimeEventFrame {
  events: ParticleEffectEvent[];
  subEmitterRequests: ParticleSubEmitterSpawnRequest[];
}

export interface PixiVfxInheritedParticlePayload {
  color?: Vec4 | null;
  size?: number | null;
}

export interface PixiVfxCreateEffectOptions extends Omit<
  PixiVfxEffectInstanceOptions,
  "effect"
> {
  addToStage?: boolean;
}

export type PixiVfxEffectDefinition = ParticleEffectDefinition;
