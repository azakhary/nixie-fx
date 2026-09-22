import type { ParticleCurvePoint } from "./particles";

export const PARTICLE_SCALAR_VALUE_LIMIT = 100000;
export const PARTICLE_SCALAR_CURVE_POINT_LIMIT = 8;
const PARTICLE_CURVE_DEFAULT_WEIGHT = 1 / 3;
const PARTICLE_CURVE_SLOPE_LIMIT = 1000;
const PARTICLE_CURVE_WEIGHT_LIMIT = 1;

/**
 * One curve segment with its cubic Bezier control points already derived.
 * `linearX` records that both handles keep the default 1/3 weight, which makes
 * the x-parameterization linear so sampling skips the Newton/bisection solve.
 * `c1`/`c2`/`c3` are the y-polynomial coefficients in the segment's local
 * parameter (y(u) = y0 + c1*u + c2*u^2 + c3*u^3), used by the closed-form
 * integral.
 */
export interface PreparedParticleCurveSegment {
  readonly start: number;
  readonly end: number;
  readonly dx: number;
  readonly x1: number;
  readonly x2: number;
  readonly y0: number;
  readonly y1: number;
  readonly y2: number;
  readonly y3: number;
  readonly linearX: boolean;
  readonly c1: number;
  readonly c2: number;
  readonly c3: number;
}

export interface PreparedParticleCurve {
  readonly firstY: number;
  readonly lastY: number;
  readonly segments: readonly PreparedParticleCurveSegment[];
}

const preparedCurves = new WeakMap<
  readonly ParticleCurvePoint[],
  PreparedParticleCurve
>();

/**
 * Derives (and memoizes) the per-segment Bezier control points of a curve.
 *
 * Only deeply frozen point arrays are cached: a runtime definition freezes its
 * curves once (see `shareParticleEffectDefinition`) so playback hits the cache,
 * while mutable editor arrays are re-derived on every call and therefore keep
 * showing edits immediately.
 */
export function prepareParticleCurve(
  points: readonly ParticleCurvePoint[],
): PreparedParticleCurve {
  const cached = preparedCurves.get(points);
  if (cached) return cached;
  const sorted = isSampleReadyParticleCurve(points)
    ? points
    : normalizeCurvePoints(points, [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]);
  const tangents = curveTangents(sorted);
  const segments: PreparedParticleCurveSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const dx = Math.max(0.000001, b.x - a.x);
    const weightOut = curvePointWeightOut(a);
    const weightIn = curvePointWeightIn(b);
    const y1 = a.y + curvePointSlopeOut(a, tangents[i]!) * dx * weightOut;
    const y2 = b.y - curvePointSlopeIn(b, tangents[i + 1]!) * dx * weightIn;
    segments.push({
      start: a.x,
      end: b.x,
      dx,
      x1: a.x + dx * weightOut,
      x2: b.x - dx * weightIn,
      y0: a.y,
      y1,
      y2,
      y3: b.y,
      linearX:
        weightOut === PARTICLE_CURVE_DEFAULT_WEIGHT &&
        weightIn === PARTICLE_CURVE_DEFAULT_WEIGHT,
      c1: 3 * (y1 - a.y),
      c2: 3 * (a.y - 2 * y1 + y2),
      c3: -a.y + 3 * y1 - 3 * y2 + b.y,
    });
  }
  const prepared: PreparedParticleCurve = {
    firstY: sorted[0]!.y,
    lastY: sorted[sorted.length - 1]!.y,
    segments,
  };
  if (
    Object.isFrozen(points) &&
    points.every((point) => Object.isFrozen(point))
  ) {
    preparedCurves.set(points, prepared);
  }
  return prepared;
}

export function samplePreparedParticleCurveSegment(
  segment: PreparedParticleCurveSegment,
  x: number,
): number {
  const linearU = clampNumber((x - segment.start) / segment.dx, 0, 1);
  const u = segment.linearX
    ? linearU
    : solveBezierParameterForX(
        segment.start,
        segment.x1,
        segment.x2,
        segment.end,
        x,
        linearU,
      );
  return cubicBezier(segment.y0, segment.y1, segment.y2, segment.y3, u);
}

