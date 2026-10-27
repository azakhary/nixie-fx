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

const EFFECT_ID = "coin-fountain";
const VFX_ROOT = new URL("./vfx/", document.baseURI);
const HUD_UPDATE_INTERVAL_MS = 250;

const host = requireElement<HTMLElement>("#app");
const claimButton = requireElement<HTMLButtonElement>("#claim");
const particleLabel = requireElement<HTMLElement>("#particles");
const statusLabel = requireElement<HTMLElement>("#status");

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  statusLabel.textContent = `Could not start: ${message}`;
  statusLabel.dataset.error = "true";
  claimButton.disabled = true;
  console.error("[nixie-fx pixijs coin fountain]", error);
});

async function start(): Promise<void> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
    preference: "webgl",
  });
  host.prepend(app.canvas);

  const bundle = await loadBundle(VFX_ROOT);
  const effect = bundle.effectsById.get(EFFECT_ID);
  if (!effect) throw new Error(`Export bundle is missing "${EFFECT_ID}".`);

  const textureProvider = createTextureProvider(VFX_ROOT);
  await textureProvider.preload?.(
    effect.assets.filter(
      (asset): asset is VfxTextureAssetRef => asset.type === "texture",
    ),
  );

  const vfx = new PixiVfxRenderer({
    parent: app.stage,
    textureProvider,
    projection: projectionFor(app),
    boundsArea: new Rectangle(0, 0, app.screen.width, app.screen.height),
  });

  // One persistent instance, restarted on every claim instead of re-created.
  // The emitter is authored as a 2.4 s one-shot, so after emission ends the
  // coins already in the air finish their arc and the instance goes inactive.
  const fountain = vfx.createEffect(effect, {
    seed: 0xc01d,
    autoStart: false,
  });
  // With autoStart: false nothing has synced the instance's diagnostics into
  // vfx.stats yet; one draw does that without advancing the simulation.
  vfx.draw();

  const diagnostics = [
    ...vfx.stats.missingTextureRefs.map((ref) => `missing ${ref.path}`),
    ...vfx.stats.missingMaterialRefs.map((id) => `missing ${id}`),
    ...vfx.stats.unsupportedModules.map((item) => item.moduleKey),
    ...vfx.stats.unsupportedFeatures.map((item) => item.featureKey),
  ];
  if (diagnostics.length > 0) {
    throw new Error(`Runtime diagnostics: ${diagnostics.join(", ")}`);
  }

  statusLabel.textContent = "coin-fountain · pixi2d · compiled export";
  claimButton.disabled = false;

  let claiming = false;
  claimButton.addEventListener("click", () => {
    claiming = true;
    claimButton.disabled = true;
    claimButton.textContent = "+120 coins";
    // spawn() restarts the instance. Do not call stop() to end the fountain:
    // on the Pixi backend it clears every live coin at once.
    fountain.spawn();
  });

  let hudElapsedMs = HUD_UPDATE_INTERVAL_MS;
  const update = (ticker: Ticker): void => {
    vfx.update(ticker.deltaMS / 1000);

    if (claiming && !fountain.isActive) {
      claiming = false;
      claimButton.textContent = "Claim reward";
      claimButton.disabled = false;
    }

    hudElapsedMs += ticker.elapsedMS;
    if (hudElapsedMs >= HUD_UPDATE_INTERVAL_MS) {
      hudElapsedMs = 0;
      particleLabel.textContent = `${vfx.stats.activeParticles} coins`;
    }
  };
  app.ticker.add(update, undefined, UPDATE_PRIORITY.HIGH);

  let resizeFrame = 0;
  const resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      vfx.setProjection(projectionFor(app));
      vfx.setBoundsArea(
        new Rectangle(0, 0, app.screen.width, app.screen.height),
      );
    });
  });
  resizeObserver.observe(host);

  const onVisibilityChange = (): void => {
    if (document.hidden) app.stop();
    else app.start();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  window.addEventListener(
    "pagehide",
    () => {
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
    },
    { once: true },
  );
}

function projectionFor(app: Application) {
  // The fountain's origin sits on the claim button. The effect is authored in
  // world units with +Y up, so coins arc upward on screen and fall back down.
  const button = claimButton.getBoundingClientRect();
  const bounds = app.canvas.getBoundingClientRect();
  return createPixiVfx2dProjection({
    originX: button.left - bounds.left + button.width / 2,
    originY: button.top - bounds.top,
    pixelsPerUnit: Math.min(64, Math.max(36, app.screen.height / 9)),
    yAxis: "up",
  });
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

async function loadBundle(root: URL) {
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
    { requiredBackend: "pixi2d", requiredEffectIds: [EFFECT_ID] },
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
