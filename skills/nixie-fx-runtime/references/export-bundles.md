# Export bundles

Use the editor-generated bundle, normally at `out/vfx`:

```text
out/vfx/
  manifest.json
  effects/*.json
  <declared asset paths, when the effects use assets>
```

Asset folders are not fixed: export preserves each manifest asset's root-relative `path`, such as `spark.png`, `particles/spark.png`, or `materials/fire.material`. Assetless effects produce no asset folders. Resolve only `manifest.assets[*].path` relative to the bundle root. Never reinterpret those paths relative to the source project or import source authoring JSON into a game.

## Load and verify

Fetch the manifest first, parse it, fetch every declared effect, then let the official loader verify identities, hashes, validation, and backend support.

```ts
import { loadVfxExportBundle, parseVfxExportManifest } from "nixie-fx/export";

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}`);
  return response.json() as Promise<unknown>;
}

export async function loadBundle(
  baseUrl: string,
  requiredBackend: "pixi2d" | "three3d",
) {
  const root = baseUrl.replace(/\/+$/, "");
  const rawManifest = await fetchJson(`${root}/manifest.json`);
  const manifest = parseVfxExportManifest(rawManifest);
  const effectsByPath = Object.fromEntries(
    await Promise.all(
      manifest.effects.map(async ({ path }) => [
        path,
        await fetchJson(`${root}/${path}`),
      ]),
    ),
  );

  return loadVfxExportBundle(
    { manifest: rawManifest, effectsByPath },
    { requiredBackend },
  );
}
```

Pass `requiredEffectIds` when the application depends on named effects. Pass both `assetPaths` and `requireEveryAsset: true` only when the host can enumerate the deployed files.

## Incremental exports

A bundle can be written one effect at a time. A single-effect export merges the
recompiled effect into the bundle already on disk: other effects keep their
compiled files and manifest entries, the manifest's `assets` becomes the union
of what the surviving effects reference (orphans are deleted from the output
root), and `generatedAt`, the aggregate `sourceHash` and `validation` are
recomputed for the merged set. Every effect file is rewritten with the new
`generatedAt` so the loader's manifest/effect consistency check holds. Each
manifest effect entry also carries its own `validation`; the manifest's
top-level `validation` is the union of those.

Consume the result exactly as any other bundle — nothing in the loading code
above changes.

## Is the bundle current?

`compareVfxExportToSources` (from `nixie-fx/export`, browser-safe, pure) answers
whether the bundle still matches the authored effect JSON. The caller reads both
sides and passes them in:

```ts
import { compareVfxExportToSources } from "nixie-fx/export";

const comparison = compareVfxExportToSources(manifest, [
  { path: "fire.json", source: fireJson },
  { path: "nested/smoke.json", source: smokeJson },
]);
// comparison.effects[i].status: "exported" | "stale" | "unexported"
// comparison.orphans: manifest effects whose authored source is gone
// comparison.outOfDate: true when anything is stale, unexported or orphaned
```

Statuses use the exporter's own per-effect source hash, so they are exact. Pass
`null` when no manifest exists; every source is then `unexported`. From a shell,
`nixie-fx export-status [project-folder]` prints the same table and always
exits 0.

## Support and assets

- Reject a manifest whose validation is invalid or whose blockers are non-empty; the loader enforces this.
- Reject `blocked` support for the selected backend.
- Treat `partial` as an explicit review requirement. Read its warnings before shipping.
- Load texture assets into the backend texture provider.
- Parse `.material` JSON into material graphs keyed by graph ID, then expose them through the material graph provider.
- Decode prepared mesh assets into the host engine's geometry and expose them through the mesh provider.
- Map source paths to atlas frame names inside the provider; do not rewrite the exported manifest to match an atlas.

Use exported effect objects from `bundle.effectsById` or `bundle.effectsByPath` when calling `createEffect`.
