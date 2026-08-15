import type { Vec2, Vec3, Vec4 } from "./math";
import type {
  ParticleColorGradientSettings,
  ParticleCurvePoint,
  ParticleScalarValue,
} from "./particles";

interface ParticleValueRange {
  min: number;
  max: number;
}

export type NormalizeScalarValue = (
  value: unknown,
  fallback: number,
  editorMin: number,
  editorMax: number,
  fallbackCurve?: ParticleCurvePoint[],
) => ParticleScalarValue;

export function normalizeScalarWithFallbackMode(
  value: unknown,
  fallback: ParticleScalarValue,
  normalizeScalar: NormalizeScalarValue,
): ParticleScalarValue {
  const source = isRecord(value) ? value : fallback;
  const normalized = normalizeScalar(
    source,
    fallback.value,
    fallback.editorMin,
    fallback.editorMax,
    fallback.curve,
  );
  if (isRecord(value)) return normalized;
  return {
    ...normalized,
    mode: fallback.mode,
    value: fallback.value,
    min: fallback.min,
    max: fallback.max,
  };
}

export function createConstantScalar(
  value: number,
  editorMin: number,
  editorMax: number,
): ParticleScalarValue {
  return {
    mode: "constant",
    value,
    min: value,
    max: value,
    curve: [
      { x: 0, y: value },
      { x: 1, y: value },
    ],
    curveB: [
      { x: 0, y: value },
      { x: 1, y: value },
    ],
    editorMin,
    editorMax,
  };
}

export function createCurveScalar(
  start: number,
  end: number,
  editorMin: number,
  editorMax: number,
): ParticleScalarValue {
  return {
    mode: "curve",
    value: start,
    min: Math.min(start, end),
    max: Math.max(start, end),
    curve: [
      { x: 0, y: start },
      { x: 1, y: end },
    ],
    curveB: [
      { x: 0, y: start },
      { x: 1, y: end },
    ],
    editorMin,
    editorMax,
  };
}

export function createGradient(
  start: Vec4,
  end: Vec4,
): ParticleColorGradientSettings {
  return {
    mode: "blend",
    colorStops: [
      { position: 0, color: [start[0], start[1], start[2]] },
      { position: 1, color: [end[0], end[1], end[2]] },
    ],
    alphaStops: [
      { position: 0, alpha: start[3] },
      { position: 1, alpha: end[3] },
    ],
  };
}

export function normalizeRange(
  value: unknown,
  fallback: ParticleValueRange,
  min: number,
  max: number,
): ParticleValueRange {
  const source = isRecord(value) ? value : {};
  const a = clampNumber(numberOr(source.min, fallback.min), min, max);
  const b = clampNumber(numberOr(source.max, fallback.max), min, max);
  return {
    min: Math.min(a, b),
    max: Math.max(a, b),
  };
}

export function normalizeVec2(
  value: unknown,
  fallback: Vec2,
  min: number,
  max: number,
  integer = false,
): Vec2 {
  if (!Array.isArray(value)) return [...fallback];
  const a = clampNumber(numberOr(value[0], fallback[0]), min, max);
  const b = clampNumber(numberOr(value[1], fallback[1]), min, max);
  return integer ? [Math.round(a), Math.round(b)] : [a, b];
}

export function normalizeVec3(
  value: unknown,
  fallback: Vec3,
  min: number,
  max: number,
): Vec3 {
  if (!Array.isArray(value)) return [...fallback];
  return [
    clampNumber(numberOr(value[0], fallback[0]), min, max),
    clampNumber(numberOr(value[1], fallback[1]), min, max),
    clampNumber(numberOr(value[2], fallback[2]), min, max),
  ];
}

export function normalizeVec4(
  value: unknown,
  fallback: Vec4,
  min: number,
  max: number,
): Vec4 {
  if (!Array.isArray(value)) return [...fallback];
  return [
    clampNumber(numberOr(value[0], fallback[0]), min, max),
    clampNumber(numberOr(value[1], fallback[1]), min, max),
    clampNumber(numberOr(value[2], fallback[2]), min, max),
    clampNumber(numberOr(value[3], fallback[3]), min, max),
  ];
}

export function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
