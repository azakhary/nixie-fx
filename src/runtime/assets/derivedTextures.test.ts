import { describe, expect, it } from "vitest";
import {
  deriveAlphaInPlace,
  derivedTextureCacheKey,
  opacitySourceNeedsDerivation,
} from "./derivedTextures";

function rgba(...values: number[]): Uint8ClampedArray {
  return Uint8ClampedArray.from(values);
}

describe("derived alpha textures", () => {
  it("knows which opacity sources need derivation", () => {
    expect(opacitySourceNeedsDerivation("textureAlpha")).toBe(false);
    expect(opacitySourceNeedsDerivation("red")).toBe(true);
    expect(opacitySourceNeedsDerivation("luminance")).toBe(true);
    expect(opacitySourceNeedsDerivation("constant")).toBe(true);
  });

  it("derives alpha from individual channels and keeps RGB", () => {
    const red = rgba(10, 20, 30, 255);
    deriveAlphaInPlace(red, "red", false);
    expect(Array.from(red)).toEqual([10, 20, 30, 10]);

    const green = rgba(10, 20, 30, 255);
    deriveAlphaInPlace(green, "green", false);
    expect(Array.from(green)).toEqual([10, 20, 30, 20]);

    const blue = rgba(10, 20, 30, 255);
    deriveAlphaInPlace(blue, "blue", false);
    expect(Array.from(blue)).toEqual([10, 20, 30, 30]);
  });

  it("derives alpha from luminance and its inverse", () => {
    const lum = rgba(100, 100, 100, 255);
    deriveAlphaInPlace(lum, "luminance", false);
    expect(Array.from(lum)).toEqual([100, 100, 100, 100]);

    const inverse = rgba(100, 100, 100, 255);
    deriveAlphaInPlace(inverse, "inverseLuminance", false);
    expect(Array.from(inverse)).toEqual([100, 100, 100, 155]);
  });

  it("supports a constant opacity and inversion", () => {
    const constant = rgba(40, 50, 60, 12);
    deriveAlphaInPlace(constant, "constant", false);
    expect(constant[3]).toBe(255);

    const invertedConstant = rgba(40, 50, 60, 12);
    deriveAlphaInPlace(invertedConstant, "constant", true);
    expect(invertedConstant[3]).toBe(0);

    const invertedRed = rgba(10, 20, 30, 255);
    deriveAlphaInPlace(invertedRed, "red", true);
    expect(invertedRed[3]).toBe(245);
  });

  it("only inverts the existing alpha for textureAlpha", () => {
    const untouched = rgba(10, 20, 30, 200);
    deriveAlphaInPlace(untouched, "textureAlpha", false);
    expect(Array.from(untouched)).toEqual([10, 20, 30, 200]);

    const inverted = rgba(10, 20, 30, 200);
    deriveAlphaInPlace(inverted, "textureAlpha", true);
    expect(inverted[3]).toBe(55);
  });

  it("processes every pixel in a multi-pixel buffer", () => {
    const buffer = rgba(255, 0, 0, 255, 0, 128, 0, 255);
    deriveAlphaInPlace(buffer, "green", false);
    expect(buffer[3]).toBe(0);
    expect(buffer[7]).toBe(128);
  });

  it("builds a stable cache key per source/opacity/invert", () => {
    expect(derivedTextureCacheKey(7, "luminance", false)).toBe("7|luminance|0");
    expect(derivedTextureCacheKey(7, "luminance", true)).toBe("7|luminance|1");
    expect(derivedTextureCacheKey(7, "red", false)).not.toBe(
      derivedTextureCacheKey(8, "red", false),
    );
  });
});
