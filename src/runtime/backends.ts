import type {
  ParticleEffectDefinition,
  ParticleEffectRuntimeParameterPatch,
  VfxTargetProfile,
} from "../engine/particles";
import type { Vec3 } from "../engine/math";

export type { VfxTargetProfile } from "../engine/particles";

export type VfxBackendId = "pixi2d" | "three3d";
export type VfxCoordinateSpace = "screen-2d" | "world-3d";
export type VfxSupportStatus = "supported" | "partial" | "blocked";

export interface VfxBackendCapabilities {
  backend: VfxBackendId;
  label: string;
  coordinateSpace: VfxCoordinateSpace;
  supportsTrue3dQuads: boolean;
  supportsMeshParticles: boolean;
  supportsGpuDepth: boolean;
  supportsProjectedDepthSort: boolean;
  supportsParticleContainerTier2: boolean;
  supportsInstancedMaterialStreams: boolean;
  supportsRuntimeSamplerBindings: boolean;
}

export interface VfxSupportDiagnostic {
  code: string;
  path: string;
  message: string;
  emitterId?: string;
  emitterIndex?: number;
}

export interface VfxBackendSupportReport {
  backend: VfxBackendId;
  status: VfxSupportStatus;
  warnings: VfxSupportDiagnostic[];
  blockers: VfxSupportDiagnostic[];
}

export type VfxBackendSupportReports = Record<
  VfxBackendId,
  VfxBackendSupportReport
>;

export interface VfxWorldTransform {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
}

export interface VfxEffectOptions {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  seed?: number;
  timeSeconds?: number;
  autoStart?: boolean;
  runtimeParameters?: ParticleEffectRuntimeParameterPatch;
}

export interface VfxEffectInstance {
  readonly isActive: boolean;
  play(): void;
  pause(): void;
  stop(): void;
  allowCompletion(): void;
  seek(timeSeconds: number): void;
  update(deltaSeconds: number): void;
  setRuntimeParameters(parameters: ParticleEffectRuntimeParameterPatch): void;
  setRenderOrder(renderOrder: number): void;
  setTransform(transform: VfxWorldTransform): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

export interface VfxRendererBackend<TContainer = unknown> {
  readonly backendId: VfxBackendId;
  readonly capabilities: VfxBackendCapabilities;

  mount(container: TContainer): void;
  unmount(): void;
  createEffect(
    effect: ParticleEffectDefinition,
    options?: VfxEffectOptions,
  ): VfxEffectInstance;
  getSupport(effect: ParticleEffectDefinition): VfxBackendSupportReport;
  destroy(): void;
}

export const PIXI_2D_BACKEND_CAPABILITIES: VfxBackendCapabilities = {
  backend: "pixi2d",
  label: "Pixi UI / 2D",
  coordinateSpace: "screen-2d",
  supportsTrue3dQuads: false,
  supportsMeshParticles: false,
  supportsGpuDepth: false,
  supportsProjectedDepthSort: true,
  supportsParticleContainerTier2: true,
  supportsInstancedMaterialStreams: false,
  supportsRuntimeSamplerBindings: false,
};

export const THREE_3D_BACKEND_CAPABILITIES: VfxBackendCapabilities = {
  backend: "three3d",
  label: "Three World / 3D",
  coordinateSpace: "world-3d",
  supportsTrue3dQuads: true,
  supportsMeshParticles: true,
  supportsGpuDepth: true,
  supportsProjectedDepthSort: false,
  supportsParticleContainerTier2: false,
  supportsInstancedMaterialStreams: true,
  supportsRuntimeSamplerBindings: true,
};

export const VFX_BACKEND_CAPABILITIES: Record<
  VfxBackendId,
  VfxBackendCapabilities
> = {
  pixi2d: PIXI_2D_BACKEND_CAPABILITIES,
  three3d: THREE_3D_BACKEND_CAPABILITIES,
};

export function preferredBackendForTargetProfile(
  profile: VfxTargetProfile,
): VfxBackendId | undefined {
  if (profile === "pixi-ui-2d") return "pixi2d";
  if (profile === "three-world-3d") return "three3d";
  return undefined;
}

export function statusFromDiagnostics(
  warnings: readonly VfxSupportDiagnostic[],
  blockers: readonly VfxSupportDiagnostic[],
): VfxSupportStatus {
  if (blockers.length > 0) return "blocked";
  if (warnings.length > 0) return "partial";
  return "supported";
}
