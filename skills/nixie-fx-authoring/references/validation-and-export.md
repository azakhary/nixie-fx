# Validation and export

## Validate source data

Run validation from the project root:

```sh
npx nixie-fx validate .
```

Interpret results as follows:

- `error`: malformed or unsafe authoring data; fix it.
- `blocker`: the exporter or selected backend cannot represent the effect safely; fix it or change the target intentionally.
- `warning` or `partial`: export may proceed, but semantics are approximate or backend-specific; review the named path and verify visually.

Do not delete a diagnostic merely to make validation green. Fix the owning effect, asset, material, path, or target profile.

## Export generated runtime data

Run:

```sh
npx nixie-fx export .
```

The configured output, normally `out/vfx`, should contain:

```text
manifest.json
effects/*.json
<declared asset paths, only when effects use assets>
```

The manifest is the runtime inventory. It records source hashes, validation, assets, and per-backend support. Assets retain their asset-root-relative paths, so do not assume fixed `textures`, `materials`, or `meshes` folders. An assetless effect produces only the manifest and effect JSON. A blocked export may write diagnostics instead of a usable bundle.

## Verify the result

1. Require a successful command exit.
2. Inspect the manifest and require `validation.valid` with no blockers.
3. Confirm the intended effect ID and backend support are present.
4. Confirm every declared asset exists under the output root.
5. Check the diff so unrelated source files and assets remain untouched.
6. Load the exported bundle through `nixie-fx/export`; do not rely only on JSON parsing.
7. Review the source project in the editor and the export in its target runtime.

Never patch a generated effect or manifest under `out/vfx`. Update the authoring source and export again.
