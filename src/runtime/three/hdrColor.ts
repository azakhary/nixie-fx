import type { Vec3 } from "../../engine/math";

const HDR_BLOOM_INPUT_CLAMP = 65472;
const BLOOM_SOURCE_ALPHA_STOP_RANGE = Math.log2(1 + HDR_BLOOM_INPUT_CLAMP);
const BLOOM_SOURCE_ALPHA_ENERGY_CURVE = 1.6;
const BLOOM_SOURCE_GAIN = 0.65;

export function toneMapPreviewHdrColor(
  hdrColor: Vec3,
  exposureStops: number,
): Vec3 {
  return toneMapPreviewHdrColorInto(hdrColor, exposureStops, [0, 0, 0]);
}

export function toneMapPreviewHdrColorInto(
  hdrColor: Vec3,
  exposureStops: number,
  out: Vec3,
): Vec3 {
  const exposure = 2 ** clamp(exposureStops, -2, 2);
  const r = hdrColor[0] * exposure;
  const g = hdrColor[1] * exposure;
  const b = hdrColor[2] * exposure;
  const peak = Math.max(r, g, b);
  if (peak <= 1) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
  }

  const inputR = r * 0.59719 + g * 0.35458 + b * 0.04823;
  const inputG = r * 0.076 + g * 0.90834 + b * 0.01566;
  const inputB = r * 0.0284 + g * 0.13383 + b * 0.83777;
  const fitR = acesRrtAndOdtFit(inputR);
  const fitG = acesRrtAndOdtFit(inputG);
  const fitB = acesRrtAndOdtFit(inputB);
  let mappedR = clamp(fitR * 1.60475 + fitG * -0.53108 + fitB * -0.07367, 0, 1);
  let mappedG = clamp(fitR * -0.10208 + fitG * 1.10813 + fitB * -0.00605, 0, 1);
  let mappedB = clamp(fitR * -0.00327 + fitG * -0.07276 + fitB * 1.07602, 0, 1);
  if (r >= peak) {
    const nextChannel = Math.max(g, b);
    const redDominance = clamp((r - nextChannel) / r, 0, 1);
    const stops = Math.log2(Math.max(1, peak));
    const amount = redDominance * clamp((stops - 1) / 8, 0, 1);
    if (amount > 0) {
      mappedR = lerp(mappedR, 1, amount);
      mappedG = lerp(mappedG, 0.92 * (1 - Math.exp(-stops / 10)), amount);
      mappedB = lerp(mappedB, 0.62 * (1 - Math.exp(-stops / 16)), amount);
    }
  }
  out[0] = mappedR;
  out[1] = mappedG;
  out[2] = mappedB;
  return out;
}

export function exposePreviewHdrColor(
  hdrColor: Vec3,
  exposureStops: number,
): Vec3 {
  const exposure = 2 ** clamp(exposureStops, -2, 2);
  return [
    hdrColor[0] * exposure,
    hdrColor[1] * exposure,
    hdrColor[2] * exposure,
  ];
}

export function encodePreviewBloomHdrColor(
  hdrColor: Vec3,
  threshold: number,
  exposureStops: number,
  softKnee = 0.5,
): Vec3 {
  const base = toneMapPreviewHdrColor(hdrColor, exposureStops);
  const brightPass = hdrBrightPassColor(hdrColor, threshold, softKnee);
  const brightPeak = Math.max(brightPass[0], brightPass[1], brightPass[2]);
  if (brightPeak <= 0) return base;
  const sourcePeak = Math.max(hdrColor[0], hdrColor[1], hdrColor[2]);
  const tintScale = sourcePeak > 1 ? 1 / brightPeak : 1;
  const encodedPeak = bloomSourceEnergy(brightPeak);
  const bloomLevel = 1 + encodedPeak * BLOOM_SOURCE_GAIN;
  return [
    Math.max(base[0], brightPass[0] * tintScale * bloomLevel),
    Math.max(base[1], brightPass[1] * tintScale * bloomLevel),
    Math.max(base[2], brightPass[2] * tintScale * bloomLevel),
  ];
}

function acesRrtAndOdtFit(value: number): number {
  const v = Math.max(0, value);
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return b > 0 ? a / b : 0;
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

function bloomSourceEnergy(brightPeak: number): number {
  const clampedPeak = clamp(Math.max(0, brightPeak), 0, HDR_BLOOM_INPUT_CLAMP);
  return BLOOM_SOURCE_ALPHA_STOP_RANGE > 0
    ? Math.pow(
        Math.log2(1 + clampedPeak) / BLOOM_SOURCE_ALPHA_STOP_RANGE,
        BLOOM_SOURCE_ALPHA_ENERGY_CURVE,
      )
    : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
