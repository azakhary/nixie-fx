import {
  createPixiVfx2dProjection,
  type PixiVfxEffectInstance,
  type PixiVfxRenderer,
} from "nixie-fx/pixi";

/**
 * CSS pixels per NixieFX world unit. The projection is fixed instead of being
 * derived from the viewport, so a resize never moves the trail away from the
 * pointer and the particles keep the same on-screen size.
 */
export const PIXELS_PER_UNIT = 24;

/** World origin at the canvas top-left; +Y is up, as in the editor. */
export const TRAIL_PROJECTION = createPixiVfx2dProjection({
  originX: 0,
  originY: 0,
  pixelsPerUnit: PIXELS_PER_UNIT,
  yAxis: "up",
});

/** Maps a Pixi screen point (CSS pixels) to the effect's world space. */
export function screenToWorld(x: number, y: number): [number, number, number] {
  return [x / PIXELS_PER_UNIT, -y / PIXELS_PER_UNIT, 0];
}

/**
 * Drives the `cursor-trail` effect from pointer samples.
 *
 * The effect emits by distance moved, so every position change between two
 * updates becomes particles. That is right while a stroke continues, but a
 * pointer re-entering the canvas or a finger touching down elsewhere would
 * spray the whole jump at once. `begin()` starts a new stroke at the new point
 * instead, and leaves the previous stroke's particles to fade where they are.
 */
export class CursorTrail {
  private readonly vfx: PixiVfxRenderer;
  private readonly effect: unknown;
  private readonly seed: number;
  private current: PixiVfxEffectInstance;
  /** Earlier strokes whose particles are still fading out. */
  private readonly fading = new Set<PixiVfxEffectInstance>();

  constructor(vfx: PixiVfxRenderer, effect: unknown, seed: number) {
    this.vfx = vfx;
    this.effect = effect;
    this.seed = seed;
    this.current = vfx.createEffect(effect, { seed });
  }

  /** Number of live strokes: the current one plus any still fading. */
  get strokeCount(): number {
    return this.fading.size + 1;
  }

  /** Starts a stroke at a screen point without emitting for the jump. */
  begin(x: number, y: number): void {
    const position = screenToWorld(x, y);
    if (this.current.stats.activeParticles > 0) {
      this.fading.add(this.current);
      this.current = this.vfx.createEffect(this.effect, {
        seed: this.seed,
        position,
      });
    } else {
      // Nothing is visible, so restarting is free. spawn() also resets the
      // distance baseline, which is what keeps the jump from emitting.
      this.current.spawn({ position });
    }
  }

  /** Continues the stroke. The next update emits for the distance covered. */
  moveTo(x: number, y: number): void {
    this.current.setPosition(screenToWorld(x, y));
  }

  /** Call after `vfx.update()`: removes strokes that have fully faded. */
  prune(): void {
    for (const stroke of this.fading) {
      if (stroke.stats.activeParticles > 0) continue;
      this.fading.delete(stroke);
      this.vfx.removeEffect(stroke);
    }
  }
}
