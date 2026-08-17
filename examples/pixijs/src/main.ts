import type { VfxTextureAssetRef } from "nixie-fx";
import { loadVfxExportBundle, parseVfxExportManifest } from "nixie-fx/export";
import {
  createPixiVfx2dProjection,
  PixiVfxRenderer,
  type PixiVfxTextureProvider,
} from "nixie-fx/pixi";
import {
  Application,
  Assets,
  Rectangle,
  Texture,
  UPDATE_PRIORITY,
  type Ticker,
} from "pixi.js";

const EFFECT_ID = "opening-engine";
const VFX_ROOT = new URL("./vfx/", document.baseURI);
const HUD_UPDATE_INTERVAL_MS = 250;

const host = requireElement<HTMLElement>("#app");
const fpsLabel = requireElement<HTMLElement>("#fps");
const particleLabel = requireElement<HTMLElement>("#particles");
const statusLabel = requireElement<HTMLElement>("#status");

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  statusLabel.textContent = `Could not start: ${message}`;
  statusLabel.dataset.error = "true";
  console.error("[nixie-fx pixijs example]", error);
});

async function start(): Promise<void> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    background: "#020304",
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
    preference: "webgl",
    powerPreference: "high-performance",
  });
  host.prepend(app.canvas);

  const bundle = await loadBundle(VFX_ROOT, "pixi2d");
  const effect = bundle.effectsById.get(EFFECT_ID);
  if (!effect) throw new Error(`Export bundle is missing "${EFFECT_ID}".`);

  const textureProvider = createTextureProvider(VFX_ROOT);
  const textureRefs = effect.assets.filter(
    (asset): asset is VfxTextureAssetRef => asset.type === "texture",
  );
  await textureProvider.preload?.(textureRefs);

  const vfx = new PixiVfxRenderer({
    parent: app.stage,
    textureProvider,
    projection: projectionFor(app),
    boundsArea: boundsFor(app),
  });
  vfx.createEffect(effect, { seed: 0x4e495849 });

  const diagnostics = [
    ...vfx.stats.missingTextureRefs.map((ref) => `missing ${ref.path}`),
    ...vfx.stats.missingMaterialRefs.map((id) => `missing ${id}`),
    ...vfx.stats.unsupportedModules.map((item) => item.moduleKey),
    ...vfx.stats.unsupportedFeatures.map((item) => item.featureKey),
  ];
  if (diagnostics.length > 0) {
    throw new Error(`Runtime diagnostics: ${diagnostics.join(", ")}`);
  }

  statusLabel.textContent = "opening-engine · compiled export";

  let hudElapsedMs = HUD_UPDATE_INTERVAL_MS;
  const update = (ticker: Ticker): void => {
    // NixieFX is advanced once. Pixi's Application renders once later in the
    // same ticker at its built-in low priority.
    vfx.update(ticker.deltaMS / 1000);

    hudElapsedMs += ticker.elapsedMS;
    if (hudElapsedMs >= HUD_UPDATE_INTERVAL_MS) {
      hudElapsedMs = 0;
      fpsLabel.textContent = `${Math.round(ticker.FPS)} FPS`;
      particleLabel.textContent = `${vfx.stats.activeParticles} particles`;
    }
  };
  app.ticker.add(update, undefined, UPDATE_PRIORITY.HIGH);

  let resizeFrame = 0;
  const syncProjection = (): void => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      vfx.setProjection(projectionFor(app));
      vfx.setBoundsArea(boundsFor(app));
    });
  };
  const resizeObserver = new ResizeObserver(syncProjection);
  resizeObserver.observe(host);

  const onVisibilityChange = (): void => {
    if (document.hidden) app.stop();
    else app.start();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(resizeFrame);
    resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    app.ticker.remove(update);
    vfx.destroy();
    textureProvider.release?.();
    app.destroy(
      { removeView: true, releaseGlobalResources: true },
      { children: true },
    );
  };
  window.addEventListener("pagehide", destroy, { once: true });
}

function projectionFor(app: Application) {
  const shortestSide = Math.min(app.screen.width, app.screen.height);
  return createPixiVfx2dProjection({
    originX: app.screen.width * 0.5,
    originY: app.screen.height * 0.23,
    pixelsPerUnit: Math.min(52, Math.max(24, shortestSide * 0.07)),
    // The authored exhaust velocity is negative Y; a Y-up world therefore
    // sends it downward on the 2D screen.
    yAxis: "up",
  });
}

function boundsFor(app: Application): Rectangle {
  return new Rectangle(0, 0, app.screen.width, app.screen.height);
}

function createTextureProvider(root: URL): PixiVfxTextureProvider {
  const textures = new Map<string, Texture>();
  const urls = new Map<string, string>();

  return {
    async preload(refs) {
      await Promise.all(
        refs.map(async (ref) => {
          const url = new URL(ref.path, root).href;
          textures.set(ref.path, await Assets.load<Texture>(url));
          urls.set(ref.path, url);
        }),
      );
    },
    getTexture(ref) {
      return textures.get(ref.path);
    },
    resolveUrl(ref) {
      return new URL(ref.path, root).href;
    },
    release() {
      for (const url of urls.values()) {
        void Assets.unload(url).catch(() => undefined);
      }
      urls.clear();
      textures.clear();
    },
  };
}

async function loadBundle(root: URL, requiredBackend: "pixi2d" | "three3d") {
  const rawManifest = await fetchJson(new URL("manifest.json", root));
  const manifest = parseVfxExportManifest(rawManifest);
  const effectsByPath = Object.fromEntries(
    await Promise.all(
      manifest.effects.map(async ({ path }) => [
        path,
        await fetchJson(new URL(path, root)),
      ]),
    ),
  );

  return loadVfxExportBundle(
    { manifest: rawManifest, effectsByPath },
    { requiredBackend, requiredEffectIds: [EFFECT_ID] },
  );
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url.pathname} (${response.status}).`);
  }
  return response.json() as Promise<unknown>;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}
