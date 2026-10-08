import { describe, it, expect } from "vitest";
import {
  Group,
  BufferGeometry,
  OneFactor,
  ZeroFactor,
  ReverseSubtractEquation,
  Texture,
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  ShaderMaterial,
  Vector4,
  DoubleSide,
  Float32BufferAttribute,
} from "three";
import { normalizeParticleEffect } from "../../engine/particles";
import { ThreeInstancedBillboardView } from "./instancedBillboard";
import { surfaceProgram } from "./surfaceBatchMaterial";
import { ThreeSurfaceBatcher } from "./surfaceBatcher";
const basic = () =>
  new Mesh(
    new PlaneGeometry(),
    new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    }),
  );
describe("ordered heterogeneous surface batches", () => {
  it("combines different geometry, retains triangle order and both face passes", () => {
    const parent = new Group(),
      a = basic(),
      b = basic();
    b.position.x = 3;
    parent.add(a, b);
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const [batch] = batcher.prepare([a, b]);
    expect(batcher.stats.sourceDrawCalls).toBe(4);
    expect(batcher.stats.drawCalls).toBe(1);
    expect(batch!.mesh.geometry.drawRange.count).toBe(24);
    const face = batch!.mesh.geometry.getAttribute("nfxFace");
    expect(face.getX(0)).toBe(-1);
    expect(face.getX(4)).toBe(1);
    expect(batch!.mesh.geometry.getAttribute("position").getX(8)).toBeCloseTo(
      2.5,
    );
    expect(a.visible).toBe(false);
    const geometry = batch!.mesh.geometry;
    batcher.beginFrame();
    expect(a.visible).toBe(true);
    expect(batcher.prepare([a, b])[0]!.mesh.geometry).toBe(geometry);
    batcher.dispose();
    expect(a.visible).toBe(true);
  });
  it("never crosses unsupported objects or incompatible depth states", () => {
    const parent = new Group(),
      a = basic(),
      b = basic(),
      c = basic();
    c.material.depthTest = false;
    parent.add(a, b, c);
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    expect(batcher.prepare([a, new Group(), b, c])).toHaveLength(3);
    batcher.dispose();
  });
  it("keeps custom shader data per particle without rewriting source materials", () => {
    const parent = new Group();
    const m = new ShaderMaterial({
      vertexShader: "",
      fragmentShader:
        "varying vec2 vUV;varying vec4 vColor;uniform vec4 uDynamicParams;void main(){gl_FragColor=uDynamicParams*vColor;}",
      uniforms: {
        uDynamicParams: { value: new Vector4(1, 2, 3, 4) },
        uParticleColor: { value: new Vector4(0.5, 0.6, 0.7, 0.8) },
      },
      transparent: true,
      depthWrite: false,
    });
    m.userData.nixieSurfaceGraph = true;
    const a = new Mesh(new PlaneGeometry(), m),
      b = new Mesh(new PlaneGeometry(), m.clone());
    b.material.uniforms.uDynamicParams!.value.set(5, 6, 7, 8);
    parent.add(a, b);
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const [batch] = batcher.prepare([a, b]);
    const material = batch!.mesh.material as ShaderMaterial;
    const data = material.uniforms.uNfxData!.value.image.data;
    expect(Array.from(data.slice(0, 4))).toEqual([1, 2, 3, 4]);
    expect(Array.from(data.slice(64, 68))).toEqual([5, 6, 7, 8]);
    expect(material.fragmentShader).toContain("nfx0_main");
    expect(m.fragmentShader).toContain("uDynamicParams");
    expect(batch!.mesh.geometry.getAttribute("nfxProgram").getX(4)).toBe(0);
    batcher.dispose();
  });
  it("uses only the live history draw range and preserves vertex alpha", () => {
    const parent = new Group(),
      a = basic();
    a.material.vertexColors = true;
    a.geometry.setAttribute(
      "color",
      new Float32BufferAttribute(
        [1, 0, 0, 0.25, 1, 0, 0, 0.5, 1, 0, 0, 0.75, 1, 0, 0, 1],
        4,
      ),
    );
    a.geometry.setDrawRange(0, 3);
    parent.add(a);
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const [batch] = batcher.prepare([a]);
    expect(batch!.mesh.geometry.drawRange.count).toBe(6);
    expect(batch!.mesh.geometry.getAttribute("nfxColor").getW(0)).toBe(0.25);
    batcher.dispose();
  });
});

