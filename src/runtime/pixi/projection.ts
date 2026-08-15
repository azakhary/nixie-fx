import type { Vec3 } from "../../engine/math";
import type { PixiVfx2dProjectionOptions, PixiVfxProjection } from "./types";

export function createPixiVfx2dProjection(
  options: PixiVfx2dProjectionOptions = {},
): PixiVfxProjection {
  const originX = finiteOr(options.originX, 0);
  const originY = finiteOr(options.originY, 0);
  const pixelsPerUnit = Math.max(0.000001, finiteOr(options.pixelsPerUnit, 1));
  const ySign = options.yAxis === "down" ? 1 : -1;
  return {
    project(world: Vec3) {
      return {
        x: originX + world[0] * pixelsPerUnit,
        y: originY + world[1] * pixelsPerUnit * ySign,
        visible: true,
      };
    },
    pixelsPerWorldUnit() {
      return pixelsPerUnit;
    },
    depth(world: Vec3) {
      return world[2];
    },
  };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
