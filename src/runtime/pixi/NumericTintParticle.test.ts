import { Color, Particle, Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { NumericTintParticle } from "./NumericTintParticle";

describe("numeric particle color", () => {
  it("matches Pixi packed color, tint and alpha through numeric and parsed color changes", () => {
    const baseline = new Particle(Texture.EMPTY);
    const numeric = new NumericTintParticle(Texture.EMPTY);
    expect(numeric.color).toBe(baseline.color);
    expect(numeric.tint).toBe(baseline.tint);
    expect(numeric.alpha).toBe(baseline.alpha);
    for (const alpha of [-1, 0, 0.1, 0.4999, 0.5, 0.9999, 1, 2]) {
      for (const tint of [
        0x000000,
        0xff0000,
        0x00ff00,
        0x0000ff,
        0xabcdef,
        0xffffff,
        "#123456",
      ]) {
        baseline.alpha = alpha;
        numeric.alpha = alpha;
        baseline.tint = tint;
        numeric.tint = tint;
        expect(numeric.color).toBe(baseline.color);
        expect(numeric.tint).toBe(baseline.tint);
        expect(numeric.alpha).toBe(baseline.alpha);
      }
    }
  });

  it("does not enter the general color parser during repeated numeric sampling", () => {
    const particle = new NumericTintParticle(Texture.EMPTY);
    const setValue = vi.spyOn(Color.shared, "setValue");
    for (let frame = 0; frame < 1000; frame++) {
      particle.tint = (frame * 7123) & 0xffffff;
      particle.alpha = frame / 1000;
    }
    expect(setValue).not.toHaveBeenCalled();
    setValue.mockRestore();
  });
});
