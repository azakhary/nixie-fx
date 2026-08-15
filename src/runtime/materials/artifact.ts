import type { Vec4 } from "../../engine/math";
import type {
  MaterialBlend,
  MaterialPerParticleFeed,
} from "../schema/materials";

/**
 * Material graph compiler — runtime artifact types (techspec §6.1, §6.2).
 *
 * The compiler (`compileMaterial`) resolves a `(ShaderGraph, MaterialInstance,
 * mainTexUid)` triple into the *cheapest* runtime tier and returns a tagged
 * `MaterialArtifact`. The renderer consumes this artifact: Tier-0 looks up a
 * baked derived texture by `bakeHash`; Tier-1 folds `fixed` into the existing
 * fixed-function color/UV path; Tier-2 mints a distinct `shaderId` program; Tier
 * 3 is data-only (un-renderable in preview, surfaced via `deferredNodeIds`).
 *
 * This module owns ONLY the artifact shape; the analysis/compile logic lives in
 * `compileMaterial.ts` and the per-texel bake in `bake.ts`.
 */

/**
 * The four runtime tiers (techspec §6.1). Ordered cheapest-first so a numeric
 * comparison ("the lowest tier that can represent it") is meaningful.
 *
 * - `tier0-bake`  static-per-texel → derived texture / LUT at author time
 *   (zero runtime cost; ~55-65% of materials).
 * - `tier1-fixed` fixed-function uniforms (tint/emissive/opacity/blend +
 *   per-material constants) + VERTEX-stage animated UV (Panner/Rotator feeding
 *   ONLY a texture-sample UV pin). No new container/draw/program.
 * - `tier2-shader` genuine per-pixel-per-particle math → ONE uber-shader program
 *   per variant (counted against the ≤4-6 variant cap).
 * - `tier3-defer` any reachable deferred node (§4.2) → data-only, greyed in
 *   preview.
 */
export type MaterialTier =
  "tier0-bake" | "tier1-fixed" | "tier2-shader" | "tier3-defer";

/** Numeric rank for "lowest tier wins" comparisons (cheapest = lowest). */
export const MATERIAL_TIER_RANK: Record<MaterialTier, number> = {
  "tier0-bake": 0,
  "tier1-fixed": 1,
  "tier2-shader": 2,
  "tier3-defer": 3,
};

/**
 * A vertex-stage animated-UV transform resolved to Tier 1 (techspec §6.2
 * "animated-UV resolution"). An animated Panner/Rotator that feeds ONLY the UV
 * pin of a texture sample rides the stock particle vertex shader via a
 * `uTime`+speed UBO — it mints NO new fragment program and consumes NO variant
 * slot. The renderer applies these to the existing `aUV` path.
 */
export interface MaterialUvPan {
  /** Per-second UV scroll in (u, v). */
  speed: [number, number];
}

export interface MaterialUvRotate {
  /** Per-second rotation in radians about `center`. */
  speed: number;
  /** Rotation center in UV space (default [0.5, 0.5]). */
  center: [number, number];
}

/**
 * The resolved fixed-function descriptor for a Tier-1 material. Everything here
 * folds into uniforms the `ParticleContainer` already honors (tint → 8-bit
 * `color`, emissive → bloom intensity, opacity → alpha) plus optional
 * vertex-stage animated UV. No per-pixel fragment math.
 */
export interface MaterialFixedDescriptor {
  /** Resolved BaseColor·Tint, premultipliable RGBA (each 0..1). */
  tint: Vec4;
  /** Emissive intensity multiplier (≥0). 0 = no emissive. */
  emissive: number;
  /** Constant opacity multiplier (0..1). */
  opacity: number;
  /**
   * Blend state (mirrors the graph blend). `masked`/`opaque` override the
   * emitter's render blend; `normal`/`add` leave the emitter the final say
   * (resolve via `resolveEffectiveParticleBlend`, I12-G).
   */
  blend: MaterialBlend;
  /** Vertex-stage UV scroll (Panner), if the graph animates UV via time. */
  uvPan?: MaterialUvPan;
  /** Vertex-stage UV rotation (Rotator), if the graph animates UV via time. */
  uvRotate?: MaterialUvRotate;
}

/**
 * The compiled material artifact handed to the renderer (techspec §6.1).
 *
 * Field availability by tier:
 *  - `tier0-bake`  → `bakeHash` set (deterministic digest of graph + overrides +
 *    mainTexUid); `shaderId` === 'sprite-master'; canonical fixed controls are
 *    folded into the baked texture.
 *  - `tier1-fixed` → `fixed` set; `shaderId` === 'sprite-master'.
 *  - `tier2-shader`→ `shaderId` is a distinct deterministic id (variant cap);
 *    `fixed` may carry the constant uniforms too.
 *  - `tier3-defer` → `deferredNodeIds` non-empty; not renderable.
 */
export interface MaterialArtifact {
  tier: MaterialTier;
  /**
   * The render-key program axis. Tier 0/1 collapse to the shared
   * `'sprite-master'` id (unlimited free variants); Tier 2 mints a distinct,
   * deterministic id counted against the ≤4-6 variant cap; Tier 3 keeps
   * `'sprite-master'` (it renders nothing custom).
   */
  shaderId: string;
  /**
   * The authoritative graph blend for the batch. Backends combine it with the
   * emitter blend through `resolveEffectiveParticleBlend` (I12-G).
   */
  blend: MaterialBlend;
  /**
   * Tier-0 only: deterministic digest of `(graph, instance overrides,
   * mainTexUid)`. The renderer keys its derived-texture cache on this so a bake
   * is reused across frames/emitters and never collides with legacy
   * alpha-derivation (techspec §6.5).
   */
  bakeHash?: string;
  /** Tier-1 (and Tier-2 constants): resolved fixed-function descriptor. */
  fixed?: MaterialFixedDescriptor;
  /**
   * For each per-particle param, how it is physically delivered (techspec §5.0
   * ladder, §5.1). Keyed by param name.
   */
  perParticleFeeds: Record<string, MaterialPerParticleFeed>;
  /** Author-time diagnostics (over-budget, deferred-node, etc.). */
  diagnostics: string[];
  /** Node ids that forced Tier 3 (deferred / un-renderable). */
  deferredNodeIds: string[];
  /**
   * Derived runtime gates for emitter Start Color / Color-over-Life / alpha.
   * These are analysis results, not serialized material schema.
   */
  usesParticleColorRGB: boolean;
  usesParticleColorAlpha: boolean;
  /**
   * True when the graph's opacity output is provably constant 1 (unwired or a
   * literal constant-1). Gates the Three `sample.alpha`-keyed opaque-pass
   * switch: when false the graph owns per-pixel opacity, so the material must
   * stay translucent regardless of the particle's own alpha (I12-A).
   */
  opacityIsConstantOne: boolean;
}
