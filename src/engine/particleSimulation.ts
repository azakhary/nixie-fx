import type { ParticleEmitterDefinition } from "./particles";
import type { Vec3 } from "./math";

export const CPU_PARTICLE_CAPACITY = 4096;
export const GPU_PARTICLE_CAPACITY = 262144;
/** Six vec4 storage records per slot; fixed schema/profile, no executable export payload. */
export const GPU_PARTICLE_STATE_BYTES = 96;
export interface ParticleSimulationSettings {
  version: 1;
  invalidReason?: string;
  target: "cpu" | "gpu";
  profile: "independent-v1";
  bounds: { min: Vec3; max: Vec3 };
  fallback: { mode: "blocked" } | { mode: "cpu"; maxParticles: number };
  requirements: { nativeWebGPU: true; storageBuffers: 7; workgroupSize: 64 };
  overflow: "replace-oldest";
  seek: "reset-fixed-step";
}
export interface ParticleComputeCapabilities {
  compute: boolean;
  maxParticles: number;
  reason?: string;
}
export interface ParticleSimulationResolution {
  target: "cpu" | "gpu" | "blocked";
  capacity: number;
  messages: string[];
}
export function createGpuSimulation(): ParticleSimulationSettings {
  return {
    version: 1,
    target: "gpu",
    profile: "independent-v1",
    bounds: { min: [-100, -100, -100], max: [100, 100, 100] },
    fallback: { mode: "blocked" },
    requirements: { nativeWebGPU: true, storageBuffers: 7, workgroupSize: 64 },
    overflow: "replace-oldest",
    seek: "reset-fixed-step",
  };
}
export function normalizeParticleSimulation(
  value: unknown,
): ParticleSimulationSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ParticleSimulationSettings>;
  const result = createGpuSimulation();
  if (raw.invalidReason) result.invalidReason = raw.invalidReason;
  if (
    raw.version !== 1 ||
    raw.profile !== "independent-v1" ||
    !["cpu", "gpu"].includes(String(raw.target))
  )
    result.invalidReason = "Unknown simulation version, target or profile.";
  result.target = raw.target === "cpu" ? "cpu" : "gpu";
  const b = raw.bounds;
  if (
    b &&
    [b.min, b.max].every(
      (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite),
    ) &&
    b.min.every((v, i) => v < b.max[i]!)
  )
    result.bounds = { min: [...b.min], max: [...b.max] };
  else
    result.invalidReason =
      "Invalid GPU bounds: finite min/max vectors with min < max are required.";
  if (raw.fallback?.mode === "cpu")
    result.fallback = {
      mode: "cpu",
      maxParticles: Math.max(
        1,
        Math.min(
          CPU_PARTICLE_CAPACITY,
          Math.floor(raw.fallback.maxParticles) || 512,
        ),
      ),
    };
  return result;
}
export function gpuSimulationIssues(e: ParticleEmitterDefinition): string[] {
  if (e.simulation?.target !== "gpu") return [];
  const issues: string[] = e.simulation.invalidReason
    ? [e.simulation.invalidReason]
    : [];
  if (
    !Number.isInteger(e.maxParticles) ||
    e.maxParticles < 1 ||
    e.maxParticles > GPU_PARTICLE_CAPACITY
  )
    issues.push(
      `GPU capacity must be an integer from 1 to ${GPU_PARTICLE_CAPACITY}; requested ${e.maxParticles}.`,
    );
  const supported = new Set(["velocity", "color", "size", "rotation", "noise"]);
  for (const [key, enabled] of Object.entries(e.modules))
    if (enabled && !supported.has(key))
      issues.push(
        `${key} is unsupported by independent-v1 GPU simulation; use a CPU emitter.`,
      );
  if (e.mode !== "billboard")
    issues.push("GPU independent-v1 supports billboard rendering only.");
  if (
    !["point", "circle", "sphere", "hemisphere", "box", "cone"].includes(
      e.spawn.shape,
    )
  )
    issues.push(`GPU spawn shape ${e.spawn.shape} is unsupported.`);
  if (
    e.spawn.rateOverDistance !== 0 ||
    e.spawn.rateOverDistanceValue.value !== 0
  )
    issues.push("GPU distance emission is unsupported.");
  if (e.render.sortMode !== "none")
    issues.push(
      "GPU particle sorting is unsupported; choose Sort: None (additive recommended; alpha remains unsorted).",
    );
  if (e.render.facing !== "cameraPlane" || e.render.alignAxis !== "screen")
    issues.push(
      "GPU billboards require camera-plane facing and no axis alignment.",
    );
  if (
    e.initializeParticle.startRotationSeparateAxes ||
    e.initializeParticle.angularVelocitySeparateAxes
  )
    issues.push(
      "GPU billboard XYZ rotation is unsupported; use scalar rotation.",
    );
  if (e.modules.noise && e.advanced.noise.mode !== "sine")
    issues.push(
      "GPU independent-v1 supports sine noise; curl noise is unsupported.",
    );
  if (e.spawn.alignToDirection)
    issues.push(
      "GPU spawn alignment is unsupported; use camera-plane billboards.",
    );
  if (e.spawn.arcSpread !== 0)
    issues.push("GPU random arc spread quantization is unsupported.");
  if (e.spawn.shape === "cone" && e.spawn.emitFrom !== "base")
    issues.push("GPU cones currently emit from the base only.");
  if (e.spawn.bursts.reduce((sum, b) => sum + b.cycles, 0) > 256)
    issues.push(
      "GPU burst schedules support at most 256 total cycles per loop.",
    );
  if (e.spawn.arcMode !== "random")
    issues.push("GPU shapes require random arc mode.");
  return issues;
}
export function resolveParticleSimulation(
  e: ParticleEmitterDefinition,
  capabilities?: ParticleComputeCapabilities,
): ParticleSimulationResolution {
  if (e.simulation?.target !== "gpu")
    return {
      target: "cpu",
      capacity: Math.min(CPU_PARTICLE_CAPACITY, e.maxParticles),
      messages: [],
    };
  const messages = gpuSimulationIssues(e);
  if (!capabilities?.compute)
    messages.push(
      capabilities?.reason ||
        "Native WebGPU compute is required; WebGL rendering fallback does not provide compute.",
    );
  else if (e.maxParticles > capabilities.maxParticles)
    messages.push(
      `Requested ${e.maxParticles} particles exceeds this device capacity ${capabilities.maxParticles}.`,
    );
  if (!messages.length)
    return { target: "gpu", capacity: e.maxParticles, messages };
  if (e.simulation.fallback.mode === "cpu")
    return {
      target: "cpu",
      capacity: Math.min(e.maxParticles, e.simulation.fallback.maxParticles),
      messages: [
        ...messages,
        `Authored CPU fallback: at most ${Math.min(e.maxParticles, e.simulation.fallback.maxParticles)} particles; CPU noise/integration fidelity differs from GPU.`,
      ],
    };
  return { target: "blocked", capacity: 0, messages };
}

/** Keeps authored indices intact so CPU seed/order semantics do not change. */
export function cpuParticleDefinition(
  effect: import("./particles").ParticleEffectDefinition,
) {
  if (!effect.emitters.some((e) => e.simulation?.target === "gpu"))
    return effect;
  return {
    ...effect,
    emitters: effect.emitters.map((e) => {
      if (e.simulation?.target !== "gpu") return e;
      const r = resolveParticleSimulation(e);
      return {
        ...e,
        simulation: undefined,
        enabled: e.enabled && r.target === "cpu",
        maxParticles: Math.max(1, r.capacity),
      };
    }),
  };
}
