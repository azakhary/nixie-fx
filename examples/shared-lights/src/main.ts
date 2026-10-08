import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { normalizeSceneDefinition } from "nixie-fx";
import { loadVfxExportBundle, parseVfxExportManifest } from "nixie-fx/export";
import {
  ThreeVfxRenderer,
  ThreeVfxLightManager,
  createThreeSceneLights,
  type ThreeVfxEffectInstance,
  type ThreeVfxLightBudget,
} from "nixie-fx/three";
async function start(): Promise<void> {
  const element = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x10151c);
  const viewport = element("view");
  viewport.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 100);
  camera.position.set(6, 5, 9);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 1, 0);
  orbit.update();
  const resize = () => {
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
    camera.aspect = viewport.clientWidth / viewport.clientHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();
  const getJson = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
  };
  const sceneDefinition = normalizeSceneDefinition(
    await getJson("/review.scene"),
  );
  const sceneLights = createThreeSceneLights(sceneDefinition);
  scene.add(sceneLights.group);
  const box = new THREE.BufferGeometryLoader().parse(
    await getJson("/box.json"),
  );
  box.computeVertexNormals();
  for (const prop of sceneDefinition.props) {
    const mesh = new THREE.Mesh(
      box,
      new THREE.MeshStandardMaterial({ color: 0xb8bec8, roughness: 0.7 }),
    );
    mesh.position.fromArray(prop.position);
    mesh.scale.fromArray(prop.scale);
    mesh.rotation.set(
      ...(prop.rotation.map((n) => (n * Math.PI) / 180) as [
        number,
        number,
        number,
      ]),
      "YXZ",
    );
    scene.add(mesh);
  }
  // Host-owned light: its cost is reserved before assigning the independent 0/2/4 VFX allowance.
  const gameLight = new THREE.DirectionalLight(0xffffff, 0.2);
  gameLight.position.set(2, 5, 3);
  scene.add(gameLight);
  const manager = ThreeVfxLightManager.forScene(scene, 2);
  const manifest = parseVfxExportManifest(await getJson("/vfx/manifest.json"));
  const effectsByPath = Object.fromEntries(
    await Promise.all(
      manifest.effects.map(async (entry) => [
        entry.path,
        await getJson(`/vfx/${entry.path}`),
      ]),
    ),
  );
  const bundle = loadVfxExportBundle(
    { manifest, effectsByPath },
    { requiredBackend: "three3d" },
  );
  const effect = bundle.effectsById.get("shared-lights")!;
  const hosts: {
    host: ThreeVfxRenderer;
    instance: ThreeVfxEffectInstance;
    release: () => void;
  }[] = [];
  let paused = false,
    time = 0,
    overlap = false;
  function add() {
    const host = new ThreeVfxRenderer({
      scene,
      camera,
      captureDebugTransforms: false,
    });
    const instance = host.createEffect(effect, { seed: 1234 + hosts.length });
    hosts.push({ host, instance, release: manager.add(instance) });
    if (paused) instance.pause();
  }
  for (let i = 0; i < 3; i++) add();
  element("add").onclick = add;
  element("remove").onclick = () => {
    const entry = hosts.pop();
    entry?.release();
    entry?.host.destroy();
  };
  element("pause").onclick = () => {
    paused = !paused;
    for (const { instance } of hosts) {
      if (paused) instance.pause();
      else instance.play();
    }
    element("pause").textContent = paused ? "Resume" : "Pause";
  };
  element("restart").onclick = () => {
    time = 0;
    for (const { instance } of hosts) {
      instance.restart();
      if (paused) instance.pause();
    }
    manager.reset();
  };
  element<HTMLInputElement>("seek").oninput = (event) => {
    time = Number((event.target as HTMLInputElement).value);
    for (const { instance } of hosts) instance.seek(time);
    manager.reset();
  };
  element<HTMLSelectElement>("budget").onchange = (event) =>
    manager.setBudget(
      Number((event.target as HTMLSelectElement).value) as ThreeVfxLightBudget,
    );
  element<HTMLInputElement>("game").oninput = (event) =>
    (gameLight.intensity = Number((event.target as HTMLInputElement).value));
  element<HTMLInputElement>("overlap").onchange = (event) => {
    overlap = (event.target as HTMLInputElement).checked;
  };
  const gl = renderer.getContext();
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  const device = {
    userAgent: navigator.userAgent,
    gpu: extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : "unavailable",
    dpr: devicePixelRatio,
    resolution: [renderer.domElement.width, renderer.domElement.height],
  };
  let measurement: {
    start: number;
    frames: { frame: number; sim: number; render: number; total: number }[];
  } | null = null;
  const reports: unknown[] = [];
  element("measure").onclick = () => {
    measurement = { start: performance.now(), frames: [] };
    element("measurements").textContent =
      "Measuring 30 seconds. Keep this tab visible.";
  };
  element("copy").onclick = () =>
    navigator.clipboard.writeText(JSON.stringify(reports, null, 2));
  let last: number | null = null;
  let lastDisplay = 0,
    raf = 0;
  function frame(now: number) {
    const frameMs = last === null ? 0 : Math.max(0, now - last);
    last = now;
    const begin = performance.now();
    const dt = paused ? 0 : Math.min(frameMs / 1000, 0.05);
    time += dt;
    hosts.forEach(({ host, instance }, index) => {
      if (!paused)
        instance.setTransform({
          position: [
            overlap ? 0 : (index - 1) * 2.5,
            0,
            overlap ? 0 : 0.25 * Math.sin(time + index),
          ],
          rotation: [0, 0.15 * Math.sin(time * 0.5 + index), 0],
        });
      host.update(dt);
    });
    manager.update(dt, camera);
    const draw = performance.now();
    renderer.render(scene, camera);
    const end = performance.now();
    const sample = {
      frame: frameMs,
      sim: draw - begin,
      render: end - draw,
      total: end - begin,
    };
    if (measurement && frameMs > 0) {
      measurement.frames.push(sample);
      if (now - measurement.start >= 30000) {
        const samples = measurement.frames;
        const sorted = samples.map((s) => s.frame).sort((a, b) => a - b);
        reports.push({
          device,
          budget: manager.stats.budget,
          instances: hosts.length,
          particles: hosts.reduce(
            (n, h) => n + h.instance.stats.activeParticles,
            0,
          ),
          candidates: manager.stats.candidates,
          active: manager.stats.active,
          sceneLights: manager.stats.sceneLights,
          overlap,
          radius: 2.8,
          bloom: false,
          material: "MeshStandard, roughness 0.7; additive particle billboards",
          durationSeconds: (now - measurement.start) / 1000,
          frames: samples.length,
          fpsLow: 1000 / Math.max(...sorted),
          frameMaxMs: Math.max(...sorted),
          frameP99Ms: sorted[Math.floor(sorted.length * 0.99)],
          maxSimulationMs: Math.max(...samples.map((s) => s.sim)),
          maxRenderMs: Math.max(...samples.map((s) => s.render)),
          maxTotalWorkMs: Math.max(...samples.map((s) => s.total)),
          samplesBelow90fps: samples.filter((s) => s.frame > 1000 / 90).length,
          samplesAbove13ms: samples.filter((s) => s.frame > 13).length,
        });
        measurement = null;
        element("measurements").textContent = JSON.stringify(reports, null, 2);
      }
    }
    if (now - lastDisplay > 250) {
      lastDisplay = now;
      element("stats").textContent =
        `${(frameMs > 0 ? 1000 / frameMs : 0).toFixed(1)} FPS · frame ${frameMs.toFixed(2)} ms · simulation/selection ${sample.sim.toFixed(2)} ms · render ${sample.render.toFixed(2)} ms · total work ${sample.total.toFixed(2)} ms\n${hosts.length} instances · ${hosts.reduce((n, h) => n + h.instance.stats.activeParticles, 0)} particles · ${manager.stats.candidates} candidates · ${manager.stats.active}/${manager.stats.budget} active/budget · ${manager.stats.sceneLights} existing scene lights\n${device.gpu} · DPR ${device.dpr} · ${renderer.domElement.width}×${renderer.domElement.height}`;
    }
    raf = requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(raf);
    measurement = null;
    if (!document.hidden) {
      last = null;
      raf = requestAnimationFrame(frame);
    }
  });
  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(raf);
    for (const h of hosts) {
      h.release();
      h.host.destroy();
    }
    manager.dispose();
    sceneLights.dispose();
    orbit.dispose();
    renderer.dispose();
  });
  raf = requestAnimationFrame(frame);
}
void start().catch((error) => {
  const status = document.getElementById("stats");
  if (status) status.textContent = `Failed to start: ${String(error)}`;
  console.error(error);
});
