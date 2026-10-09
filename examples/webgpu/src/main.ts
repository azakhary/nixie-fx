import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { normalizeSceneDefinition } from "nixie-fx";
import { normalizeShaderGraph, type ShaderGraph } from "nixie-fx/materials";
import {
  type VfxExportedEffect,
  loadVfxExportBundle,
  parseVfxExportManifest,
} from "nixie-fx/export";
import {
  ThreeVfxRenderer,
  ThreeVfxLightManager,
  createThreeSceneLights,
  sceneBloomToUnrealBloomParameters,
  type ThreeVfxLightBudget,
} from "nixie-fx/three";
import {
  disposeThreeWebGpuRenderer,
  createThreeNodeAdapter,
  createThreeWebGpuRenderer,
  ThreeNodeRenderPipeline,
} from "nixie-fx/three/webgpu";

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const json = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};
const select = el<HTMLSelectElement>("backend"),
  effectSelect = el<HTMLSelectElement>("effect"),
  view = el("view");
let time = 0,
  paused = false,
  seed = 1234,
  generation = 0,
  abort = new AbortController(),
  dispose = () => {},
  raf = 0,
  last = 0,
  lastDisplay = 0;
let active:
  | {
      renderer: THREE.WebGLRenderer | WebGPURenderer;
      camera: THREE.OrthographicCamera;
      orbit: OrbitControls;
      hosts: ThreeVfxRenderer[];
      manager: ThreeVfxLightManager;
      render: () => void;
      backend: string;
      definition: VfxExportedEffect;
      setBloom: () => void;
    }
  | undefined;
let cameraState:
  { position: THREE.Vector3; target: THREE.Vector3; zoom: number } | undefined;
let injectInit = false;
let measurement:
  | {
      start: number;
      samples: { frame: number; sim: number; render: number; work: number }[];
    }
  | undefined;
