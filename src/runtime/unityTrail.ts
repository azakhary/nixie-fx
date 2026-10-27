import type { ParticleTrailSettings } from "../engine/particleModuleSettings";
import { sampleParticleScalarValue } from "../engine/particles";

/**
 * Unity Trails-module history for one particle (`advanced.trails.model ===
 * "unity"`). Committed points are spaced by `minVertexDistance` from the last
 * committed point; the live head is separate and always drawn. The oldest
 * segment is clipped continuously at the point lifetime instead of popping.
 * Coordinates are simulation-world positions supplied by the backend.
 */
export class UnityTrailHistory {
  private points = new Float32Array(16 * 4);
  private start = 0;
  private count = 0;
  /** Live particle position, written every frame the particle is sampled. */
  readonly head = new Float32Array(3);
  /** Point lifetime in seconds (trail lifetime × particle lifetime [× size]). */
  pointLifetime = 0;
  /** Width before `widthOverTrail` (trail width [× particle size]). */
  width = 0;
  /** Particle color carried across the ribbon (backend color space). */
  readonly color = new Float32Array(4);
  /** Particle normalized age driving `colorOverLifetime`; 1 once dead. */
  normalizedAge = 0;
  seed = 0;
  alive = true;
  seenFrame = -1;

  reset(): void {
    this.start = 0;
    this.count = 0;
    this.alive = true;
    this.seenFrame = -1;
  }

  /** Translate committed points and head (local-space trails following the effect). */
  shift(dx: number, dy: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      const o = this.offset(i);
      this.points[o] += dx;
      this.points[o + 1] += dy;
      this.points[o + 2] += dz;
    }
    this.head[0] += dx;
    this.head[1] += dy;
    this.head[2] += dz;
  }

  get pointCount(): number {
    return this.count;
  }

  /** Expire committed points, then commit the head when it moved far enough. */
  commit(time: number, minimumDistance: number): void {
    this.expire(time);
    const x = this.head[0]!;
    const y = this.head[1]!;
    const z = this.head[2]!;
    if (this.count > 0) {
      const o = this.offset(this.count - 1);
      const dx = x - this.points[o]!;
      const dy = y - this.points[o + 1]!;
      const dz = z - this.points[o + 2]!;
      if (dx * dx + dy * dy + dz * dz < minimumDistance * minimumDistance)
        return;
    }
    if (this.count * 4 === this.points.length) this.grow();
    const o = this.offset(this.count++);
    this.points[o] = x;
    this.points[o + 1] = y;
    this.points[o + 2] = z;
    this.points[o + 3] = time;
  }

  /**
   * Drop points older than the lifetime, keeping one to anchor the clipped
   * tail. A dead trail (`dropLast`) also releases its final expired point.
   */
  expire(time: number, dropLast = false): void {
    const cutoff = time - this.pointLifetime;
    while (this.count > 1 && this.points[this.offset(1) + 3]! <= cutoff) {
      this.start = (this.start + 1) % (this.points.length / 4);
      this.count--;
    }
    if (
      dropLast &&
      this.count === 1 &&
      this.points[this.offset(0) + 3]! <= cutoff
    )
      this.count = 0;
  }

  /**
   * Write ribbon centers newest-to-oldest (head first) into `out` as xyz and
   * return how many were written. Returns 0 when nothing is left to draw.
   */
  sampleCenters(time: number, out: Float32Array): number {
    if (this.count === 0) return 0;
    out[0] = this.head[0]!;
    out[1] = this.head[1]!;
    out[2] = this.head[2]!;
    const cutoff = time - this.pointLifetime;
    let written = 1;
    let previousTime = time;
    for (let i = this.count - 1; i >= 0; i--) {
      const o = this.offset(i);
      const pointTime = this.points[o + 3]!;
      const j = written * 3;
      if (i === 0 && pointTime < cutoff && previousTime > pointTime) {
        const blend = Math.min(
          1,
          Math.max(0, (cutoff - pointTime) / (previousTime - pointTime)),
        );
        for (let axis = 0; axis < 3; axis++)
          out[j + axis] =
            this.points[o + axis]! +
            (out[j - 3 + axis]! - this.points[o + axis]!) * blend;
        return written + 1;
      }
      out[j] = this.points[o]!;
      out[j + 1] = this.points[o + 1]!;
      out[j + 2] = this.points[o + 2]!;
      previousTime = pointTime;
      written++;
    }
    return written;
  }

  private offset(index: number): number {
    return ((this.start + index) % (this.points.length / 4)) * 4;
  }

  private grow(): void {
    const next = new Float32Array(this.points.length * 2);
    for (let i = 0; i < this.count; i++)
      next.set(this.points.subarray(this.offset(i), this.offset(i) + 4), i * 4);
    this.points = next;
    this.start = 0;
  }
}

