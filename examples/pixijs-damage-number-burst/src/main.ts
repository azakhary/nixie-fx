import { loadVfxExportBundle, parseVfxExportManifest } from "nixie-fx/export";
import {
  createPixiVfx2dProjection,
  PixiVfxRenderer,
  type PixiVfxEffectInstance,
} from "nixie-fx/pixi";
import { Application, Container, Graphics, Text, type Ticker } from "pixi.js";

const VFX_ROOT = new URL("./vfx/", document.baseURI);
const WIDTH = 720;
const HEIGHT = 405;
const PIXELS_PER_UNIT = 100;
const NUMBER_LIFETIME = 0.8; // seconds a damage number stays on screen
const NUMBER_RISE = 56; // pixels it floats up over its lifetime
const CRIT_CHANCE = 0.2;

const host = requireElement<HTMLElement>("#app");
const statusLabel = requireElement<HTMLElement>("#status");

void start().catch((error: unknown) => {
  statusLabel.textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}`;
  console.error("[nixie-fx damage number example]", error);
});

async function start(): Promise<void> {
  // 1. Load the exported bundle: manifest first, then every effect it lists.
  const manifest = parseVfxExportManifest(
    await fetchJson(new URL("manifest.json", VFX_ROOT)),
  );
  const effectsByPath: Record<string, unknown> = {};
  for (const entry of manifest.effects) {
    effectsByPath[entry.path] = await fetchJson(new URL(entry.path, VFX_ROOT));
  }
  const bundle = loadVfxExportBundle(
    { manifest, effectsByPath },
    {
      requiredBackend: "pixi2d",
      requiredEffectIds: ["hit-sparks", "crit-burst"],
    },
  );
  const hitSparks = bundle.effectsById.get("hit-sparks")!;
  const critBurst = bundle.effectsById.get("crit-burst")!;

  // 2. Pixi scene: a target to hit, a layer for numbers, effects on top.
  const app = new Application();
  await app.init({
    width: WIDTH,
    height: HEIGHT,
    background: "#161824",
    antialias: true,
  });
  host.appendChild(app.canvas);

  const target = new Graphics()
    .roundRect(-70, -90, 140, 180, 28)
    .fill("#4b5170")
    .circle(0, -20, 26)
    .fill("#d9dbe4")
    .circle(0, -20, 12)
    .fill("#c0392b");
  target.position.set(WIDTH / 2, HEIGHT / 2 + 30);
  target.eventMode = "static";
  target.cursor = "crosshair";
  app.stage.addChild(target);

  const numberLayer = new Container();
  app.stage.addChild(numberLayer);

  // Effects use canvas pixels / 100 as units, origin top-left, y down.
  const vfx = new PixiVfxRenderer({
    parent: app.stage,
    projection: createPixiVfx2dProjection({
      originX: 0,
      originY: 0,
      pixelsPerUnit: PIXELS_PER_UNIT,
      yAxis: "down",
    }),
  });

  // 3. Damage numbers are pooled Text objects: created once, reused, never destroyed per hit.
  interface FloatingNumber {
    text: Text;
    age: number;
    startY: number;
    drift: number;
    active: boolean;
  }
  const pool: FloatingNumber[] = [];
  const takeNumber = (): FloatingNumber => {
    const free = pool.find((n) => !n.active);
    if (free) return free;
    const text = new Text({
      text: "",
      style: {
        fontFamily: "system-ui",
        fontWeight: "800",
        stroke: { color: "#10111a", width: 5 },
      },
    });
    text.anchor.set(0.5);
    numberLayer.addChild(text);
    const created = { text, age: 0, startY: 0, drift: 0, active: false };
    pool.push(created);
    return created;
  };

  const effects = new Set<PixiVfxEffectInstance>();
  let seed = 1;
  let hits = 0;
  let crits = 0;

  function hit(x: number, y: number, crit: boolean): void {
    const damage = crit
      ? 60 + Math.floor(Math.random() * 40)
      : 12 + Math.floor(Math.random() * 30);
    const n = takeNumber();
    n.active = true;
    n.age = 0;
    n.startY = y - 10;
    n.drift = (Math.random() - 0.5) * 40;
    n.text.text = crit ? `${damage}!` : String(damage);
    n.text.style.fill = crit ? "#ffd34d" : "#ffffff";
    n.text.style.fontSize = crit ? 40 : 28;
    n.text.position.set(x, n.startY);
    n.text.alpha = 1;
    n.text.visible = true;

    effects.add(
      vfx.createEffect(crit ? critBurst : hitSparks, {
        position: [x / PIXELS_PER_UNIT, y / PIXELS_PER_UNIT, 0],
        seed: seed++,
      }),
    );
    hits++;
    if (crit) crits++;
  }

  target.on("pointerdown", (event) =>
    hit(event.global.x, event.global.y, Math.random() < CRIT_CHANCE),
  );
  requireElement<HTMLButtonElement>("#hit").addEventListener("click", () =>
    hit(target.x, target.y - 20, false),
  );
  requireElement<HTMLButtonElement>("#crit").addEventListener("click", () =>
    hit(target.x, target.y - 20, true),
  );

  // 4. One update per frame: move numbers, step effects, reap finished instances.
  app.ticker.add((ticker: Ticker) => {
    const dt = ticker.deltaMS / 1000; // NixieFX takes seconds
    for (const n of pool) {
      if (!n.active) continue;
      n.age += dt;
      const t = Math.min(1, n.age / NUMBER_LIFETIME);
      const ease = 1 - (1 - t) * (1 - t); // ease-out
      n.text.y = n.startY - NUMBER_RISE * ease;
      n.text.x += (n.drift * dt) / NUMBER_LIFETIME;
      n.text.alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      if (t >= 1) {
        n.active = false;
        n.text.visible = false; // back to the pool
      }
    }

    vfx.update(dt);
    for (const fx of effects) {
      if (!fx.isActive) {
        vfx.removeEffect(fx, true);
        effects.delete(fx);
      }
    }

    const active = pool.filter((n) => n.active).length;
    statusLabel.textContent = `hits ${hits} (crits ${crits}) | numbers on screen ${active}, pooled ${pool.length} | live effects ${effects.size} | particles ${vfx.stats.activeParticles}`;
  });

  Object.assign(window, { damageDemo: { hit, pool, effects, vfx } });
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to load ${url.pathname}: ${response.status}`);
  return response.json();
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