export function samplePreparedParticleCurve(
  curve: PreparedParticleCurve,
  x: number,
): number {
  if (x <= 0) return curve.firstY;
  if (x >= 1) return curve.lastY;
  for (const segment of curve.segments) {
    if (x <= segment.end) return samplePreparedParticleCurveSegment(segment, x);
  }
  return curve.lastY;
}

/**
 * Setup-time snapshot of one curve. Owns its derived control points, so later
 * edits to the source points are not observed (callers build a new sampler).
 */
export class ParticleCurveSampler {
  private readonly curve: PreparedParticleCurve;

  constructor(points: readonly ParticleCurvePoint[]) {
    // A memoized (frozen) curve is already immutable; an editor-owned one is
    // freshly derived here. Either way the sampler owns a stable snapshot.
    this.curve = prepareParticleCurve(points);
  }

  sample(t: number): number {
    return samplePreparedParticleCurve(this.curve, clampNumber(t, 0, 1));
  }
}

/**
 * Samples an authored curve. Control points are derived once per points array
 * (see `prepareParticleCurve`) instead of per sample.
 */
export function sampleParticleCurve(
  points: readonly ParticleCurvePoint[],
  t: number,
): number {
  return samplePreparedParticleCurve(
    prepareParticleCurve(points),
    clampNumber(t, 0, 1),
  );
}

function curvePointSlopeIn(
  point: ParticleCurvePoint,
  autoSlope: number,
): number {
  return point.slopeIn ?? point.slope ?? autoSlope;
}

function curvePointSlopeOut(
  point: ParticleCurvePoint,
  autoSlope: number,
): number {
  return point.slopeOut ?? point.slope ?? autoSlope;
}

function curvePointWeightIn(point: ParticleCurvePoint): number {
  return point.weightIn ?? PARTICLE_CURVE_DEFAULT_WEIGHT;
}

function curvePointWeightOut(point: ParticleCurvePoint): number {
  return point.weightOut ?? PARTICLE_CURVE_DEFAULT_WEIGHT;
}

function solveBezierParameterForX(
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  targetX: number,
  initial: number,
): number {
  let u = clampNumber(initial, 0, 1);
  for (let i = 0; i < 6; i++) {
    const x = cubicBezier(x0, x1, x2, x3, u) - targetX;
    const dx = cubicBezierDerivative(x0, x1, x2, x3, u);
    if (Math.abs(x) < 0.000001) return u;
    if (Math.abs(dx) < 0.000001) break;
    const next = u - x / dx;
    if (next < 0 || next > 1) break;
    u = next;
  }

  let bestStart = 0;
  let bestEnd = 1;
  let bestDistance = Infinity;
  let previousU = 0;
  let previousX = cubicBezier(x0, x1, x2, x3, previousU) - targetX;
  for (let i = 1; i <= 24; i++) {
    const nextU = i / 24;
    const nextX = cubicBezier(x0, x1, x2, x3, nextU) - targetX;
    const nextDistance = Math.abs(nextX);
    if (nextDistance < bestDistance) {
      bestDistance = nextDistance;
      bestStart = previousU;
      bestEnd = nextU;
    }
    if (
      previousX === 0 ||
      nextX === 0 ||
      (previousX < 0 && nextX > 0) ||
      (previousX > 0 && nextX < 0)
    ) {
      bestStart = previousU;
      bestEnd = nextU;
      break;
    }
    previousU = nextU;
    previousX = nextX;
  }

  let low = bestStart;
  let high = bestEnd;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) * 0.5;
    const midX = cubicBezier(x0, x1, x2, x3, mid) - targetX;
    const lowX = cubicBezier(x0, x1, x2, x3, low) - targetX;
    if (Math.abs(midX) < 0.000001) return mid;
    if ((lowX <= 0 && midX >= 0) || (lowX >= 0 && midX <= 0)) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return (low + high) * 0.5;
}