describe("surface batch retention and material contracts", () => {
  it("keeps separated compatible runs distinct and reuses their slots next frame", () => {
    const parent = new Group(),
      a = basic(),
      b = basic();
    b.position.x = 7;
    parent.add(a, b);
    const barrier = new Group();
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const batches = batcher.prepare([a, barrier, b]);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.mesh).not.toBe(batches[1]!.mesh);
    expect(batches[0]!.firstSource).toBe(a);
    expect(batches[1]!.firstSource).toBe(b);
    expect(
      batches[0]!.mesh.geometry.getAttribute("position").getX(0),
    ).toBeCloseTo(-0.5);
    expect(
      batches[1]!.mesh.geometry.getAttribute("position").getX(0),
    ).toBeCloseTo(6.5);
    const meshes = batches.map((batch) => batch.mesh);
    batcher.beginFrame();
    expect(batcher.prepare([a, barrier, b]).map((batch) => batch.mesh)).toEqual(
      meshes,
    );
    batcher.dispose();
  });

  it("reuses shader and bindings when program encounter order changes", () => {
    const parent = new Group(),
      a = basic(),
      b = basic();
    b.material.alphaTest = 0.2;
    parent.add(a, b);
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const mesh = batcher.prepare([a, b])[0]!.mesh;
    const material = mesh.material;
    batcher.beginFrame();
    const reversed = batcher.prepare([b, a])[0]!.mesh;
    expect(reversed).toBe(mesh);
    expect(reversed.material).toBe(material);
    expect(reversed.geometry.getAttribute("nfxProgram").getX(0)).toBe(1);
    expect(reversed.geometry.getAttribute("nfxProgram").getX(8)).toBe(0);
    batcher.dispose();
  });

  it("bounds inactive runs when material variants keep changing", () => {
    const parent = new Group(),
      a = basic();
    parent.add(a);
    const batcher = new ThreeSurfaceBatcher({ parent });
    for (let frame = 0; frame < 50; frame++) {
      a.material.alphaTest = frame / 100;
      batcher.beginFrame();
      batcher.prepare([a]);
    }
    const retained = parent.children.filter(
      (child) => child.name === "NixieFX surface batch",
    );
    expect(retained.length).toBeLessThanOrEqual(33);
    batcher.beginFrame();
    batcher.prepare([]);
    expect(
      parent.children.filter((child) => child.name === "NixieFX surface batch")
        .length,
    ).toBeLessThanOrEqual(32);
    batcher.dispose();
    expect(parent.children).toEqual([a]);
  });

  it("copies separate alpha blending state", () => {
    const parent = new Group(),
      a = basic();
    parent.add(a);
    a.material.blendSrcAlpha = OneFactor;
    a.material.blendDstAlpha = ZeroFactor;
    a.material.blendEquationAlpha = ReverseSubtractEquation;
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const material = batcher.prepare([a])[0]!.mesh.material as ShaderMaterial;
    expect(material.blendSrcAlpha).toBe(OneFactor);
    expect(material.blendDstAlpha).toBe(ZeroFactor);
    expect(material.blendEquationAlpha).toBe(ReverseSubtractEquation);
    batcher.dispose();
  });

  it("invalidates fixed-function programs when map, alpha test, or tone mapping changes", () => {
    const a = basic();
    const initial = surfaceProgram(a)!;
    a.material.map = new Texture();
    const textured = surfaceProgram(a)!;
    expect(textured).not.toBe(initial);
    expect(textured.textures).toEqual([a.material.map]);
    a.material.alphaTest = 0.2;
    expect(surfaceProgram(a)!.fragment).toContain("if(c.a<0.20000000)");
    a.material.toneMapped = false;
    expect(surfaceProgram(a)!.fragment).not.toContain("toneMapping");
    a.material.premultipliedAlpha = true;
    expect(surfaceProgram(a)!.fragment).toContain(
      "gl_FragColor.rgb*=gl_FragColor.a",
    );
    a.material.map.dispose();
    a.geometry.dispose();
    a.material.dispose();
  });

  it("invalidates changed graph source and falls back for missing or unsupported inputs", () => {
    const m = new ShaderMaterial({
      fragmentShader:
        "uniform float level;void main(){gl_FragColor=vec4(level);}",
      uniforms: { level: { value: 0.2 } },
    });
    m.userData.nixieSurfaceGraph = true;
    const a = new Mesh(new PlaneGeometry(), m);
    const initial = surfaceProgram(a);
    expect(initial).not.toBeNull();
    m.fragmentShader =
      "uniform float level;void main(){gl_FragColor=vec4(level*2.0);}";
    expect(surfaceProgram(a)).not.toBe(initial);
    delete m.uniforms.level;
    expect(surfaceProgram(a)).toBeNull();
    m.fragmentShader =
      "varying vec3 unknown;void main(){gl_FragColor=vec4(unknown,1.0);}";
    expect(surfaceProgram(a)).toBeNull();
    m.dispose();
    a.geometry.dispose();
  });

  it("preserves per-vertex custom data on shader trails", () => {
    const m = new ShaderMaterial({
      fragmentShader:
        "varying vec4 uDynamicParams;void main(){gl_FragColor=uDynamicParams;}",
    });
    m.userData.nixieSurfaceGraph = true;
    const a = new Mesh(new PlaneGeometry(), m),
      parent = new Group();
    parent.add(a);
    a.geometry.setAttribute(
      "trailDynamicParams",
      new Float32BufferAttribute(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        4,
      ),
    );
    a.geometry.setAttribute(
      "color",
      new Float32BufferAttribute(
        [1, 0, 0, 0.2, 0, 1, 0, 0.4, 0, 0, 1, 0.6, 1, 1, 1, 0.8],
        4,
      ),
    );
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const mesh = batcher.prepare([a])[0]!.mesh;
    expect(mesh.geometry.getAttribute("nfxColor").getW(1)).toBeCloseTo(0.4);
    expect(mesh.geometry.getAttribute("nfxColor").getY(1)).toBe(1);
    expect((mesh.material as ShaderMaterial).fragmentShader).toContain(
      "gl_FragColor=vNfxDynamic",
    );
    const data = mesh.geometry.getAttribute("nfxDynamic");
    expect([data.getX(0), data.getY(0), data.getZ(0), data.getW(0)]).toEqual([
      1, 2, 3, 4,
    ]);
    expect(data.getW(3)).toBe(16);
    batcher.dispose();
    m.dispose();
    a.geometry.dispose();
  });
});

