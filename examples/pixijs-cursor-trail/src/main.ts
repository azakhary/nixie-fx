import { loadVfxExportBundle, parseVfxExportManifest } from "nixie-fx/export";
import {
  createPixiVfxProceduralTextures,
  destroyPixiVfxProceduralTextures,
  PixiVfxRenderer,
} from "nixie-fx/pixi";
import {
  Application,
  UPDATE_PRIORITY,
  type FederatedPointerEvent,
  type Ticker,
} from "pixi.js";
import { CursorTrail, TRAIL_PROJECTION } from "./cursor-trail";

const EFFECT_ID = "cursor-trail";
const VFX_ROOT = new URL("./vfx/", document.baseURI);
const SEED = 0x7472616c;
const HUD_UPDATE_INTERVAL_MS = 250;

const host = requireElement<HTMLElement>("#app");
const particleLabel = requireElement<HTMLElement>("#particles");
const statusLabel = requireElement<HTMLElement>("#status");

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  statusLabel.textContent = `Could not start: ${message}`;
  statusLabel.dataset.error = "true";
  console.error("[nixie-fx pixijs cursor trail]", error);
});

async function start(): Promise<void> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    background: "#0b0d12",
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
    preference: "webgl",
  });
  host.prepend(app.canvas);

  const bundle = await loadBundle(VFX_ROOT);
  const effect = bundle.effectsById.get(EFFECT_ID);
  if (!effect) throw new Error(`Export bundle is missing "${EFFECT_ID}".`);

  // The effect is a procedural soft-circle billboard with no texture files.
  // Create the procedural textures once and share them: an instance that
  // creates its own set does not destroy it, so every stroke would leak one.
  const fallbackTextures = createPixiVfxProceduralTextures();
  // The projection does not depend on the viewport, and app.screen is resized
  // in place, so neither needs updating when the window resizes.
  const vfx = new PixiVfxRenderer({
    parent: app.stage,
    fallbackTextures,
    projection: TRAIL_PROJECTION,
    boundsArea: app.screen,
  });
  const trail = new CursorTrail(vfx, effect, SEED);

  const diagnostics = [
    ...vfx.stats.missingTextureRefs.map((ref) => `missing ${ref.path}`),
    ...vfx.stats.missingMaterialRefs.map((id) => `missing ${id}`),
    ...vfx.stats.unsupportedModules.map((item) => item.moduleKey),
    ...vfx.stats.unsupportedFeatures.map((item) => item.featureKey),
  ];
  if (diagnostics.length > 0) {
    throw new Error(`Runtime diagnostics: ${diagnostics.join(", ")}`);
  }

  // The stage listens across the whole canvas.
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;

  // event.global is in the same CSS-pixel space as app.screen, whatever the
  // device pixel ratio, so it maps straight to the trail's world space.
  let tracking = false;
  const onPointer = (event: FederatedPointerEvent): void => {
    if (!event.isPrimary) return;
    if (tracking) {
      trail.moveTo(event.global.x, event.global.y);
    } else {
      trail.begin(event.global.x, event.global.y);
      tracking = true;
    }
  };
  // Fires when a mouse leaves the canvas and after a touch lifts or is
  // cancelled, so the next sample starts a new stroke.
  const onPointerLeave = (event: FederatedPointerEvent): void => {
    if (event.isPrimary) tracking = false;
  };
  // Switching tabs or windows can skip pointerleave; the pointer may be
  // anywhere when it comes back.
  const endStroke = (): void => {
    tracking = false;
  };
  app.stage.on("pointerdown", onPointer);
  app.stage.on("pointermove", onPointer);
  app.stage.on("pointerleave", onPointerLeave);
  window.addEventListener("blur", endStroke);

  statusLabel.textContent = "cursor-trail · pixi2d · compiled export";

  let hudElapsedMs = HUD_UPDATE_INTERVAL_MS;
  const update = (ticker: Ticker): void => {
    // One NixieFX update per Pixi frame; the Application renders afterwards
    // at its built-in low priority.
    vfx.update(ticker.deltaMS / 1000);
    trail.prune();

    hudElapsedMs += ticker.elapsedMS;
    if (hudElapsedMs >= HUD_UPDATE_INTERVAL_MS) {
      hudElapsedMs = 0;
      particleLabel.textContent = `${vfx.stats.activeParticles} particles`;
    }
  };
  app.ticker.add(update, undefined, UPDATE_PRIORITY.HIGH);

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      endStroke();
      app.stop();
    } else {
      app.start();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  const onPageHide = (event: PageTransitionEvent): void => {
    // A page going into the back/forward cache is restored as it was, so
    // only tear down when it is really being unloaded.
    if (event.persisted) return;
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("blur", endStroke);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    app.stage.off("pointerdown", onPointer);
    app.stage.off("pointermove", onPointer);
    app.stage.off("pointerleave", onPointerLeave);
    app.ticker.remove(update);
    vfx.destroy();
    destroyPixiVfxProceduralTextures(fallbackTextures);
    app.destroy(
      { removeView: true, releaseGlobalResources: true },
      { children: true },
    );
  };
  window.addEventListener("pagehide", onPageHide);
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
