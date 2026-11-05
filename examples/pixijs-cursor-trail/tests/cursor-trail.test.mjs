import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  compareVfxExportToSources,
  compileVfxExport,
  loadVfxExportBundle,
} from "nixie-fx/export";
import { PixiVfxRenderer } from "nixie-fx/pixi";
import { Texture } from "pixi.js";
// Node strips the types from this module, so the tests drive the same
// pointer mapping and stroke handling as the page.
import {
  CursorTrail,
  PIXELS_PER_UNIT,
  screenToWorld,
  TRAIL_PROJECTION,
} from "../src/cursor-trail.ts";

const EXAMPLE = new URL("../", import.meta.url);
const BUNDLE = new URL("public/vfx/", EXAMPLE);
const SOURCE = new URL("effects/cursor-trail.json", EXAMPLE);
const FRAME = 1 / 60;
const SEED = 0x7472616c;

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const manifest = await readJson(new URL("manifest.json", BUNDLE));
const effectsByPath = Object.fromEntries(
  await Promise.all(
    manifest.effects.map(async ({ path }) => [
      path,
      await readJson(new URL(path, BUNDLE)),
    ]),
  ),
);
const source = await readJson(SOURCE);
// Asset paths come from the files actually on disk. With requireEveryAsset the
// loader rejects the bundle if a declared asset is missing from them. This
// effect declares none, so the first test also pins the bundle's contents.
const filesOnDisk = (await readdir(BUNDLE, { recursive: true }))
  .map((path) => path.split("\\").join("/"))
  .filter((path) => path !== "manifest.json");
const bundle = loadVfxExportBundle(
  { manifest, effectsByPath, assetPaths: filesOnDisk },
  {
    requiredBackend: "pixi2d",
    requiredEffectIds: ["cursor-trail"],
    requireEveryAsset: true,
  },
);
const effect = bundle.effectsById.get("cursor-trail");
const emitter = source.emitters[0];
const maxLifetime = emitter.initializeParticle.lifetime.max;
const particlesPerPixel =
  emitter.spawn.rateOverDistanceValue.value / PIXELS_PER_UNIT;

// Node has no canvas for the procedural circle, so stand in empty textures.
// Simulation and screen placement do not depend on texture pixels.
const fallbackTextures = Object.fromEntries(
  ["circle", "square", "triangleShard", "quadShard", "grassShard"].map(
    (key) => [key, Texture.EMPTY],
  ),
);

function createTrail(seed = SEED) {
  const vfx = new PixiVfxRenderer({
    projection: TRAIL_PROJECTION,
    fallbackTextures,
  });
  return { vfx, trail: new CursorTrail(vfx, effect, seed) };
}

/**
 * Plays `frames` frames like the page does: an optional pointer sample, then
 * exactly one renderer update. Returns the renderer stats of every frame.
 */
function play({ vfx, trail }, frames, pointerAt = () => null) {
  const samples = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const point = pointerAt(frame);
    if (point) trail.moveTo(point[0], point[1]);
    vfx.update(FRAME);
    trail.prune();
    samples.push({
      active: vfx.stats.activeParticles,
      emitted: vfx.stats.emittedLastFrame,
    });
  }
  return samples;
}

/**
 * Starts a stroke and lets one frame pass with the pointer resting there.
 * The runtime measures distance from its first update after a restart, so
 * movement within the frame a stroke begins would not be counted.
 */
function begin(run, x, y) {
  run.trail.begin(x, y);
  play(run, 1);
}

/** A horizontal sweep at `speed` px/s, starting at (x, y). */
const sweep = (x, y, speed) => (frame) => [x + (frame + 1) * speed * FRAME, y];
const sum = (samples, key) => samples.reduce((total, s) => total + s[key], 0);
const peak = (samples) => Math.max(...samples.map((s) => s.active));

test("the export loads for pixi2d and needs no asset files", () => {
  assert.ok(effect);
  const entry = manifest.effects.find((item) => item.id === "cursor-trail");
  assert.equal(entry.support.backends.pixi2d.status, "supported");
  assert.deepEqual(entry.support.backends.pixi2d.blockers, []);
  // A procedural soft-circle billboard: no texture, so nothing to ship.
  assert.equal(emitter.render.texture, null);
  assert.equal(emitter.billboard.shape, "circle");
  assert.deepEqual(manifest.assets, []);
  assert.deepEqual(effect.assets, []);
  assert.deepEqual(filesOnDisk.sort(), [
    "effects",
    "effects/cursor-trail.json",
  ]);
});

test("the committed export is exactly what the source compiles to", () => {
  // Recompile in memory with the export's own timestamp. A source change
  // without a re-export, or a hand edit under public/vfx, fails here.
  const compiled = compileVfxExport(
    [
      {
        effect: source,
        effectPath: "effects/cursor-trail.json",
        sourceEffectFile: "cursor-trail.json",
      },
    ],
    { generatedAt: manifest.generatedAt },
  );
  const asJson = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(asJson(compiled.manifest), manifest);
  assert.deepEqual(
    asJson(compiled.effects[0].effect),
    effectsByPath["effects/cursor-trail.json"],
  );
  const comparison = compareVfxExportToSources(manifest, [
    { path: "cursor-trail.json", source },
  ]);
  assert.equal(comparison.outOfDate, false);
});

