import {
  AdditiveBlending,
  Color,
  Group,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Texture,
  Vector3,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { normalizeParticleEffect } from "../../engine/particles";
import { ThreeInstancedBillboardView } from "./instancedBillboard";
import { ThreeVfxBatcher } from "./billboardBatcher";

function view(parent: Group, texture = new Texture(), x = 0) {
  const emitter = normalizeParticleEffect({
    id: "batch-test",
    emitters: [
      {
        id: "sprite",
        mode: "billboard",
        maxParticles: 8,
        render: { blend: "alpha", depthWrite: false },
      },
    ],
  }).emitters[0]!;
  const v = new ThreeInstancedBillboardView(
    new PlaneGeometry(),
    texture,
    8,
    emitter,
  );
  v.write(
    0,
    new Matrix4().makeTranslation(x, 0, 0),
    new Color(0.2, 0.4, 0.6),
    0.35,
  );
  v.write(
    1,
    new Matrix4().makeTranslation(x + 1, 0, 0),
    new Color(0.8, 0.7, 0.3),
    0.75,
  );
  v.commit(2);
  parent.add(v.mesh);
  return v;
}
function xAt(mesh: Mesh, index: number) {
  const matrix = new Matrix4();
  (mesh as ReturnType<typeof view>["mesh"]).getMatrixAt(index, matrix);
  return new Vector3().setFromMatrixPosition(matrix).x;
}
describe("ThreeVfxBatcher", () => {
  it("combines six emitters with three original textures, preserving every instance and texture order", () => {
    const parent = new Group(),
      batcher = new ThreeVfxBatcher({ parent });
    const textures = [new Texture(), new Texture(), new Texture()];
    const views = Array.from({ length: 6 }, (_, i) =>
      view(parent, textures[i % 3], i * 10),
    );
    const sources = views.map((v) => v.mesh);
    batcher.beginFrame();
    const [batch] = batcher.prepare(sources);
    expect(batcher.stats).toEqual({
      sourceDrawCalls: 6,
      drawCalls: 1,
      savedDrawCalls: 5,
      particles: 12,
    });
    expect(batch!.firstSource).toBe(sources[0]);
    expect(batch!.mesh.count).toBe(12);
    expect(sources.every((s) => !s.visible)).toBe(true);
    for (let i = 0; i < 12; i++) {
      expect(xAt(batch!.mesh, i)).toBe(Math.floor(i / 2) * 10 + (i % 2));
      expect(batch!.mesh.geometry.getAttribute("aNixieTexture").getX(i)).toBe(
        Math.floor(i / 2) % 3,
      );
      expect(
        batch!.mesh.geometry.getAttribute("aInstanceAlpha").getX(i),
      ).toBeCloseTo(i % 2 ? 0.75 : 0.35);
    }
    for (let i = 0; i < 3; i++)
      expect(batch!.mesh.material.uniforms["uNixieTexture" + i]!.value).toBe(
        textures[i],
      );
    batcher.dispose();
    expect(sources.every((s) => s.visible)).toBe(true);
  });
  it("never crosses external objects, incompatible states, authored layers or texture budget", () => {
    const parent = new Group(),
      batcher = new ThreeVfxBatcher({ parent, maxTextures: 2 });
    const a = view(parent),
      b = view(parent),
      c = view(parent),
      d = view(parent);
    batcher.beginFrame();
    expect(
      batcher.prepare([a.mesh, b.mesh, new Mesh(), c.mesh, d.mesh]),
    ).toHaveLength(2);
    batcher.beginFrame();
    expect(batcher.prepare([a.mesh, b.mesh, c.mesh, d.mesh])).toHaveLength(2);
    batcher.beginFrame();
    b.mesh.material.blending = AdditiveBlending;
    expect(batcher.prepare([a.mesh, b.mesh])).toHaveLength(0);
    batcher.beginFrame();
    b.mesh.material.blending = a.mesh.material.blending;
    b.mesh.renderOrder = 1;
    expect(batcher.prepare([a.mesh, b.mesh])).toHaveLength(0);
    batcher.dispose();
  });
  it("bakes source world transforms into the host parent's coordinates", () => {
    const parent = new Group(),
      left = new Group(),
      right = new Group();
    parent.position.x = 5;
    left.position.x = 20;
    right.position.x = -10;
    const a = view(left, undefined, 2),
      b = view(right, undefined, 3),
      batcher = new ThreeVfxBatcher({ parent });
    const [batch] = batcher.prepare([a.mesh, b.mesh]);
    expect(xAt(batch!.mesh, 0)).toBe(17);
    expect(xAt(batch!.mesh, 2)).toBe(-12);
    batcher.dispose();
  });
  it("reuses allocations, restores visibility before updates, handles a hidden effect, and keeps source data intact", () => {
    const parent = new Group(),
      group = new Group();
    parent.add(group);
    const a = view(group),
      b = view(group),
      batcher = new ThreeVfxBatcher({ parent });
    const before = Array.from(a.mesh.instanceMatrix.array);
    const [first] = batcher.prepare([a.mesh, b.mesh]),
      mesh = first!.mesh;
    expect(() => batcher.prepare([a.mesh, b.mesh])).toThrow(/beginFrame/);
    batcher.beginFrame();
    expect(a.mesh.visible).toBe(true);
    expect(mesh.visible).toBe(false);
    expect(batcher.prepare([b.mesh, a.mesh])[0]!.mesh).toBe(mesh);
    expect(xAt(mesh, 0)).toBe(xAt(b.mesh, 0));
    expect(Array.from(a.mesh.instanceMatrix.array)).toEqual(before);
    batcher.beginFrame();
    group.visible = false;
    expect(batcher.prepare([a.mesh, b.mesh])).toHaveLength(0);
    expect(batcher.stats.drawCalls).toBe(0);
    batcher.dispose();
  });
  it("grows retained storage safely and never disposes provider textures or source meshes", () => {
    const parent = new Group(),
      texture = new Texture(),
      disposeTexture = vi.spyOn(texture, "dispose");
    const a = view(parent, texture),
      b = view(parent, texture),
      batcher = new ThreeVfxBatcher({ parent });
    const [first] = batcher.prepare([a.mesh, b.mesh]);
    const oldMesh = first!.mesh;
    batcher.beginFrame();
    a.commit(6);
    b.commit(6);
    const [grown] = batcher.prepare([a.mesh, b.mesh]);
    expect(grown!.mesh).not.toBe(oldMesh);
    expect(grown!.mesh.count).toBe(12);
    batcher.dispose();
    batcher.dispose();
    expect(disposeTexture).not.toHaveBeenCalled();
    expect(a.mesh.parent).toBe(parent);
    expect(a.mesh.visible).toBe(true);
    expect(() => batcher.beginFrame()).toThrow(/destroyed/);
  });
  it("shares live host uniforms and separates different bindings", () => {
    const parent = new Group(),
      a = view(parent),
      b = view(parent),
      batcher = new ThreeVfxBatcher({ parent });
    const shared = { value: 0.5 };
    a.mesh.material.uniforms.hostShade = shared;
    b.mesh.material.uniforms.hostShade = shared;
    const [batch] = batcher.prepare([a.mesh, b.mesh]);
    expect(batch!.mesh.material.uniforms.hostShade).toBe(shared);
    shared.value = 0.8;
    expect(batch!.mesh.material.uniforms.hostShade!.value).toBe(0.8);
    batcher.beginFrame();
    b.mesh.material.uniforms.hostShade = { value: 0.8 };
    expect(batcher.prepare([a.mesh, b.mesh])).toHaveLength(0);
    batcher.dispose();
  });
  it("rejects invalid sampler budgets and duplicate source submissions", () => {
    const parent = new Group();
    expect(() => new ThreeVfxBatcher({ parent, maxTextures: 0 })).toThrow();
    const a = view(parent),
      batcher = new ThreeVfxBatcher({ parent });
    expect(() => batcher.prepare([a.mesh, a.mesh])).toThrow(/Duplicate/);
    batcher.dispose();
  });
});
