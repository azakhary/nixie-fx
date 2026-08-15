# NixieFX contributor notes

NixieFX is the public runtime package. Keep editor UI, project-picker,
browser-filesystem, landing-page, and hosting code out of this repository.

## Package boundaries

- `nixie-fx` is backend-neutral and must not import PixiJS or Three.js.
- `nixie-fx/materials` is backend-neutral.
- `nixie-fx/export` must remain browser-safe and must not import Node builtins.
- Node filesystem behavior belongs behind `nixie-fx/export/node` or the CLI.
- `nixie-fx/pixi` may import `pixi.js`, never `three`.
- `nixie-fx/three` may import `three`, never `pixi.js`.
- Do not expose or rely on deep `src/**` imports. Add a deliberate named export
  when a supported integration needs an API.

## Runtime behavior

- Preserve deterministic simulation and serialized/exported formats unless a
  versioned format change is explicitly planned.
- Run one simulation/update pass and one render pass per host frame. Do not add
  a second zero-delta redraw to ordinary updates.
- Do not route per-frame counters through broad UI state in consuming editors.
- Keep hidden or inactive previews paused and release owned renderer resources
  on teardown.
- Do not mask performance defects by lowering fidelity, DPR, diagnostics, or
  authoring affordances by default.

## Verification

- Run the focused unit test first for behavior changes.
- Run `npm run check` for source, boundary, type, build, and package smoke
  validation.
- Run `npm run pack:check` before publishing.
- Run `npm run test:consumers` after changing exports, peers, declarations, or
  package metadata.
- Visual/runtime changes require a real exported project smoke in the owning
  host; headless unit tests alone do not prove rendering parity.

Do not commit `dist`, tarballs, temporary profiling hooks, private project
assets, absolute local paths, or credentials.
