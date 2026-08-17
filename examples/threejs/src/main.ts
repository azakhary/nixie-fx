import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { VfxMeshAssetRef, VfxTextureAssetRef } from "nixie-fx";
import { loadVfxExportBundle, parseVfxExportManifest } from "nixie-fx/export";
import {
  ThreeVfxRenderer,
  ThreeVfxTextureStore,
  type ThreeVfxMeshProvider,
} from "nixie-fx/three";
import { createNixieTube } from "./nixie/createNixieTube";
import {
  addStudioLights,
  addStudioWorld,
  applyStudioEnvironment,
} from "./nixie/studio";

const EFFECT_ID = "digit-embers";
const VFX_ROOT_URL = new URL("vfx/", document.baseURI);

const viewport = requireElement<HTMLDivElement>("viewport");
const fpsValue = requireElement<HTMLSpanElement>("fps-value");
const particleValue = requireElement<HTMLElement>("particle-value");
const supportValue = requireElement<HTMLElement>("support-value");
const statusLabel = requireElement<HTMLElement>("status-label");
const statusLight = requireElement<HTMLElement>("status-light");
const runtimeMessage = requireElement<HTMLElement>("runtime-message");
const fatalError = requireElement<HTMLElement>("fatal-error");
const fatalErrorMessage = requireElement<HTMLElement>("fatal-error-message");

let disposeDemo: (() => void) | undefined;

void start().catch((error: unknown) => {
  disposeDemo?.();
  showFatalError(error);
});

async function start(): Promise<void> {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x14100c, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute(
    "aria-label",
    "Nixie tube with NixieFX digit embers. Drag to orbit and scroll to zoom.",
  );
  viewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 80);
  camera.position.set(1.45, 3.9, 6.9);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 4.6;
  controls.maxDistance = 10;
  controls.minPolarAngle = 0.72;
  controls.maxPolarAngle = 1.55;
  controls.target.set(0, 1.62, 0);
  controls.autoRotateSpeed = -1.45;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const applyMotionPreference = () => {
    controls.autoRotate = !reducedMotion.matches;
  };
  reducedMotion.addEventListener("change", applyMotionPreference);
  applyMotionPreference();
  controls.update();

  const studioEnvironment = applyStudioEnvironment(renderer, scene);
  addStudioWorld(scene);
  const neonLight = addStudioLights(scene);

  const tube = createNixieTube();
  tube.setDigit(Math.floor(Date.now() / 1000) % 10);
  scene.add(tube.group);

  const ownedRuntime: {
    vfx?: ThreeVfxRenderer;
    textureStore?: ThreeVfxTextureStore;
  } = {};
  const meshGeometries = new Set<THREE.BufferGeometry>();
  let animationFrame = 0;
  let disposed = false;

  const resize = () => {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    camera.aspect = width / height;
    camera.fov = width < 640 ? 36 : 30;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);
  resize();

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    reducedMotion.removeEventListener("change", applyMotionPreference);
    window.removeEventListener("pagehide", cleanup);
    controls.dispose();
    ownedRuntime.vfx?.destroy();
    ownedRuntime.textureStore?.destroy();
    meshGeometries.forEach((geometry) => geometry.dispose());
    studioEnvironment.dispose();
    disposeSceneGraph(scene);
    renderer.dispose();
    renderer.domElement.remove();
  };
  disposeDemo = cleanup;
  window.addEventListener("pagehide", cleanup, { once: true });

  const { effect, supportStatus, supportWarnings } = await loadDigitEmbers();
  if (disposed) return;

  supportValue.textContent = supportStatus;
  const textureStore = new ThreeVfxTextureStore({
    resolveUrl: (path) => new URL(path, VFX_ROOT_URL).toString(),
  });
  ownedRuntime.textureStore = textureStore;
  const textureRefs = effect.assets.filter(
    (asset): asset is VfxTextureAssetRef => asset.type === "texture",
  );
  await textureStore.preload(textureRefs);
  if (disposed) return;

  const meshRefs = effect.assets.filter(
    (asset): asset is VfxMeshAssetRef => asset.type === "mesh",
  );
  const loadedMeshes = await loadMeshAssets(meshRefs);
  if (disposed) {
    loadedMeshes.geometries.forEach((geometry) => geometry.dispose());
    return;
  }
  loadedMeshes.geometries.forEach((geometry) => meshGeometries.add(geometry));

  const vfx = new ThreeVfxRenderer({
    camera,
    parent: tube.emberAnchor,
    textureProvider: textureStore,
    meshProvider: loadedMeshes.provider,
    // Per-particle debug matrices power editor overlays; a game consumer that
    // does not display those overlays should not capture them every frame.
    captureDebugTransforms: false,
  });
  ownedRuntime.vfx = vfx;
  const embers = vfx.createEffect(effect, {
    seed: 0xdecafbad,
  });
  const authoredBurstCount =
    effect.emitters.find((emitter) => emitter.id === "embers")?.spawn.bursts[0]
      ?.count ?? 300;
  const bindDigitGeometry = (digit: number) => {
    embers.setEmissionGeometry("embers", tube.getEmberGeometry(digit));
    embers.setTransform({ position: [0, 0, tube.getDigitZ(digit)] });
  };
  const emitDigitBurst = (digit: number) => {
    bindDigitGeometry(digit);
    embers.emitBurst("embers", { count: authoredBurstCount });
  };
  // Bind before the first update so the authored time-zero burst starts on the
  // currently lit digit rather than on the exported placeholder mesh.
  bindDigitGeometry(tube.getDigit());

  updateDiagnostics(vfx, supportWarnings);

  let previousFrame = performance.now();
  let fpsWindowStart = previousFrame;
  let lastContinuousFrame = previousFrame;
  let framesInWindow = 0;

  const frame = (now: number) => {
    if (disposed || !vfx) return;
    animationFrame = requestAnimationFrame(frame);

    const deltaSeconds = Math.min(
      0.1,
      Math.max(0, (now - previousFrame) / 1000),
    );
    previousFrame = now;

    controls.update();
    const digit = Math.floor(Date.now() / 1000) % 10;
    if (digit !== tube.getDigit()) {
      tube.setDigit(digit);
      emitDigitBurst(digit);
    }
    tube.update(now / 1000);
    neonLight.intensity = 3 + Math.sin(now / 250) * 0.16;

    // NixieFX advances once, then Three.js renders the complete host scene once.
    vfx.update(deltaSeconds);
    renderer.render(scene, camera);

    if (now - lastContinuousFrame > 250) {
      framesInWindow = 0;
      fpsWindowStart = now;
    }
    lastContinuousFrame = now;
    framesInWindow += 1;
    const fpsElapsed = now - fpsWindowStart;
    if (fpsElapsed >= 500) {
      fpsValue.textContent = String(
        Math.round((framesInWindow * 1000) / fpsElapsed),
      );
      particleValue.textContent = String(vfx.stats.visibleParticles);
      updateDiagnostics(vfx, supportWarnings);
      framesInWindow = 0;
      fpsWindowStart = now;
    }
  };

  animationFrame = requestAnimationFrame(frame);
}