/** Per-emitter Unity trail set keyed by stable particle ID; pools histories. */
export class UnityTrailSet {
  readonly trails = new Map<number, UnityTrailHistory>();
  private readonly pool: UnityTrailHistory[] = [];
  private frame = 0;
  private generation = -1;
  /** Shared center scratch, grown to the longest trail. */
  centers = new Float32Array(64 * 3);

  /** Start a frame; a new state generation invalidates every particle ID. */
  begin(generation: number): void {
    if (generation !== this.generation) {
      this.clear();
      this.generation = generation;
    }
    this.frame++;
  }

  /** Record one live particle sample for this frame. */
  touch(
    settings: ParticleTrailSettings,
    particleId: number,
    x: number,
    y: number,
    z: number,
    time: number,
    particleLifetime: number,
    normalizedAge: number,
    loopAge: number,
    seed: number,
    size: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    let trail = this.trails.get(particleId);
    if (!trail) {
      trail = this.pool.pop() ?? new UnityTrailHistory();
      trail.reset();
      this.trails.set(particleId, trail);
    }
    const lifetime = Math.max(
      0,
      sampleParticleScalarValue(
        settings.lifetime,
        normalizedAge,
        seed,
        loopAge,
      ),
    );
    trail.pointLifetime =
      lifetime *
      Math.max(0, particleLifetime) *
      (settings.sizeAffectsLifetime ? Math.max(0, size) : 1);
    trail.width =
      Math.max(
        0,
        sampleParticleScalarValue(settings.width, normalizedAge, seed, loopAge),
      ) * (settings.sizeAffectsWidth ? Math.max(0, size) : 1);
    trail.head[0] = x;
    trail.head[1] = y;
    trail.head[2] = z;
    trail.color[0] = r;
    trail.color[1] = g;
    trail.color[2] = b;
    trail.color[3] = a;
    trail.normalizedAge = normalizedAge;
    trail.seed = seed;
    trail.alive = true;
    trail.seenFrame = this.frame;
    trail.commit(time, settings.minVertexDistance);
  }

  /**
   * Finish a frame: trails whose particle was not seen died. They are removed
   * with `dieWithParticles`, otherwise they freeze at their last head and
   * expire, sampling color over lifetime at the end of life.
   */
  end(settings: ParticleTrailSettings, time: number): void {
    for (const [id, trail] of this.trails) {
      if (trail.seenFrame !== this.frame) {
        if (settings.dieWithParticles) {
          this.release(id, trail);
          continue;
        }
        trail.alive = false;
        trail.normalizedAge = 1;
        trail.expire(time, true);
      }
      if (trail.pointCount === 0) this.release(id, trail);
    }
  }

  /** Ensure the center scratch fits `points` centers (+ head + clipped tail). */
  ensureCenters(points: number): Float32Array {
    const required = (points + 2) * 3;
    if (this.centers.length < required)
      this.centers = new Float32Array(2 ** Math.ceil(Math.log2(required)));
    return this.centers;
  }

  clear(): void {
    for (const [id, trail] of this.trails) this.release(id, trail);
  }

  private release(id: number, trail: UnityTrailHistory): void {
    this.trails.delete(id);
    this.pool.push(trail);
  }
}
