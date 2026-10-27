import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { normalizeParticleEffect, ParticleEffectRunner } from "nixie-fx";
import {
  compareVfxExportToSources,
  loadVfxExportBundle,
} from "nixie-fx/export";

const EXAMPLE = new URL("../", import.meta.url);
const BUNDLE = new URL("public/vfx/", EXAMPLE);
const SOURCE = new URL("effects/coin-fountain.json", EXAMPLE);

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
// Asset paths come from the files actually on disk, not from the manifest, so
// requireEveryAsset really checks that the bundle ships what it declares.
const filesOnDisk = (await readdir(BUNDLE, { recursive: true }))
  .map((path) => path.split("\\").join("/"))
  .filter((path) => path !== "manifest.json");

test("the export loads for the PixiJS backend with every asset", () => {
  const bundle = loadVfxExportBundle(
    { manifest, effectsByPath, assetPaths: filesOnDisk },
    {
      requiredBackend: "pixi2d",
      requiredEffectIds: ["coin-fountain"],
      requireEveryAsset: true,
    },
  );
  assert.ok(bundle.effectsById.get("coin-fountain"));

  const entry = manifest.effects.find((item) => item.id === "coin-fountain");
  assert.equal(entry.support.backends.pixi2d.status, "supported");
  assert.deepEqual(entry.support.backends.pixi2d.blockers, []);
});

test("every declared asset is in the bundle", async () => {
  assert.deepEqual(
    manifest.assets.map((asset) => asset.path),
    ["textures/coin.png"],
  );
  const png = await readFile(new URL("textures/coin.png", BUNDLE));
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
});

test("the committed export matches the authored source", () => {
  const comparison = compareVfxExportToSources(manifest, [
    { path: "coin-fountain.json", source },
  ]);
  assert.equal(comparison.outOfDate, false);
});

function simulate(seed, seconds) {
  const effect = normalizeParticleEffect(source);
  const runner = new ParticleEffectRunner(effect);
  runner.reset(effect, [0, 0, 0], 0, seed);
  const dt = 1 / 60;
  let peak = 0;
  let finishedAt = null;
  for (let frame = 1; frame <= Math.round(seconds * 60); frame += 1) {
    runner.update(dt, frame * dt);
    peak = Math.max(peak, runner.stats.activeParticles);
    if (finishedAt === null && !runner.isActive) finishedAt = frame * dt;
  }
  return { runner, peak, finishedAt };
}

test("the same seed replays the same coins", () => {
  const a = simulate(0xc01d, 2).runner.states[0];
  const b = simulate(0xc01d, 2).runner.states[0];
  const c = simulate(0xbeef, 2).runner.states[0];
  assert.equal(a.activeCount, b.activeCount);
  assert.deepEqual([...a.instanceData], [...b.instanceData]);
  assert.notDeepEqual([...a.instanceData], [...c.instanceData]);
});

test("a claim stays well under the emitter's particle budget", () => {
  const { peak } = simulate(0xc01d, 6);
  const budget = source.emitters[0].maxParticles;
  // The runtime clamps emission at maxParticles, so "<= budget" can never
  // fail. Require headroom instead, and pin the measured peak (54) loosely.
  assert.ok(peak < budget, `peak ${peak} saturates maxParticles ${budget}`);
  assert.ok(peak >= 40 && peak <= 64, `peak ${peak} outside 40..64`);
});

test("a claim finishes on its own, so stop() is never needed", () => {
  const { runner, finishedAt } = simulate(0xc01d, 6);
  assert.equal(runner.isActive, false);
  assert.equal(runner.stats.activeParticles, 0);
  assert.ok(finishedAt > 2.4 && finishedAt < 5.5, `finished at ${finishedAt}s`);
});
