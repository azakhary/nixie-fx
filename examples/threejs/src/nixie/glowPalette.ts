import * as THREE from "three";

const NIXIE_GLOW_REFERENCE_HEX = "#ff4a0e";

/**
 * Registry of every live THREE.Color that carries the tube's warm wolfram
 * signature — plasma sheath uniforms, digit halo, glow sprite, neon spill
 * light, warm ambience, backdrop gradient. One picker drives them all:
 * setColor() re-derives each registered shade RELATIVE to the authored
 * reference in HSL space (same hue offset, saturation and lightness scaled by
 * the same ratios), so the scene keeps its hand-tuned lighting structure in
 * any hue instead of flattening to a single flat tint.
 *
 * Colors are mutated in place (uniforms/materials/lights all hold live Color
 * instances), so applying a color allocates nothing and touches no shaders.
 */
export class NixieGlowPalette {
  private readonly entries: {
    target: THREE.Color;
    authored: THREE.Color;
  }[] = [];
  private readonly referenceHsl = { h: 0, s: 0, l: 0 };
  private readonly pickedHsl = { h: 0, s: 0, l: 0 };
  private readonly authoredHsl = { h: 0, s: 0, l: 0 };
  private readonly pickedScratch = new THREE.Color();
  private currentHex = NIXIE_GLOW_REFERENCE_HEX;

  constructor() {
    new THREE.Color(NIXIE_GLOW_REFERENCE_HEX).getHSL(this.referenceHsl);
  }

  /** Registers live Color instances; their current value is the authored shade. */
  register(...targets: THREE.Color[]): void {
    for (const target of targets) {
      this.entries.push({ target, authored: target.clone() });
    }
    // Late registrations (lazy-built scene parts) catch up with the picker.
    if (this.currentHex !== NIXIE_GLOW_REFERENCE_HEX) {
      this.setColor(this.currentHex);
    }
  }

  setColor(hex: string): void {
    this.currentHex = hex;
    this.pickedScratch.set(hex).getHSL(this.pickedHsl);
    // At the reference the derivation is the identity — copy the authored
    // values verbatim so the default look is bit-exact, not a HSL roundtrip.
    if (hex.toLowerCase() === NIXIE_GLOW_REFERENCE_HEX) {
      for (const { target, authored } of this.entries) target.copy(authored);
      return;
    }
    const reference = this.referenceHsl;
    const picked = this.pickedHsl;
    for (const { target, authored } of this.entries) {
      authored.getHSL(this.authoredHsl);
      const hue = (picked.h + this.authoredHsl.h - reference.h + 1) % 1;
      const saturation = clamp01(
        this.authoredHsl.s * (picked.s / Math.max(reference.s, 0.000001)),
      );
      const lightness = clamp01(
        this.authoredHsl.l * (picked.l / Math.max(reference.l, 0.000001)),
      );
      target.setHSL(hue, saturation, lightness);
    }
  }

  reset(): void {
    this.setColor(NIXIE_GLOW_REFERENCE_HEX);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
