import "./style.css";
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
  Container,
  Graphics,
  Rectangle,
  Texture,
  UPDATE_PRIORITY,
  type Ticker,
} from "pixi.js";

const EFFECT_ID = "smoke-puff";
const VFX_ROOT = new URL("./vfx/", document.baseURI);
const PIXELS_PER_UNIT = 90;
const DEMO_SEED = 0x4e323131;

const host = requireElement<HTMLElement>("#stage");
const status = requireElement<HTMLElement>("#status");
const count = requireElement<HTMLElement>("#count");
const replay = requireElement<HTMLButtonElement>("#replay");

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `Could not start: ${message}`;
  status.style.color = "#ff8291";
  console.error("[pixijs-smoke-puff]", error);
});

async function start(): Promise<void> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
  });
  host.append(app.canvas);

  const { effect, textureProvider } = await loadEffect();
  const scenery = new Container();
  const effects = new Container();
  app.stage.addChild(scenery, effects);

  const vfx = new PixiVfxRenderer({
    parent: effects,
    textureProvider,
    projection: projectionFor(),
    boundsArea: boundsFor(app),
  });

  const drawScenery = (): void => {
    scenery
      .removeChildren()
      .forEach((child) => child.destroy({ children: true }));
    const centerX = app.screen.width / 2;
    const baseY = app.screen.height * 0.72;

    const panel = new Graphics()
      .roundRect(centerX - 120, baseY - 34, 240, 82, 20)
      .fill({ color: 0x1d2730, alpha: 1 })
      .stroke({ color: 0x3b4a57, width: 2 });
    const port = new Graphics()
      .circle(centerX, baseY - 36, 30)
      .fill({ color: 0x090c10, alpha: 1 })
      .stroke({ color: 0x8fd3ff, width: 3, alpha: 0.8 });
    scenery.addChild(panel, port);
  };

  const play = (): void => {
    const position: [number, number, number] = [
      app.screen.width / 2 / PIXELS_PER_UNIT,
      (app.screen.height * 0.72 - 36) / PIXELS_PER_UNIT,
      0,
    ];
    vfx.createEffect(effect, { position, seed: DEMO_SEED });
    status.textContent = "smoke-puff · deterministic export replayed";
  };

  let hudElapsedMs = 0;
  const update = (ticker: Ticker): void => {
    vfx.update(ticker.deltaMS / 1000);
    hudElapsedMs += ticker.elapsedMS;
    if (hudElapsedMs >= 150) {
      hudElapsedMs = 0;
      count.textContent = `${vfx.stats.activeParticles} particles`;
    }
  };

  drawScenery();
  play();
  replay.addEventListener("click", play);
  app.ticker.add(update, undefined, UPDATE_PRIORITY.HIGH);

  const observer = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      drawScenery();
      vfx.setProjection(projectionFor());
      vfx.setBoundsArea(boundsFor(app));
    });
  });
  observer.observe(host);

  let destroyed = false;
  window.addEventListener(
    "pagehide",
    () => {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      replay.removeEventListener("click", play);
      app.ticker.remove(update);
      vfx.destroy();
      textureProvider.release?.();
      app.destroy({ removeView: true }, { children: true });
    },
    { once: true },
  );
}

function projectionFor() {
  return createPixiVfx2dProjection({
    originX: 0,
    originY: 0,
    pixelsPerUnit: PIXELS_PER_UNIT,
    yAxis: "down",
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
      for (const url of urls.values())
        void Assets.unload(url).catch(() => undefined);
      urls.clear();
      textures.clear();
    },
  };
}

async function loadEffect() {
  const rawManifest = await fetchJson(new URL("manifest.json", VFX_ROOT));
  const manifest = parseVfxExportManifest(rawManifest);
  const effectsByPath = Object.fromEntries(
    await Promise.all(
      manifest.effects.map(async ({ path }) => [
        path,
        await fetchJson(new URL(path, VFX_ROOT)),
      ]),
    ),
  );
  const textureProvider = createTextureProvider(VFX_ROOT);
  const textures = manifest.assets.filter(
    (asset): asset is VfxTextureAssetRef => asset.type === "texture",
  );
  await textureProvider.preload?.(textures);

  const bundle = loadVfxExportBundle(
    {
      manifest: rawManifest,
      effectsByPath,
      assetPaths: manifest.assets.map((asset) => asset.path),
    },
    {
      requiredBackend: "pixi2d",
      requiredEffectIds: [EFFECT_ID],
      requireEveryAsset: true,
    },
  );
  const effect = bundle.effectsById.get(EFFECT_ID);
  if (!effect) throw new Error(`Missing ${EFFECT_ID} in export bundle.`);

  return { effect, textureProvider };
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to load ${url.pathname} (${response.status}).`);
  return response.json() as Promise<unknown>;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}