function cubicBezier(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  u: number,
): number {
  const v = 1 - u;
  return (
    v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3
  );
}

function cubicBezierDerivative(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  u: number,
): number {
  const v = 1 - u;
  return 3 * v * v * (p1 - p0) + 6 * v * u * (p2 - p1) + 3 * u * u * (p3 - p2);
}

export function scaleCurvePointY(
  point: ParticleCurvePoint,
  scale: number,
  valueLimit = PARTICLE_SCALAR_VALUE_LIMIT,
): ParticleCurvePoint {
  return {
    ...point,
    y: clampFiniteNumber(point.y * scale, -valueLimit, valueLimit),
    ...(typeof point.slope === "number"
      ? {
          slope: clampFiniteNumber(
            point.slope * scale,
            -PARTICLE_CURVE_SLOPE_LIMIT,
            PARTICLE_CURVE_SLOPE_LIMIT,
          ),
        }
      : {}),
    ...(typeof point.slopeIn === "number"
      ? {
          slopeIn: clampFiniteNumber(
            point.slopeIn * scale,
            -PARTICLE_CURVE_SLOPE_LIMIT,
            PARTICLE_CURVE_SLOPE_LIMIT,
          ),
        }
      : {}),
    ...(typeof point.slopeOut === "number"
      ? {
          slopeOut: clampFiniteNumber(
            point.slopeOut * scale,
            -PARTICLE_CURVE_SLOPE_LIMIT,
            PARTICLE_CURVE_SLOPE_LIMIT,
          ),
        }
      : {}),
  };
}

function normalizeCurvePoint(
  value: unknown,
  valueLimit = PARTICLE_SCALAR_VALUE_LIMIT,
): ParticleCurvePoint | undefined {
  if (!isRecord(value)) return undefined;
  const point: ParticleCurvePoint = {
    x: clampNumber(numberOr(value.x, 0), 0, 1),
    y: clampFiniteNumber(numberOr(value.y, 0), -valueLimit, valueLimit),
  };
  const slope = normalizeCurveSlope(value.slope);
  const slopeIn = normalizeCurveSlope(value.slopeIn);
  const slopeOut = normalizeCurveSlope(value.slopeOut);
  const weightIn = normalizeCurveWeight(value.weightIn);
  const weightOut = normalizeCurveWeight(value.weightOut);
  if (slope !== undefined) point.slope = slope;
  if (slopeIn !== undefined) point.slopeIn = slopeIn;
  if (slopeOut !== undefined) point.slopeOut = slopeOut;
  if (weightIn !== undefined) point.weightIn = weightIn;
  if (weightOut !== undefined) point.weightOut = weightOut;
  return point;
}

function normalizeCurveSlope(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? clampFiniteNumber(
        value,
        -PARTICLE_CURVE_SLOPE_LIMIT,
        PARTICLE_CURVE_SLOPE_LIMIT,
      )
    : undefined;
}

function normalizeCurveWeight(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? clampFiniteNumber(value, 0, PARTICLE_CURVE_WEIGHT_LIMIT)
    : undefined;
}

export function normalizeCurvePoints(
  value: unknown,
  fallback: readonly ParticleCurvePoint[],
  valueLimit = PARTICLE_SCALAR_VALUE_LIMIT,
): ParticleCurvePoint[] {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const points = source
    .map((point) => normalizeCurvePoint(point, valueLimit))
    .filter((point): point is ParticleCurvePoint => Boolean(point))
    .sort((a, b) => a.x - b.x)
    .slice(0, PARTICLE_SCALAR_CURVE_POINT_LIMIT);
  if (points.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
  }
  if (points.length === 1) {
    const only = points[0]!;
    return [
      { ...only, x: 0 },
      { ...only, x: 1 },
    ];
  }
  points[0]!.x = 0;
  points[points.length - 1]!.x = 1;
  return points;
}

