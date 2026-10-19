import { describe, expect, it, vi } from "vitest";
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  Texture,
  Vector2,
} from "three";
import { normalizeParticleEffect } from "../../engine/particles";
import type { MaterialFixedDescriptor } from "../materials/artifact";
import { surfaceProgram } from "./surfaceBatchMaterial";
import { ThreeSurfaceBatcher } from "./surfaceBatcher";
import {
  applyThreeTextureFrame,
  createThreeTextureFrameSet,
} from "./textureFrames";

function emitter(sheet: boolean) {
  return normalizeParticleEffect({
    id: "frame-batching",
    targetProfile: "three-world-3d",
    emitters: [
      {
        id: "sprite",
        modules: { textureSheetAnimation: sheet },
        advanced: { textureSheetAnimation: { tiles: [2, 2] } },
      },
    ],
  }).emitters[0]!;
}

const animatedUv: MaterialFixedDescriptor = {
  tint: [1, 1, 1, 1],
  emissive: 0,
  opacity: 1,
  blend: "normal",
  uvPan: { speed: [0.3, -0.2] },
  uvRotate: { speed: 0.1, center: [0.5, 0.5] },
};

const sprite = () => new Mesh(new PlaneGeometry(), new MeshBasicMaterial());

describe("surface batches with runtime texture frames", () => {
  it.each([true, false])(
    "reuses the sampler and batch across pooled playback (sheet=%s)",
    (sheet) => {
      const source = new Texture();
      source.offset.set(0.1, 0.2);
      source.repeat.set(0.8, 0.6);
      const sourceVersion = source.source.version;
      const definition = emitter(sheet);
      // More pooled instances than the inactive-run budget, each with owned views.
      const frames = Array.from({ length: 40 }, () =>
        createThreeTextureFrameSet(source, null, definition, animatedUv),
      );
      const parent = new Group();
      const meshes = [sprite(), sprite()];
      parent.add(...meshes);
      const batcher = new ThreeSurfaceBatcher({ parent, maxTextures: 1 });
      let retained: Mesh | undefined;
      for (let step = 0; step < 80; step++) {
        batcher.beginFrame();
        meshes.forEach((mesh, index) => {
          applyThreeTextureFrame(
            mesh.material,
            frames[(step + index) % frames.length]!,
            (step + index) % 4,
            animatedUv,
            step / 60,
          );
          const program = surfaceProgram(mesh)!;
          expect(program.textures).toEqual([source]);
          expect(surfaceProgram(mesh)).toBe(program);
        });
        const batches = batcher.prepare(meshes);
        expect(batches).toHaveLength(1);
        const batch = batches[0]!.mesh;
        if (retained) {
          expect(batch).toBe(retained);
          expect(batcher.stats.createdRuns).toBe(0);
        } else {
          retained = batch;
          expect(batcher.stats.createdRuns).toBe(1);
        }
        const outputUv = batch.geometry.getAttribute("uv");
        meshes.forEach((mesh, index) => {
          const map = mesh.material.map!;
          expect(map).not.toBe(source);
          const inputUv = mesh.geometry.getAttribute("uv");
          for (let vertex = 0; vertex < inputUv.count; vertex++) {
            const expected = new Vector2(
              inputUv.getX(vertex),
              inputUv.getY(vertex),
            ).applyMatrix3(map.matrix);
            expect(outputUv.getX(index * 4 + vertex)).toBeCloseTo(
              expected.x,
              6,
            );
            expect(outputUv.getY(index * 4 + vertex)).toBeCloseTo(
              expected.y,
              6,
            );
          }
        });
      }
      expect(source.offset.toArray()).toEqual([0.1, 0.2]);
      expect(source.repeat.toArray()).toEqual([0.8, 0.6]);
      expect(source.source.version).toBe(sourceVersion);
      const disposeSource = vi.fn();
      source.addEventListener("dispose", disposeSource);
      batcher.dispose();
      for (const set of frames)
        for (const texture of set.ownedTextures) texture.dispose();
      expect(disposeSource).not.toHaveBeenCalled();
    },
  );

  it("keeps caller-owned texture views distinct even when they share an image", () => {
    const source = new Texture();
    const alternate = source.clone();
    alternate.magFilter = NearestFilter;
    const definition = emitter(true);
    const meshes = [sprite(), sprite()];
    [source, alternate].forEach((texture, index) => {
      const frames = createThreeTextureFrameSet(
        texture,
        null,
        definition,
        null,
      );
      applyThreeTextureFrame(meshes[index]!.material, frames, 1, null, 0);
    });
    expect(surfaceProgram(meshes[0]!)!.textures).toEqual([source]);
    expect(surfaceProgram(meshes[1]!)!.textures).toEqual([alternate]);
    expect(surfaceProgram(meshes[0]!)!.key).not.toBe(
      surfaceProgram(meshes[1]!)!.key,
    );
    const parent = new Group();
    parent.add(...meshes);
    const batcher = new ThreeSurfaceBatcher({ parent, maxTextures: 1 });
    batcher.beginFrame();
    expect(batcher.prepare(meshes)).toHaveLength(2);
    batcher.dispose();
  });
});
