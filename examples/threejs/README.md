# NixieFX + Three.js example

A small, standalone Three.js scene that runs the exported `digit-embers`
effect with the public [`nixie-fx`](https://www.npmjs.com/package/nixie-fx)
runtime. It extracts the real Nixie tube and compiled VFX bundle used on the
NixieFX landing page, while keeping `src/main.ts` direct and game-like.

The export has no Three.js blockers. Its support report is `partial` because the
authored noise module uses the runtime's documented approximation; the demo
surfaces that warning instead of hiding it.

## Run locally

Node.js 20 or newer is required.

```sh
npm install
npm run dev
```

Open the URL printed by Vite. Drag to orbit the tube and scroll to zoom.

Build the production version with:

```sh
npm run build
npm run preview
```

## What the integration does

1. Fetches `public/vfx/manifest.json` and every effect file declared by it.
2. Validates the official export with `loadVfxExportBundle`, requiring the
   `three3d` backend and the `digit-embers` effect.
3. Preloads the declared glow texture and exported placeholder mesh.
4. Mounts `ThreeVfxRenderer` under the tube's digit stack and creates one effect
   instance with a stable seed. Editor-only per-particle debug transform
   capture is disabled because this game-style consumer does not draw debug
   overlays.
5. Replaces the placeholder emission surface with the currently lit digit's
   live geometry. Each digit change emits the effect's authored burst count at
   that digit's exact depth.
6. Calls `vfx.update(deltaSeconds)` exactly once, then
   `renderer.render(scene, camera)` exactly once, per animation frame.
7. Surfaces backend support, particle count, FPS, and runtime diagnostics.
8. Destroys the NixieFX renderer, texture store, controls, scene resources, and
   WebGL renderer when the page is released.

The host application owns the Three.js scene, camera, render loop, URLs, and
cleanup. NixieFX owns only the particle objects it creates.

## Files

- `src/main.ts` — the complete runtime integration and host render loop.
- `src/nixie/` — the website's reusable Three.js tube and studio helpers; no
  landing-page panel, analytics, or editor injection code.
- `public/vfx/` — the unmodified compiled export bundle. Re-export this from the
  NixieFX editor instead of editing generated JSON by hand.

## CodeSandbox

[Open the runnable Three.js example in CodeSandbox](https://codesandbox.io/p/sandbox/y3z3sf).
The sandbox is a standalone snapshot of this folder, including the compiled
`digit-embers` export and its declared assets. A cold first visit can briefly
show CodeSandbox's “Transpiling Modules” screen before the live scene appears.
