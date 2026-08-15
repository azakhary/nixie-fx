import type { Vec3 } from "../../engine/math";
import type { PixiVfxProjection } from "./types";

export function projectParticleDirectionAngle(
  world: Vec3,
  direction: Vec3,
  projection: PixiVfxProjection,
): number {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length <= 0.000001) return 0;
  const inverseLength = 1 / length;
  const tip: Vec3 = [
    world[0] + direction[0] * inverseLength,
    world[1] + direction[1] * inverseLength,
    world[2] + direction[2] * inverseLength,
  ];
  const start = projection.project(world);
  const end = projection.project(tip);
  if (!start || !end || start.visible === false) return 0;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) <= 0.000001) return 0;
  return Math.atan2(dy, dx);
}
