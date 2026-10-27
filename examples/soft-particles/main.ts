import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { normalizeSceneDefinition } from "nixie-fx";
import { normalizeShaderGraph, type ShaderGraph } from "nixie-fx/materials";
import { loadVfxExportBundle, parseVfxExportManifest } from "nixie-fx/export";
import {
  ThreeVfxRenderer,
  ThreeSoftParticleDepth,
  createThreeSceneLights,
  normalizeThreeVfxEffect,
} from "nixie-fx/three";
import {
  createThreeNodeAdapter,
  createThreeWebGpuRenderer,
  disposeThreeWebGpuRenderer,
  ThreeNodeRenderPipeline,
} from "nixie-fx/three/webgpu";
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const json = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw Error(`${url}: ${r.status}`);
  return r.json();
};
const effectSelect = el<HTMLSelectElement>("effect"),
  backend = el<HTMLSelectElement>("backend"),
  view = el("view");
const check = (id: string) => el<HTMLInputElement>(id).checked;
let dispose = () => {},
  refresh = () => {},
  paused = false,
  generation = 0;
const manifest = parseVfxExportManifest(await json("/out/vfx/manifest.json"));
const effectsByPath = Object.fromEntries(
  await Promise.all(
    manifest.effects.map(async (e) => [
      e.path,
      await json("/out/vfx/" + e.path),
    ]),
  ),
);
const bundle = loadVfxExportBundle(
  { manifest, effectsByPath },
  { requiredBackend: "three3d" },
);
const textures = new Map<string, THREE.Texture>(),
  graphs = new Map<string, ShaderGraph>(),
  meshes = new Map<string, THREE.BufferGeometry>();
await Promise.all(
  manifest.assets.map(async (a) => {
    const url = "/out/vfx/" + a.path;
    if (a.type === "texture") {
      const t = await new THREE.TextureLoader().loadAsync(url);
      t.colorSpace = THREE.SRGBColorSpace;
      textures.set(a.path, t);
    }
    if (a.type === "material") {
      const g = normalizeShaderGraph(await json(url));
      graphs.set(g.id, g);
    }
    if (a.type === "mesh")
      meshes.set(
        a.path,
        new THREE.BufferGeometryLoader().parse(await json(url)),
      );
  }),
);
const sceneDef = normalizeSceneDefinition(
  await json("/assets/scenes/intersections.scene"),
);
const box = new THREE.BufferGeometryLoader().parse(
  await json("/assets/box.json"),
);
for (const effect of manifest.effects)
  effectSelect.add(new Option(effect.name, effect.id));
