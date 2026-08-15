---
name: nixie-fx-authoring
description: Create, modify, validate, and export NixieFX particle-effect projects for the public editor and runtimes. Use when an agent needs to locate or initialize vfx-editor.prj, create an effect with the nixie-fx CLI, edit effect JSON, organize textures materials or meshes, diagnose validation and backend-support reports, export out/vfx, or prepare an effect for visual review in the NixieFX editor.
---

# NixieFX Authoring

Author project data with generated defaults, validate every change, and use the real editor for visual judgment.

## Workflow

1. Locate the intended `vfx-editor.prj` within the user-scoped folder. Do not search or modify unrelated projects.
2. Read [project-format.md](references/project-format.md). If the project is missing, initialize its manifest from the bundled template and replace every marked value.
3. Check the installed CLI contract before editing:

   ```sh
   npx nixie-fx --help
   ```

   If the advertised command or option differs, follow the shipped help. If the package is unavailable, report that the public release is incomplete instead of inventing a replacement format.

4. Read [effect-workflow.md](references/effect-workflow.md), then create a normalized effect with the CLI:

   ```sh
   npx nixie-fx effect create --project . --name "Fire Burst" --profile pixi-ui-2d
   ```

5. Edit the generated effect rather than hand-writing the full schema. Preserve unrelated emitters and project files.
6. Add referenced files under the configured asset root and keep effect references project-relative with forward slashes.
7. Validate after each meaningful edit:

   ```sh
   npx nixie-fx validate .
   ```

8. Resolve all errors and blockers. Review partial-support warnings against the intended backend.
9. Read [validation-and-export.md](references/validation-and-export.md), then export:

   ```sh
   npx nixie-fx export .
   ```

10. Open [nixiefx.com/editor](https://nixiefx.com/editor/) in a Chromium-compatible browser, choose **Open Folder**, and select the folder containing `vfx-editor.prj`. Inspect the intended backend preview and refine the effect. Schema validation is not visual approval.

## Authoring rules

- Treat `vfx-editor.prj` and source effects as authoring data; treat `out/vfx` as generated game-facing data.
- Never edit generated `out/vfx` files to fix an effect. Change the source and export again.
- Generate unique project, effect, and emitter IDs. Never reuse an ID merely by copying a file.
- Keep paths inside their configured roots. Do not enable external output unless the user explicitly asks for it.
- Use `pixi-ui-2d`, `three-world-3d`, or `portable` deliberately. Portable means the common supported subset, not automatic parity.
- Use prepared runtime mesh assets; raw source formats are not runtime inputs.
- Keep a bounded diff and preserve user-created assets, materials, settings, and output policy.

## Bundled template

Use [vfx-editor.prj.template.json](assets/starter-project/vfx-editor.prj.template.json) only when a project manifest is absent. Copy it as `vfx-editor.prj`, replace all `REPLACE-*` strings, and create the configured folders before running `effect create`.

## Completion checks

- `vfx-editor.prj` is valid and all configured paths resolve safely.
- The source effect validates with no errors or blockers.
- The target backend has no unexplained blocked or partial behavior.
- Export regenerates a valid manifest, effect files, and referenced assets.
- Only intended source and generated files changed.
- The effect has been visually reviewed in the real editor; otherwise report visual review as pending.
