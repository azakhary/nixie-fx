import "./style.css";
import { Application } from "pixi.js";
import { loadVfxExportBundle } from "nixie-fx/export";
import { PixiVfxRenderer, createPixiVfx2dProjection } from "nixie-fx/pixi";

const stage = document.querySelector("#stage");
const card = document.querySelector("#card");
const status = document.querySelector("#status");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to load ${url} (${response.status})`);
  return response.json();
}

async function start() {
  const manifest = await getJson("/vfx/manifest.json");
  const effectsByPath = Object.fromEntries(
    await Promise.all(
      manifest.effects.map(async ({ path }) => [
        path,
        await getJson(`/vfx/${path}`),
      ]),
    ),
  );
  const bundle = loadVfxExportBundle(
    {
      manifest,
      effectsByPath,
      assetPaths: manifest.assets.map(({ path }) => path),
    },
    { requiredBackend: "pixi2d", requireEveryAsset: true },
  );
  const effect = bundle.effectsById.get("card-reveal-glow");
  if (!effect) throw new Error("card-reveal-glow missing from export");

  const app = new Application();
  await app.init({
    width: stage.clientWidth,
    height: stage.clientHeight,
    backgroundAlpha: 0,
    antialias: true,
  });
  stage.appendChild(app.canvas);
  const pixelsPerUnit = 150;
  const projection = () =>
    createPixiVfx2dProjection({
      originX: 0,
      originY: 0,
      pixelsPerUnit,
      yAxis: "up",
    });
  const vfx = new PixiVfxRenderer({
    parent: app.stage,
    projection: projection(),
  });
  const live = new Set();
  let revealCount = 0;

  card.addEventListener("click", () => {
    const revealed = card.getAttribute("aria-pressed") !== "true";
    card.setAttribute("aria-pressed", String(revealed));
    card.classList.toggle("revealed", revealed);
    card.setAttribute(
      "aria-label",
      revealed ? "Hide Aurora card" : "Reveal Aurora card",
    );
    if (!revealed) {
      status.textContent = "Card hidden. Reveal it again to replay the effect.";
      return;
    }
    status.textContent = reducedMotion.matches
      ? "Aurora card revealed. Particle motion is disabled by system preference."
      : "Aurora card revealed.";
    if (reducedMotion.matches) return;
    const rect = card.getBoundingClientRect();
    const canvas = app.canvas.getBoundingClientRect();
    const x =
      ((rect.left + rect.width / 2 - canvas.left) / canvas.width) *
      app.screen.width;
    const y =
      ((rect.top + rect.height / 2 - canvas.top) / canvas.height) *
      app.screen.height;
    live.add(
      vfx.createEffect(effect, {
        position: [x / pixelsPerUnit, -y / pixelsPerUnit, 0],
        seed: ++revealCount,
      }),
    );
  });

  app.ticker.add((ticker) => {
    vfx.update(ticker.deltaMS / 1000);
    for (const instance of live) {
      if (instance.isActive) continue;
      vfx.removeEffect(instance, true);
      live.delete(instance);
    }
  });
  const resize = new ResizeObserver(() => {
    app.renderer.resize(stage.clientWidth, stage.clientHeight);
    vfx.setProjection(projection());
  });
  resize.observe(stage);
  window.addEventListener(
    "pagehide",
    () => {
      resize.disconnect();
      vfx.destroy();
      app.destroy(true);
    },
    { once: true },
  );
  status.textContent = "Ready. Reveal the card.";
}

start().catch((error) => {
  status.textContent = `Demo could not start: ${error.message}`;
  console.error(error);
});
