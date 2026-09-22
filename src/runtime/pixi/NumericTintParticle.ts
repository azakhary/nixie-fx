import { Particle, Texture, type ColorSource } from "pixi.js";

/**
 * Particle's numeric RGB path without Color.shared's temporary arrays. Gameplay
 * samplers already produce packed RGB; preserve Pixi's ABGR packing and alpha
 * truncation exactly. String/array colors still use Pixi's parser when requested.
 */
export class NumericTintParticle extends Particle {
  private numericTint = 0xffffff;
  private numericAlpha = 1;

  constructor(texture: Texture) {
    super(texture);
    this.tint = Particle.defaultOptions.tint ?? 0xffffff;
    this.alpha = Particle.defaultOptions.alpha ?? 1;
  }

  override get tint(): number {
    return this.numericTint;
  }

  override set tint(value: ColorSource) {
    if (typeof value === "number") {
      this.numericTint = value;
    } else {
      super.tint = value;
      this.numericTint = super.tint;
    }
    this.updateNumericColor();
  }

  override get alpha(): number {
    return this.numericAlpha;
  }

  override set alpha(value: number) {
    this.numericAlpha = Math.min(Math.max(value, 0), 1);
    this.updateNumericColor();
  }

  private updateNumericColor(): void {
    const rgb = this.numericTint;
    const bgr = ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 0xff);
    this.color = bgr + (((this.numericAlpha * 255) | 0) << 24);
  }
}