function fail(error: unknown) {
  cancelAnimationFrame(raf);
  raf = 0;
  measurement = undefined;
  el("error").textContent =
    error instanceof Error ? error.message : String(error);
  el("status").textContent =
    `Requested ${select.selectedOptions[0].text} · failed · CPU simulation`;
}
function stop() {
  if (active)
    cameraState = {
      position: active.camera.position.clone(),
      target: active.orbit.target.clone(),
      zoom: active.camera.zoom,
    };
  cancelAnimationFrame(raf);
  raf = 0;
  measurement = undefined;
  active = undefined;
  dispose();
  dispose = () => {};
}
async function bootstrap() {
  const manifest = parseVfxExportManifest(await json("/vfx/manifest.json"));
  const effectsByPath = Object.fromEntries(
    await Promise.all(
      manifest.effects.map(async (e) => [e.path, await json(`/vfx/${e.path}`)]),
    ),
  );
  const bundle = loadVfxExportBundle({ manifest, effectsByPath }, {});
  for (const entry of manifest.effects) {
    const option = new Option(entry.name, entry.id);
    effectSelect.add(option);
  }
  effectSelect.value = "webgpu-comparison";
  const graphs = new Map<string, ShaderGraph>(),
    textures = new Map<string, THREE.Texture>(),
    geometries = new Map<string, THREE.BufferGeometry>();
  await Promise.all(
    manifest.assets.map(async (asset) => {
      const url = `/vfx/${asset.path}`;
      if (asset.type === "material") {
        const g = normalizeShaderGraph(await json(url));
        graphs.set(g.id, g);
      }
      if (asset.type === "texture") {
        const t = await new THREE.TextureLoader().loadAsync(url);
        t.colorSpace = THREE.SRGBColorSpace;
        t.minFilter = t.magFilter = THREE.LinearFilter;
        textures.set(asset.path, t);
      }
      if (asset.type === "mesh") {
        const geometry = new THREE.BufferGeometryLoader().parse(
          await json(url),
        );
        geometry.computeVertexNormals();
        geometries.set(asset.path, geometry);
      }
    }),
  );
  const sceneDefinition = normalizeSceneDefinition(
    await json("/authored-assets/scenes/review.scene"),
  );
  const box = geometries.get("box.json")!;
  async function start(resetCamera = false) {
    const current = ++generation;
    abort.abort();
    abort = new AbortController();
    const signal = abort.signal;
    stop();
    if (resetCamera) cameraState = undefined;
    el("error").textContent = "";
    el("status").textContent =
      `Requested ${select.selectedOptions[0].text} · initializing`;
    const releases: Array<() => void> = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const fn of releases.reverse()) fn();
    };
    try {
      if (injectInit) {
        injectInit = false;
        throw new Error(
          "Injected initialization failure. Retry or select legacy WebGL. Authored data is intact.",
        );
      }
      const node =
        select.value !== "webgl"
          ? await createThreeWebGpuRenderer({
              forceWebGL: select.value === "fallback",
              signal,
              onDeviceLost: (message) => {
                if (current === generation) fail(message);
              },
            })
          : undefined;
      const renderer =
        node?.renderer ?? new THREE.WebGLRenderer({ antialias: true });
      releases.push(() => {
        if (renderer instanceof THREE.WebGLRenderer) {
          renderer.dispose();
          renderer.forceContextLoss();
        } else disposeThreeWebGpuRenderer(renderer);
        renderer.domElement.remove();
      });
      signal.throwIfAborted();
      renderer.setPixelRatio(devicePixelRatio);
      renderer.setClearColor(0x10151c);
      view.append(renderer.domElement);
      const scene = new THREE.Scene(),
        camera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.01, 1000);
      camera.position.set(
        0,
        0.85 - Math.sin(-0.82) * 12,
        -Math.cos(-0.82) * 12,
      );
      camera.lookAt(0, 0.85, 0);
      const orbit = new OrbitControls(camera, renderer.domElement);
      orbit.target.set(0, 0.85, 0);
      if (cameraState) {
        camera.position.copy(cameraState.position);
        orbit.target.copy(cameraState.target);
        camera.zoom = cameraState.zoom;
      }
      orbit.update();
      releases.push(() => orbit.dispose());
      const lights = createThreeSceneLights(sceneDefinition);
      scene.add(lights.group);
      releases.push(() => lights.dispose());
      // Game-owned light survives all budget changes. WA-2214 reserves it before
      // selecting candidates, exactly as in the legacy consumer.
      const gameLight = new THREE.DirectionalLight(0xffffff, 0.2);
      gameLight.position.set(2, 5, 3);
      scene.add(gameLight);
      releases.push(() => gameLight.dispose());
      for (const prop of sceneDefinition.props) {
        const material = new THREE.MeshStandardMaterial({
          color: 0xb8bec8,
          roughness: 0.7,
        });
        const mesh = new THREE.Mesh(box, material);
        mesh.position.fromArray(prop.position);
        mesh.scale.fromArray(prop.scale);
        mesh.rotation.set(
          ...(prop.rotation.map((v) => (v * Math.PI) / 180) as [
            number,
            number,
            number,
          ]),
          "YXZ",
        );
        mesh.visible = prop.visible;
        scene.add(mesh);
        releases.push(() => material.dispose());
      }
      const manager = ThreeVfxLightManager.forScene(
        scene,
        Number(el<HTMLSelectElement>("budget").value) as ThreeVfxLightBudget,
      );
      releases.push(() => manager.dispose());
      const definition = bundle.effectsById.get(effectSelect.value)!;
      const hosts: ThreeVfxRenderer[] = [];
      for (
        let i = 0;
        i < Number(el<HTMLSelectElement>("instances").value);
        i++
      ) {
        const host = new ThreeVfxRenderer({
          scene,
          camera,
          captureDebugTransforms: false,
          renderAdapter: node ? createThreeNodeAdapter() : undefined,
          materialGraphProvider: (id) => graphs.get(id),
          textureProvider: { getTexture: (ref) => textures.get(ref.path) },
          meshProvider: {
            getMeshGeometry: (ref) => geometries.get(ref.path) ?? null,
          },
        });
        releases.push(() => host.destroy());
        hosts.push(host);
        const instance = host.createEffect(definition, {
          seed,
          position: [i * 2.5, 0, 0],
        });
        manager.add(instance);
        instance.seek(time);
        if (paused) instance.pause();
      }
      let render: () => void,
        setBloom: () => void,
        resizePost: (w: number, h: number) => void;
      const settings = () => ({
        ...sceneDefinition.bloom,
        enabled: el<HTMLInputElement>("bloom").checked,
      });
      if (node) {
        const pipeline = new ThreeNodeRenderPipeline(
          node.renderer,
          scene,
          camera,
        );
        render = () => pipeline.render();
        setBloom = () => pipeline.setBloom(settings());
        resizePost = () => {};
        releases.push(() => pipeline.dispose());
      } else {
        const composer = new EffectComposer(
          renderer as THREE.WebGLRenderer,
          new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }),
        );
        composer.addPass(new RenderPass(scene, camera));
        const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1, 0, 1);
        composer.addPass(bloom);
        render = () =>
          el<HTMLInputElement>("bloom").checked
            ? composer.render()
            : renderer.render(scene, camera);
        setBloom = () => {
          const p = sceneBloomToUnrealBloomParameters(settings());
          bloom.strength = p.strength;
          bloom.radius = p.radius;
          bloom.threshold = p.threshold;
        };
        resizePost = (w, h) => composer.setSize(w, h);
        releases.push(() => {
          bloom.dispose();
          composer.dispose();
        });
      }
      const setPostBloom = setBloom;
      setBloom = () => {
        const s = settings();
        for (const host of hosts)
          host.setPreviewBloomOptions({
            enabled: s.enabled,
            threshold: s.threshold,
            exposureStops: s.exposure,
          });
        setPostBloom();
      };
      setBloom();
      const resize = () => {
        const w = view.clientWidth,
          h = view.clientHeight;
        renderer.setSize(w, h);
        camera.left = (-6 * w) / h;
        camera.right = (6 * w) / h;
        camera.updateProjectionMatrix();
        resizePost(w, h);
      };
      const observer = new ResizeObserver(resize);
      observer.observe(view);
      resize();
      releases.push(() => observer.disconnect());
      signal.throwIfAborted();
      dispose = release;
      active = {
        renderer,
        camera,
        orbit,
        hosts,
        manager,
        render,
        backend: node?.backend ?? "legacy-webgl",
        definition,
        setBloom,
      };
      el("status").textContent =
        `Requested ${select.selectedOptions[0].text} · active ${node?.backend ?? "legacy-webgl"} · CPU simulation · Three r184`;
      last = 0;
      if (!document.hidden) raf = requestAnimationFrame(frame);
    } catch (error) {
      release();
      if (current === generation && !signal.aborted) fail(error);
    }
  }
  function frame(now: number) {
    raf = 0;
    if (!active || document.hidden) return;
    try {
      const frameMs = last ? now - last : 0;
      last = now;
      const begin = performance.now(),
        dt = paused ? 0 : Math.min(frameMs / 1000, 0.05);
      time += dt;
      for (const host of active.hosts) host.update(dt);
      active.manager.update(dt, active.camera);
      const draw = performance.now();
      active.render();
      const end = performance.now();
      const sample = {
        frame: frameMs,
        sim: draw - begin,
        render: end - draw,
        work: end - begin,
      };
      if (measurement && frameMs > 0) {
        measurement.samples.push(sample);
        if (now - measurement.start >= 30000) {
          const a = measurement.samples,
            sorted = a.map((s) => s.frame).sort((a, b) => a - b);
          el("report").textContent = JSON.stringify(
            {
              date: new Date().toISOString(),
              userAgent: navigator.userAgent,
              backend: active.backend,
              three: "0.184.0",
              dpr: devicePixelRatio,
              resolution: [
                active.renderer.domElement.width,
                active.renderer.domElement.height,
              ],
              seed,
              time,
              effect: active.definition.id,
              instances: active.hosts.length,
              particles: active.hosts.reduce(
                (n, h) => n + h.stats.activeParticles,
                0,
              ),
              lights: active.manager.stats,
              bloom: el<HTMLInputElement>("bloom").checked,
              durationSeconds: (now - measurement.start) / 1000,
              samples: a.length,
              fpsLow: 1000 / sorted[sorted.length - 1]!,
              frameMaxMs: sorted[sorted.length - 1],
              frameP99Ms: sorted[Math.floor(sorted.length * 0.99)],
              simulationMaxMs: Math.max(...a.map((s) => s.sim)),
              renderSubmissionMaxMs: Math.max(...a.map((s) => s.render)),
              editorMs: 0,
              totalWorkMaxMs: Math.max(...a.map((s) => s.work)),
              below90fps: a.filter((s) => s.frame > 1000 / 90).length,
              above13ms: a.filter((s) => s.frame > 13).length,
            },
            null,
            2,
          );
          measurement = undefined;
        }
      }
      if (now - lastDisplay > 250) {
        lastDisplay = now;
        const stats = active.manager.stats;
        el("stats").textContent =
          `${(1000 / (frameMs || 1)).toFixed(1)} FPS · frame ${frameMs.toFixed(2)} ms · sim/preparation/light selection ${sample.sim.toFixed(2)} ms · render CPU ${sample.render.toFixed(2)} ms · editor 0 ms · total work ${sample.work.toFixed(2)} ms\n${active.hosts.reduce((n, h) => n + h.stats.activeParticles, 0)} particles · ${stats.active}/${stats.budget} VFX lights · ${stats.sceneLights} host lights · ${stats.candidates} candidates · t=${time.toFixed(2)} · seed=${seed}\n${active.renderer.domElement.width}×${active.renderer.domElement.height} · DPR ${devicePixelRatio}. Render CPU is submission, not GPU time.`;
      }
      raf = requestAnimationFrame(frame);
    } catch (error) {
      fail(error);
    }
  }
  select.onchange = () => void start();
  effectSelect.onchange = () => {
    time = 0;
    void start();
  };
  el("retry").onclick = () => void start();
  el("legacy").onclick = () => {
    select.value = "webgl";
    void start();
  };
  el("pause").onclick = () => {
    paused = !paused;
    el("pause").textContent = paused ? "Play" : "Pause";
    void start();
  };
  el("restart").onclick = () => {
    time = 0;
    seed = Number(el<HTMLInputElement>("seed").value);
    void start();
  };
  el("checkpoint").onclick = () => {
    time = 1.5;
    paused = true;
    seed = Number(el<HTMLInputElement>("seed").value);
    cameraState = undefined;
    el("pause").textContent = "Play";
    void start(true);
  };
  el<HTMLInputElement>("seek").onchange = () => {
    time = Number(el<HTMLInputElement>("seek").value);
    paused = true;
    el("pause").textContent = "Play";
    void start();
  };
  el<HTMLSelectElement>("budget").onchange = () =>
    active?.manager.setBudget(
      Number(el<HTMLSelectElement>("budget").value) as ThreeVfxLightBudget,
    );
  el<HTMLSelectElement>("instances").onchange = () => void start();
  el<HTMLInputElement>("bloom").onchange = () => active?.setBloom();
  el<HTMLInputElement>("tint").onchange = () => {
    const hex = el<HTMLInputElement>("tint").value;
    const color = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const graph = graphs.get("animated-surface")!;
    graphs.set(graph.id, {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "tint"
          ? {
              ...node,
              type: "constant",
              inputs: {},
              params: { kind: "color", value: [...color, 1] },
            }
          : node,
      ),
    });
    void start();
  };
  el("measure").onclick = () => {
    measurement = { start: performance.now(), samples: [] };
    el("report").textContent =
      "Measuring 30 seconds; keep visible. Warm up for at least 10 seconds first.";
  };
  el("initfail").onclick = () => {
    injectInit = true;
    void start();
  };
  el("loss").onclick = () =>
    fail(
      "Injected device-loss notification (not an actual GPU loss). Retry or select legacy WebGL.",
    );
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(raf);
    raf = 0;
    measurement = undefined;
    if (!document.hidden && active && !el("error").textContent) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  });
  window.addEventListener("pagehide", () => {
    ++generation;
    abort.abort();
    stop();
    for (const t of textures.values()) t.dispose();
    for (const g of geometries.values()) g.dispose();
  });
  await start();
}
void bootstrap().catch(fail);
