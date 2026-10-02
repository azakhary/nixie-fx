import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("compiled smoke puff is a supported PixiJS export", async () => {
  const manifest = await readJson("../public/vfx/manifest.json");
  const entry = manifest.effects.find((effect) => effect.id === "smoke-puff");

  assert.ok(entry, "manifest should include smoke-puff");
  assert.equal(entry.support.backends.pixi2d.status, "supported");
  assert.equal(manifest.validation.valid, true);
  assert.ok(manifest.assets.some((asset) => asset.path === "smoke-disc.png"));
});

test("source stays bounded and uses one one-shot emitter", async () => {
  const effect = await readJson("../effects/smoke-puff.json");

  assert.equal(effect.targetProfile, "pixi-ui-2d");
  assert.equal(effect.emitters.length, 1);
  assert.equal(effect.emitters[0].loop, false);
  assert.equal(effect.emitters[0].maxParticles, 64);
  assert.equal(effect.emitters[0].spawn.bursts[0].count, 18);
  assert.equal(effect.emitters[0].render.texture, "smoke-disc.png");
});