async function loadDigitEmbers() {
  const rawManifest = await fetchJson(new URL("manifest.json", VFX_ROOT_URL));
  const manifest = parseVfxExportManifest(rawManifest);
  const effectsByPath = Object.fromEntries(
    await Promise.all(
      manifest.effects.map(async (entry) => [
        entry.path,
        await fetchJson(new URL(entry.path, VFX_ROOT_URL)),
      ]),
    ),
  );
  const bundle = loadVfxExportBundle(
    { manifest: rawManifest, effectsByPath },
    { requiredBackend: "three3d", requiredEffectIds: [EFFECT_ID] },
  );
  const effect = bundle.effectsById.get(EFFECT_ID);
  if (!effect) throw new Error(`The bundle does not contain "${EFFECT_ID}".`);

  const support = bundle.manifest.effects.find(
    (entry) => entry.id === EFFECT_ID,
  )?.support.backends.three3d;
  if (!support) throw new Error("The bundle has no Three.js support report.");

  return {
    effect,
    supportStatus: support.status,
    supportWarnings: support.warnings.map((warning) => warning.message),
  };
}

function updateDiagnostics(
  vfx: ThreeVfxRenderer,
  supportWarnings: readonly string[],
): void {
  const issues = [
    ...vfx.stats.missingMeshRefs.map((ref) => `missing mesh: ${ref.path}`),
    ...vfx.stats.missingMaterialRefs.map((id) => `missing material: ${id}`),
    ...vfx.stats.unsupportedFeatures,
  ];
  if (issues.length === 0) {
    if (supportWarnings.length > 0) {
      statusLight.classList.remove("is-live");
      statusLight.classList.add("is-warning");
      statusLabel.textContent = "Runtime live · partial";
      runtimeMessage.textContent = `Resources clean · ${supportWarnings.join(" · ")}`;
      return;
    }
    statusLight.classList.remove("is-warning");
    statusLight.classList.add("is-live");
    statusLabel.textContent = "Runtime live";
    runtimeMessage.textContent =
      "Runtime diagnostics clean · one update and one render per frame";
    return;
  }

  statusLight.classList.remove("is-live");
  statusLight.classList.add("is-warning");
  statusLabel.textContent = "Review diagnostics";
  runtimeMessage.textContent = issues.join(" · ");
}

async function loadMeshAssets(refs: readonly VfxMeshAssetRef[]): Promise<{
  provider: ThreeVfxMeshProvider;
  geometries: ReadonlyMap<string, THREE.BufferGeometry>;
}> {
  const loader = new THREE.BufferGeometryLoader();
  const geometries = new Map<string, THREE.BufferGeometry>();
  await Promise.all(
    refs.map(async (ref) => {
      const json = await fetchJson(new URL(ref.path, VFX_ROOT_URL));
      geometries.set(ref.path, loader.parse(json));
    }),
  );
  return {
    provider: {
      getMeshGeometry(ref) {
        return geometries.get(ref.path) ?? null;
      },
    },
    geometries,
  };
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url.pathname} (${response.status}).`);
  }
  return response.json() as Promise<unknown>;
}

function disposeSceneGraph(scene: THREE.Scene): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
  scene.clear();
}

function showFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  fatalErrorMessage.textContent = message;
  fatalError.hidden = false;
  statusLight.classList.remove("is-live");
  statusLight.classList.add("is-warning");
  statusLabel.textContent = "Runtime stopped";
  runtimeMessage.textContent = message;
  console.error(error);
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}.`);
  return element as T;
}
