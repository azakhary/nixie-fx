import {
  normalizeParticleEffect,
  type ParticleEffectDefinition,
} from "../../engine/particles";

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
