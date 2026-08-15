import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../engine/math";
import { encodePreviewBloomHdrColor } from "./hdrColor";

describe("encodePreviewBloomHdrColor", () => {
  it("keeps an LDR gray ramp monotonic and near-linear instead of crushing to white", () => {
    const gray = (byte: number): Vec3 => {
      const v = byte / 255;
      return [v, v, v];
    };
    const peakOf = (byte: number) =>
      encodePreviewBloomHdrColor(gray(byte), 1, 0)[0];

    const mid = peakOf(0x83);
    const brighter = peakOf(0xc0);
    const brightest = peakOf(0xff);

    // QA's exact repro boundary: 0x83 must stay near its linear input value,
    // not get renormalized up toward 1.0.
    expect(mid).toBeCloseTo(0.514, 2);
    expect(mid).toBeLessThan(brighter);
    expect(brighter).toBeLessThan(brightest);

    let previous = -Infinity;
    for (let byte = 0; byte <= 0xff; byte++) {
      const peak = peakOf(byte);
      expect(peak).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = peak;
    }
  });

  it("is a byte-identical no-op for genuinely HDR sources (peak > 1)", () => {
    const hdrColor: Vec3 = [8, 8, 8];
    const result = encodePreviewBloomHdrColor(hdrColor, 1, 0);

    // Pre-fix formula, hardcoded: unconditional tintScale = 1/brightPeak
    // renormalizes the bright pass back to this exact value. The gate added
    // by this fix (sourcePeak > 1 ? 1/brightPeak : 1) must not change it,
    // since [8,8,8] is genuinely HDR (peak = 8 > 1).
    const expected = 1.0446452906280683;
    expect(result[0]).toBeCloseTo(expected, 12);
    expect(result[1]).toBeCloseTo(expected, 12);
    expect(result[2]).toBeCloseTo(expected, 12);
  });
});