test("pointer pixels land on the same pixels, whatever the viewport", () => {
  // The projection takes no viewport input, so resizing cannot shift it.
  for (const [x, y] of [
    [0, 0],
    [123.5, 456.25],
    [1920, 1080],
    [390, 844],
  ]) {
    const point = TRAIL_PROJECTION.project(screenToWorld(x, y));
    assert.ok(Math.abs(point.x - x) < 1e-9 && Math.abs(point.y - y) < 1e-9);
  }
});

test("a stationary pointer emits nothing", () => {
  const run = createTrail();
  begin(run, 320, 240);
  const samples = play(run, 180, () => [320, 240]);
  assert.equal(sum(samples, "emitted"), 0);
  assert.equal(peak(samples), 0);
});

test("moving emits by distance and the particles stay on the path", () => {
  const run = createTrail();
  begin(run, 100, 300);
  // 600 px in one second, ending at x = 700.
  const samples = play(run, 60, sweep(100, 300, 600));
  // One particle per 20 px of travel (1.2 per 24 px world unit).
  assert.equal(sum(samples, "emitted"), Math.round(600 * particlesPerPixel));

  const quads = run.vfx.getParticleDebugQuads();
  assert.equal(quads.length, samples.at(-1).active);
  // Spawn jitter is ±3 px and the drift adds at most ~9 px.
  for (const quad of quads) {
    assert.ok(Math.abs(quad.y - 300) < 14, `particle at y ${quad.y}`);
    assert.ok(quad.x > 90 && quad.x < 710, `particle at x ${quad.x}`);
  }
  const newest = quads.reduce((a, b) => (b.x > a.x ? b : a));
  assert.ok(Math.abs(newest.x - 700) < 20, `newest particle at ${newest.x}`);
});

test("ordinary movement stays inside the intended particle budget", () => {
  const run = createTrail();
  begin(run, 100, 300);
  // Two seconds at 600 px/s. Measure the steady state once the first
  // particles have had a full lifetime to die.
  const ordinary = play(run, 120, sweep(100, 300, 600)).slice(40);
  const low = Math.min(...ordinary.map((s) => s.active));
  const high = peak(ordinary);
  assert.ok(low >= 8 && high <= 20, `steady state ${low}..${high}`);

  // A fast flick (3000 px/s for 0.4 s) must stay well below maxParticles
  // (128). The runtime silently drops emission at the cap, so reaching it
  // would show up as a thinner trail rather than an error.
  const flick = createTrail();
  begin(flick, 0, 300);
  const fast = peak(play(flick, 24, sweep(0, 300, 3000)));
  assert.ok(fast >= 40 && fast <= 80, `flick peak ${fast}`);
});

test("the trail fades out after the pointer stops, then emits again", () => {
  const run = createTrail();
  begin(run, 100, 300);
  play(run, 60, sweep(100, 300, 600));
  const hold = play(run, 300, () => [700, 300]);
  assert.equal(sum(hold, "emitted"), 0);
  const clearedAt = hold.findIndex((s) => s.active === 0);
  assert.ok(clearedAt >= 0, "particles never cleared");
  assert.ok(
    clearedAt * FRAME <= maxLifetime + 2 * FRAME,
    `cleared after ${clearedAt * FRAME}s`,
  );
  assert.ok(hold.slice(clearedAt).every((s) => s.active === 0));

  // The instance stays armed: the next movement emits without a restart.
  const resumed = play(run, 30, sweep(700, 300, -600));
  assert.ok(sum(resumed, "emitted") > 0);
});

test("a new stroke does not emit for the jump and lets the old one fade", () => {
  const run = createTrail();
  begin(run, 100, 300);
  play(run, 30, sweep(100, 300, 600));
  const before = run.vfx.stats.activeParticles;
  assert.ok(before > 0);

  // The same 1000 px jump (400,300 -> 1200,900) twice: first as a continuing
  // stroke, which sprays the whole distance in one frame, then as a new one.
  const sprayed = createTrail();
  begin(sprayed, 100, 300);
  play(sprayed, 30, sweep(100, 300, 600));
  sprayed.trail.moveTo(1200, 900);
  const [jump] = play(sprayed, 1);
  // Exactly 50 on paper; floating-point accumulation can land on 49.
  const jumpCost = 1000 * particlesPerPixel;
  assert.ok(
    jump.emitted >= jumpCost - 1 && jump.emitted <= jumpCost,
    `sprayed ${jump.emitted}`,
  );

  run.trail.begin(1200, 900);
  const [first] = play(run, 1, () => [1200, 900]);
  assert.equal(first.emitted, 0);
  assert.equal(run.trail.strokeCount, 2);
  // The old stroke's particles are still drawn while they fade...
  assert.ok(first.active > 0 && first.active <= before);

  // ...and once they are gone the old instance is removed.
  play(run, Math.ceil(maxLifetime / FRAME) + 2, () => [1200, 900]);
  assert.equal(run.trail.strokeCount, 1);
  assert.equal(run.vfx.stats.effectCount, 1);
  assert.equal(run.vfx.stats.activeParticles, 0);
});

test("the same seed and path replay the same particles", () => {
  const replay = (seed) => {
    const run = createTrail(seed);
    begin(run, 100, 300);
    play(run, 45, (frame) => [
      100 + frame * 12,
      300 + 80 * Math.sin(frame / 7),
    ]);
    return run.vfx.getParticleDebugQuads();
  };
  const a = replay(SEED);
  assert.ok(a.length > 0);
  assert.deepEqual(replay(SEED), a);
  assert.notDeepEqual(replay(SEED + 1), a);
});