describe("surface parameter texture budget", () => {
  function stock(count: number) {
    const texture = new Texture();
    const geometry = new PlaneGeometry();
    const emitter = normalizeParticleEffect({
      emitters: [{ render: { depthWrite: false } }],
    }).emitters[0]!;
    const view = new ThreeInstancedBillboardView(
      geometry,
      texture,
      count,
      emitter,
    );
    view.mesh.count = count;
    view.mesh.visible = true;
    return {
      view,
      dispose: () => {
        view.dispose();
        texture.dispose();
        geometry.dispose();
      },
    };
  }
  it("splits before exceeding 2048 draw rows and preserves high precision row lookup", () => {
    const parent = new Group(),
      a = stock(2048),
      b = stock(1);
    parent.add(a.view.mesh, b.view.mesh);
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const batches = batcher.prepare([a.view.mesh, b.view.mesh]);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.mesh).not.toBe(batches[1]!.mesh);
    const material = batches[0]!.mesh.material as ShaderMaterial;
    expect(material.uniforms.uNfxData!.value.image.height).toBe(2048);
    expect(material.vertexShader).toContain("varying highp float vNfxDraw");
    expect(material.fragmentShader).toContain("varying highp float vNfxDraw");
    const indices = batches[0]!.mesh.geometry.getAttribute("nfxDraw");
    expect(indices.getX(2047 * 4)).toBe(2047);
    batcher.dispose();
    a.dispose();
    b.dispose();
  });
  it("leaves an oversized stock instance draw intact between supported runs", () => {
    const parent = new Group(),
      large = stock(2049),
      a = basic(),
      b = basic();
    parent.add(a, large.view.mesh, b);
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const batches = batcher.prepare([a, large.view.mesh, b]);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.mesh).not.toBe(batches[1]!.mesh);
    expect(large.view.mesh.visible).toBe(true);
    expect(batcher.stats.fallbacks).toBe(1);
    batcher.dispose();
    large.dispose();
  });
  it("skips empty, zero-index and zero-instance entries without creating phantom runs", () => {
    const parent = new Group(),
      a = basic(),
      zero = basic(),
      empty = new Mesh(new BufferGeometry(), new MeshBasicMaterial()),
      instances = stock(1);
    zero.geometry.setDrawRange(0, 0);
    instances.view.mesh.count = 0;
    parent.add(a, zero, empty, instances.view.mesh);
    const batcher = new ThreeSurfaceBatcher({ parent });
    batcher.beginFrame();
    const batches = batcher.prepare([zero, empty, instances.view.mesh, a]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.firstSource).toBe(a);
    expect(batcher.stats.sourceDrawCalls).toBe(2);
    batcher.dispose();
    instances.dispose();
    empty.geometry.dispose();
  });
});