effectSelect.value = "smoke";
async function start() {
  const serial = ++generation;
  dispose();
  el("error").textContent = "";
  el("status").textContent = "Initializing…";
  try {
    const node =
      backend.value === "webgl"
        ? null
        : await createThreeWebGpuRenderer({
            forceWebGL: backend.value === "fallback",
          });
    if (serial !== generation) {
      if (node) disposeThreeWebGpuRenderer(node.renderer);
      return;
    }
    const renderer =
      node?.renderer ?? new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    view.replaceChildren(renderer.domElement);
    const checkpoints = effectSelect.value === "thresholds";
    const activeSceneDef = checkpoints
      ? normalizeSceneDefinition(await json("/assets/scenes/checkpoints.scene"))
      : sceneDef;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#252b36");
    const lights = createThreeSceneLights(sceneDef);
    scene.add(lights.group);
    const propMaterial = new THREE.MeshStandardMaterial({
      color: 0xb8bec8,
      roughness: 0.7,
    });
    for (const prop of activeSceneDef.props) {
      const mesh = new THREE.Mesh(box, propMaterial);
      mesh.position.set(...prop.position);
      mesh.scale.set(...prop.scale);
      mesh.rotation.set(
        ...(prop.rotation.map((x) => (x * Math.PI) / 180) as [
          number,
          number,
          number,
        ]),
        "YXZ",
      );
      scene.add(mesh);
    }
    const camera = check("ortho")
      ? new THREE.OrthographicCamera(-6, 6, 4, -4, 0.1, 100)
      : new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, checkpoints ? 1 : 8, 8);
    camera.lookAt(0, checkpoints ? 1 : 0.85, 0);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, checkpoints ? 1 : 0.85, 0);
    orbit.update();
    const depth = new ThreeSoftParticleDepth();
    const vfx = new ThreeVfxRenderer({
      scene,
      camera,
      softParticles: depth,
      renderAdapter: node ? createThreeNodeAdapter() : undefined,
      textureProvider: { getTexture: (r) => textures.get(r.path) },
      meshProvider: { getMeshGeometry: (r) => meshes.get(r.path) ?? null },
      materialGraphProvider: (id) => graphs.get(id),
    });
    const authored = normalizeThreeVfxEffect(
      bundle.effectsById.get(effectSelect.value)!,
    );
    const support = manifest.effects.find((e) => e.id === effectSelect.value)!
      .support.backends.three3d;
    el("support").textContent =
      `Three export: ${support.status}. ` +
      [...new Set([...support.warnings, ...support.blockers].map((item) => item.message))].join(" ");
    const definition = structuredClone(authored);
    const instance = vfx.createEffect(definition, { seed: 1234 });
    for (let t = 0; t < 3; t += 1 / 60) vfx.update(1 / 60);
    const nodePipeline = node
      ? new ThreeNodeRenderPipeline(node.renderer, scene, camera)
      : null;
    const composer = node
      ? null
      : new EffectComposer(
          renderer as THREE.WebGLRenderer,
          new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }),
        );
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.35, 1);
    composer?.addPass(new RenderPass(scene, camera));
    composer?.addPass(bloom);
    const resize = () => {
      const w = view.clientWidth,
        h = view.clientHeight;
      renderer.setSize(w, h, false);
      composer?.setSize(w, h);
      if (camera instanceof THREE.PerspectiveCamera) camera.aspect = w / h;
      else {
        camera.left = (-4 * w) / h;
        camera.right = (4 * w) / h;
      }
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(view);
    resize();
    refresh = () => {
      const near = Number(el<HTMLInputElement>("near").value),
        far = Number(el<HTMLInputElement>("far").value);
      if (
        !Number.isFinite(near) ||
        !Number.isFinite(far) ||
        near < 0 ||
        far <= near
      ) {
        el("error").textContent = "Use finite distances: 0 ≤ Near < Far.";
        return;
      }
      el("error").textContent = "";
      for (const e of definition.emitters)
        e.render.softParticles = { enabled: check("enabled"), near, far };
      instance.updateDefinition(definition);
      nodePipeline?.setBloom({
        ...sceneDef.bloom,
        enabled: check("bloom"),
        intensity: 0.6,
      });
    };
    refresh();
    let raf = 0,
      last = performance.now(),
      display = 0;
    const frame = (now: number) => {
      if (document.hidden) {
        raf = 0;
        return;
      }
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      const a = performance.now();
      vfx.update(paused ? 0 : dt);
      const b = performance.now();
      depth.prepare(renderer, scene, camera);
      if (nodePipeline) nodePipeline.render();
      else if (check("bloom")) composer!.render();
      else renderer.render(scene, camera);
      const c = performance.now();
      if (now - display > 250) {
        display = now;
        el("status").textContent =
          `Actual backend: ${node?.backend ?? "webgl"} · Three r${THREE.REVISION} · ${vfx.stats.visibleParticles} particles · Depth passes: ${depth.stats.passes} · Frame ${(dt * 1000).toFixed(1)} ms · Update ${(b - a).toFixed(2)} ms · Render ${(c - b).toFixed(2)} ms · Seed 1234${paused ? " · Paused" : ""}`;
        el("runtime").textContent = [
          ...vfx.stats.missingMeshRefs.map((ref) => `Missing mesh: ${ref.path}`),
          ...vfx.stats.missingMaterialRefs.map((ref) => `Missing material: ${ref}`),
          ...vfx.stats.unsupportedFeatures,
        ].join(" · ");
      }
      raf = requestAnimationFrame(frame);
    };
    const visibility = () => {
      if (!document.hidden && !raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    raf = requestAnimationFrame(frame);
    dispose = () => {
      document.removeEventListener("visibilitychange", visibility);
      cancelAnimationFrame(raf);
      observer.disconnect();
      orbit.dispose();
      vfx.destroy();
      depth.dispose();
      lights.dispose();
      propMaterial.dispose();
      nodePipeline?.dispose();
      bloom.dispose();
      composer?.dispose();
      if (node) disposeThreeWebGpuRenderer(node.renderer);
      else renderer.dispose();
      renderer.domElement.remove();
    };
  } catch (error) {
    el("error").textContent = String(error);
  }
}
for (const id of ["enabled", "near", "far", "bloom"])
  el(id).addEventListener("change", () => refresh());
for (const id of ["backend", "effect", "ortho"])
  el(id).addEventListener("change", () => {
    void start();
  });
el("reset").onclick = () => {
  void start();
};
el("pause").onclick = () => {
  paused = !paused;
  el("pause").textContent = paused ? "Play" : "Pause";
};
window.addEventListener("pagehide", () => {
  dispose();
  for (const t of textures.values()) t.dispose();
  for (const g of meshes.values()) g.dispose();
  box.dispose();
});
await start();
