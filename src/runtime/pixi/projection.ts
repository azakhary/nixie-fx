import type { Vec3 } from "../../engine/math";
import type {
  PixiVfx2dProjectionOptions,
  PixiVfxProjection,
  PixiVfxProjectionPoint,
} from "./types";

export function createPixiVfx2dProjection(
  options: PixiVfx2dProjectionOptions = {},
): PixiVfxProjection {
  const originX = finiteOr(options.originX, 0);
  const originY = finiteOr(options.originY, 0);
  const pixelsPerUnit = Math.max(0.000001, finiteOr(options.pixelsPerUnit, 1));
  const ySign = options.yAxis === "down" ? 1 : -1;
  return {
    project(world: Vec3, out?: PixiVfxProjectionPoint) {
      const point = out ?? { x: 0, y: 0, visible: true };
      point.x = originX + world[0] * pixelsPerUnit;
      point.y = originY + world[1] * pixelsPerUnit * ySign;
      point.visible = true;
      return point;
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
