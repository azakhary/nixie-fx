import type { Vec3 } from "../engine/math";

/** Canonical quad coordinates: +X right, +Y texture top, +Z front.
 * Direction alignment pins +Y. Positive roll is right-handed about +Z
 * (counterclockwise viewed from the front); serialized angles are radians.
 * Facing-off Three plates retain their legacy normal alignment.
 */
export const PARTICLE_ALIGNMENT_AXIS: Vec3 = [0, 1, 0];
export const PARTICLE_FRONT_AXIS: Vec3 = [0, 0, 1];

export function particleRoll(
  start: number,
  angularVelocity: number,
  age: number,
  speedOffset: number,
): number {
  return start + angularVelocity * age + speedOffset;
}

/** Convert a projected +Y direction to a Y-down sprite rotation. */
export function projectedParticleAlignmentRotation(
  directionAngle: number,
): number {
  return directionAngle + Math.PI * 0.5;
}

/** Pixi's Y-down coordinates reverse canonical roll. */
export function particleRollToScreen(roll: number): number {
  return -roll;
}
