# Project format

A NixieFX authoring project is a folder containing `vfx-editor.prj`. Read that manifest before deciding where effects or assets belong.

```json
{
  "app": "vfx-editor",
  "kind": "project",
  "version": 1,
  "id": "vfx-unique-project-id",
  "name": "My VFX Project",
  "settings": {
    "effectDataPath": "effects",
    "outputPath": "out/vfx",
    "assetRootPath": "assets",
    "materialsFolder": "materials",
    "allowExternalOutput": false,
    "lastEffectFile": "starter-effect.json"
  },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

## Path semantics

- Resolve `effectDataPath`, `assetRootPath`, and `outputPath` from the project folder.
- Resolve `materialsFolder` from `assetRootPath`.
- Use forward slashes in persisted paths.
- Keep paths relative and free of `.` or `..` segments. The literal `.` is allowed as a complete root value.
- Keep `allowExternalOutput` false unless the user explicitly authorizes an external destination.
- Never place a source root inside the output root or the output root inside a source root.

## Initialize a missing manifest

Copy `assets/starter-project/vfx-editor.prj.template.json` to the chosen project folder as `vfx-editor.prj`. Replace every `REPLACE-*` string with a unique project ID, human name, and current ISO timestamps. Create the configured effects, assets, materials, and output parent folders. Then use `npx nixie-fx effect create`; do not author a full effect schema from memory.

If a manifest already exists, normalize neither its folder layout nor its settings without a user request. Honor it as the project contract.
