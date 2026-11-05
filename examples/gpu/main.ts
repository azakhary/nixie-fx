import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  Scene,
  PerspectiveCamera,
  Mesh,
  PlaneGeometry,
  TextureLoader,
  SRGBColorSpace,
} from "three";
import { normalizeShaderGraph, type ShaderGraph } from "nixie-fx/materials";
import { loadVfxExportBundle, parseVfxExportManifest } from "nixie-fx/export";
import { ThreeVfxRenderer } from "nixie-fx/three";
import {
  createThreeWebGpuRenderer,
  createThreeNodeAdapter,
  beginThreeWebGpuFrame,
  createThreeClusteredLighting,
  disposeThreeWebGpuRenderer,
} from "nixie-fx/three/webgpu";

const status = document.querySelector<HTMLElement>("#status")!;
const select = document.querySelector<HTMLSelectElement>("#effect")!;
const json = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};
try {
  const manifest = parseVfxExportManifest(await json("/vfx/manifest.json"));
  const effectsByPath = Object.fromEntries(
    await Promise.all(
      manifest.effects.map(async (e) => [e.path, await json(`/vfx/${e.path}`)]),
    ),
  );
  const bundle = loadVfxExportBundle({ manifest, effectsByPath });
  const graphs = new Map<string, ShaderGraph>();
  const textures = new Map<
    string,
    Awaited<ReturnType<TextureLoader["loadAsync"]>>
  >();
  for (const a of manifest.assets) {
    if (a.type === "material") {
      const g = normalizeShaderGraph(await json(`/vfx/${a.path}`));
      graphs.set(g.id, g);
    }
    if (a.type === "texture") {
      const t = await new TextureLoader().loadAsync(`/vfx/${a.path}`);
      t.colorSpace = SRGBColorSpace;
      textures.set(a.path, t);
    }
  }
  for (const e of manifest.effects) select.add(new Option(e.name, e.id));
  const query = new URLSearchParams(location.search);
  select.value =
    query.get("effect") ??
    manifest.effects.find((e) => e.name.includes("Hybrid"))?.id ??
    manifest.effects[0]!.id;
  const { renderer, backend } = await createThreeWebGpuRenderer({
    forceWebGL: query.has("fallback"),
    onDeviceLost: (message) => {
      paused = true;
      status.textContent = `${message}\nReload to recreate buffers; authored export is unchanged.`;
    },
  });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setClearColor(0x15171b);
  document.body.append(renderer.domElement);
  const scene = new Scene(),
    camera = new PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 0, 12);
  const clustered = createThreeClusteredLighting(renderer, scene);
  clustered.manager.setProfile({
    mode: "clustered",
    maxLights: 64,
    maxLightsPerCluster: 64,
    totalSceneLights: 64,
  });
  const floor = new Mesh(
    new PlaneGeometry(15, 15),
    new MeshStandardNodeMaterial({ color: 0x777777 }),
  );
  floor.position.z = -2;
  scene.add(floor);
  const adapter = createThreeNodeAdapter(renderer);
  const runtime = new ThreeVfxRenderer({
    scene,
    camera,
    renderAdapter: adapter,
    captureDebugTransforms: false,
    materialGraphProvider: (id) => graphs.get(id),
    textureProvider: { getTexture: (ref) => textures.get(ref.path) },
  });
  let instance = runtime.createEffect(bundle.effectsById.get(select.value)!, {
    seed: 42,
  });
  clustered.manager.add(instance);
  let paused = false,
    seeking: { time: number; target: number } | undefined;
  select.onchange = () => {
    clustered.manager.remove(instance);
    runtime.removeEffect(instance);
    instance = runtime.createEffect(bundle.effectsById.get(select.value)!, {
      seed: 42,
    });
    clustered.manager.add(instance);
    seeking = undefined;
    if (paused) instance.pause();
  };
  document.querySelector<HTMLButtonElement>("#pause")!.onclick = () => {
    paused = !paused;
    if (paused) instance.pause();
    else instance.play();
  };
  document.querySelector<HTMLButtonElement>("#restart")!.onclick = () => {
    seeking = undefined;
    instance.restart();
    if (paused) instance.pause();
  };
  document.querySelector<HTMLButtonElement>("#seek")!.onclick = () => {
    instance.seek(0);
    instance.play();
    seeking = { time: 0, target: 10 };
  };
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  addEventListener("resize", resize);
  let last = performance.now(),
    displayed = 0,
    raf = 0;
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    beginThreeWebGpuFrame(renderer);
    const started = performance.now();
    if (seeking) {
      let steps = 0;
      while (
        seeking.time < seeking.target &&
        steps++ < 12 &&
        performance.now() - started < 6
      ) {
        const step = Math.min(1 / 60, seeking.target - seeking.time);
        instance.update(step);
        seeking.time += step;
      }
      if (seeking.time >= seeking.target) {
        seeking = undefined;
        if (paused) instance.pause();
      }
    } else if (!paused) runtime.update(dt);
    const simulation = performance.now() - started;
    clustered.manager.update(paused ? 0 : dt, camera);
    const renderStart = performance.now();
    renderer.render(scene, camera);
    const render = performance.now() - renderStart;
    if (now - displayed > 250) {
      displayed = now;
      status.textContent = `${backend} · native compute: ${adapter.computeCapabilities?.compute} · capacity/device ${adapter.computeCapabilities?.maxParticles}\n${paused ? "Paused" : "Playing"}${seeking ? ` · Seeking ${seeking.time.toFixed(1)}/${seeking.target}s` : ""} · CPU submission sim ${simulation.toFixed(2)}ms / render ${render.toFixed(2)}ms\n${JSON.stringify(instance.stats, null, 2)}\nLights: ${clustered.manager.stats.active}/${clustered.manager.stats.budget} · rejected ${clustered.manager.stats.budgetRejected}\nGPU counts are conservative slots; GPU timing unavailable. No particle readback.`;
    }
    raf = requestAnimationFrame(frame);
  }
  const visibility = () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", visibility);
  raf = requestAnimationFrame(frame);
  addEventListener("pagehide", () => {
    cancelAnimationFrame(raf);
    runtime.destroy();
    clustered.dispose();
    floor.geometry.dispose();
    floor.material.dispose();
    for (const t of textures.values()) t.dispose();
    disposeThreeWebGpuRenderer(renderer);
  });
} catch (error) {
  status.textContent = String(error);
  console.error(error);
}
