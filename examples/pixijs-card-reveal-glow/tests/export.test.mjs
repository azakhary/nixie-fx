import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  compareVfxExportToSources,
  loadVfxExportBundle,
} from "nixie-fx/export";

const json = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("authored card effect matches the supported Pixi export", async () => {
  const source = await json(
    "../vfx-project/particle-data/effects/card-reveal-glow.json",
  );
  const manifest = await json("../public/vfx/manifest.json");
  const compiled = await json("../public/vfx/effects/card-reveal-glow.json");
  const comparison = compareVfxExportToSources(manifest, [
    { path: "card-reveal-glow.json", source },
  ]);
  assert.equal(comparison.outOfDate, false);
  assert.equal(manifest.effects[0].support.backends.pixi2d.status, "supported");
  const bundle = loadVfxExportBundle(
    {
      manifest,
      effectsByPath: { "effects/card-reveal-glow.json": compiled },
      assetPaths: [],
    },
    { requiredBackend: "pixi2d", requireEveryAsset: true },
  );
  assert.ok(bundle.effectsById.has("card-reveal-glow"));
  assert.notEqual(source.id, "impact-burst");
  assert.deepEqual(
    source.emitters.map(({ spawn }) => spawn.shape),
    ["box", "box", "box", "box"],
  );
  assert.equal(source.emitters.length, 4);
});
