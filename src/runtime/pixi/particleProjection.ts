import type { Vec3 } from "../../engine/math";
import type { PixiVfxProjection, PixiVfxProjectionPoint } from "./types";

// Per-call scratch (module scope: rendering is single-threaded and each call
// consumes these fully before returning, so no allocation per particle).
const directionTipScratch: Vec3 = [0, 0, 0];
const directionStartScratch: PixiVfxProjectionPoint = {
  x: 0,
  y: 0,
  visible: true,
};
const directionEndScratch: PixiVfxProjectionPoint = {
  x: 0,
  y: 0,
  visible: true,
};

export function projectParticleDirectionAngle(
  world: Vec3,
  direction: Vec3,
  projection: PixiVfxProjection,
  fallbackAngle = 0,
): number {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length <= 0.000001) return fallbackAngle;
  const inverseLength = 1 / length;
  const tip = directionTipScratch;
  tip[0] = world[0] + direction[0] * inverseLength;
  tip[1] = world[1] + direction[1] * inverseLength;
  tip[2] = world[2] + direction[2] * inverseLength;
  const start = projection.project(world, directionStartScratch);
  const end = projection.project(tip, directionEndScratch);
  if (!start || !end || start.visible === false) return fallbackAngle;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) <= 0.000001) return fallbackAngle;
  return Math.atan2(dy, dx);
}
