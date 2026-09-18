import { describe, expect, it } from "vitest";
import { projectParticleDirectionAngle } from "./particleProjection";
import { createPixiVfx2dProjection } from "./projection";
import { projectedParticleAlignmentRotation } from "../particleOrientation";

describe("projected texture-top alignment", () => {
  const projection = createPixiVfx2dProjection({ pixelsPerUnit: 100 });
  it.each([
    [0, 1, 0, 0],
    [1, 0, 0, Math.PI / 2],
    [0, -1, 0, Math.PI],
    [-1, 0, 0, -Math.PI / 2],
    [0, 0, 0, 0],
    [0, 0, 1, 0],
  ])(
    "projects direction (%s, %s, %s) to a stable sprite angle",
    (x, y, z, expected) => {
      const angle = projectedParticleAlignmentRotation(
        projectParticleDirectionAngle(
          [0, 0, 0],
          [x, y, z],
          projection,
          -Math.PI / 2,
        ),
      );
      expect(Math.cos(angle)).toBeCloseTo(Math.cos(expected));
      expect(Math.sin(angle)).toBeCloseTo(Math.sin(expected));
    },
  );
});