function isSampleReadyParticleCurve(
  points: readonly ParticleCurvePoint[],
): boolean {
  if (points.length < 2) return false;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first.x !== 0 || last.x !== 1) return false;
  let previousX = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (!isFiniteOptionalCurveSlope(point.slope)) return false;
    if (!isFiniteOptionalCurveSlope(point.slopeIn)) return false;
    if (!isFiniteOptionalCurveSlope(point.slopeOut)) return false;
    if (!isFiniteOptionalCurveWeight(point.weightIn)) return false;
    if (!isFiniteOptionalCurveWeight(point.weightOut)) return false;
    if (point.x < previousX || point.x < 0 || point.x > 1) return false;
    previousX = point.x;
  }
  return true;
}

function isFiniteOptionalCurveSlope(value: number | undefined): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function isFiniteOptionalCurveWeight(value: number | undefined): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= PARTICLE_CURVE_WEIGHT_LIMIT)
  );
}

const curveTangentCache = new WeakMap<
  readonly ParticleCurvePoint[],
  readonly number[]
>();

/**
 * Memoized monotone tangents for a curve. Keyed on the points array identity;
 * the runtime normalizes curves once so the array reference is stable and this
 * hits the cache, while the editor recreates arrays on edit so it recomputes.
 */
function curveTangents(
  points: readonly ParticleCurvePoint[],
): readonly number[] {
  let cached = curveTangentCache.get(points);
  if (!cached) {
    cached = curveAutoTangents(points);
    curveTangentCache.set(points, cached);
  }
  return cached;
}

/**
 * Shape-preserving (monotone) cubic Hermite tangents using the Fritsch-Carlson
 * method. This is what keeps the drawn graph 1:1 with the sampled runtime curve
 * (B6): a "rise to a value and hold" curve no longer overshoots past the
 * endpoint and dips back down. Tangents flatten to zero at local extrema and are
 * limited so a monotone segment never overshoots its endpoints — matching
 * common auto/clamped-auto tangent behavior. Explicit
 * per-point `slope` values (authored tangent handles, F9) are honored as-is.
 */
export function curveAutoTangents(
  points: readonly ParticleCurvePoint[],
): number[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) {
    const only = points[0]!;
    return [
      typeof only.slope === "number" && Number.isFinite(only.slope)
        ? only.slope
        : 0,
    ];
  }
  const explicit = points.map(
    (point) => typeof point.slope === "number" && Number.isFinite(point.slope),
  );
  const secant = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    secant[i] = (b.y - a.y) / Math.max(0.000001, b.x - a.x);
  }
  const tangents = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (explicit[i]) {
      tangents[i] = points[i]!.slope!;
      continue;
    }
    if (i === 0) {
      tangents[i] = secant[0]!;
    } else if (i === n - 1) {
      tangents[i] = secant[n - 2]!;
    } else {
      const left = secant[i - 1]!;
      const right = secant[i]!;
      // Local extreme or a flat neighbour -> zero tangent (no overshoot).
      tangents[i] = left * right <= 0 ? 0 : (left + right) * 0.5;
    }
  }
  // Fritsch-Carlson limiter: keep each monotone segment from overshooting.
  // Only auto tangents are scaled; authored tangents are left intact.
  for (let i = 0; i < n - 1; i++) {
    const d = secant[i]!;
    if (d === 0) {
      if (!explicit[i]) tangents[i] = 0;
      if (!explicit[i + 1]) tangents[i + 1] = 0;
      continue;
    }
    const alpha = tangents[i]! / d;
    const beta = tangents[i + 1]! / d;
    const sumSq = alpha * alpha + beta * beta;
    if (sumSq > 9) {
      const tau = 3 / Math.sqrt(sumSq);
      if (!explicit[i]) tangents[i] = tau * alpha * d;
      if (!explicit[i + 1]) tangents[i + 1] = tau * beta * d;
    }
  }
  return tangents;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampFiniteNumber(value: number, min: number, max: number): number {
  return clampNumber(Number.isFinite(value) ? value : min, min, max);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
