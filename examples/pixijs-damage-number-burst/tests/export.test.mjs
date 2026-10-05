// Contract tests for the committed export. Run with `npm test` (node --test).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  compareVfxExportToSources,
  loadVfxExportBundle,
} from "nixie-fx/export";

const root = new URL("../", import.meta.url);
const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));

const manifest = readJson("public/vfx/manifest.json");
const effectIds = ["hit-sparks", "crit-burst"];

test("the committed export matches the authored sources", () => {
  const sources = effectIds.map((id) => ({
    path: `${id}.json`,
    source: readJson(`effects/${id}.json`),
  }));
  const comparison = compareVfxExportToSources(manifest, sources);
  assert.equal(comparison.missingManifest, false);
  assert.deepEqual(
    comparison.effects.map((e) => [e.path, e.status]),
    sources.map((s) => [s.path, "exported"]),
    "run `npm run vfx:export` after editing effects/",
  );
  assert.equal(comparison.orphans.length, 0);
});

test("both effects load for the PixiJS backend with full support", () => {
  const effectsByPath = Object.fromEntries(
    manifest.effects.map((e) => [e.path, readJson(`public/vfx/${e.path}`)]),
  );
  const bundle = loadVfxExportBundle(
    { manifest, effectsByPath },
    { requiredBackend: "pixi2d", requiredEffectIds: effectIds },
  );
  assert.equal(manifest.validation.valid, true);
  for (const id of effectIds) {
    const effect = bundle.effectsById.get(id);
    assert.ok(effect, `${id} is in the bundle`);
    assert.equal(
      effect.support.backends.pixi2d.status,
      "supported",
      `${id} pixi2d support`,
    );
    assert.deepEqual(effect.support.backends.pixi2d.blockers, []);
  }
});

test("the effects are one-shot bursts, and the crit burst is the bigger one", () => {
  const burstCount = (id) => {
    const emitter = readJson(`effects/${id}.json`).emitters[0];
    assert.equal(emitter.loop, false, `${id} must not loop`);
    assert.equal(emitter.spawn.rate, 0, `${id} has no continuous emission`);
    return emitter.spawn.bursts.reduce((sum, b) => sum + b.count * b.cycles, 0);
  };
  assert.ok(burstCount("crit-burst") > burstCount("hit-sparks"));
});
