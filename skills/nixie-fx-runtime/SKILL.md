---
name: nixie-fx-runtime
description: Integrate compiled NixieFX particle effects into PixiJS or Three.js applications using the public nixie-fx package. Use when an agent needs to install the runtime, load an out/vfx export bundle, implement texture or material providers, mount a renderer, drive effects from a game loop, inspect runtime diagnostics, or clean up NixieFX resources.
---

# NixieFX Runtime

Integrate the generated `out/vfx` artifact. Do not load authoring project files directly in a game.

## Workflow

1. Identify the host renderer, its render loop, asset pipeline, camera or projection, and cleanup lifecycle.
2. Install only the selected optional peer:

   ```sh
   npm install nixie-fx pixi.js
   # or
   npm install nixie-fx three
   ```

3. Read [export-bundles.md](references/export-bundles.md) and load the complete compiled bundle through `nixie-fx/export`.
4. Read exactly one backend guide unless the task requires both:
   - PixiJS: [pixi.md](references/pixi.md)
   - Three.js: [three.md](references/three.md)
5. Resolve textures, material graphs, meshes, and sub-effects through injected providers owned by the host application.
6. Create the renderer and effect instance, then update the renderer exactly once per host frame.
7. Surface manifest support reports and runtime missing-resource statistics. Do not silently treat partial or missing behavior as complete.
8. Destroy instances, renderer-owned objects, and provider resources when their host scope ends.

## Package boundaries

Use only public entrypoints:

- `nixie-fx` for backend-neutral contracts and support data.
- `nixie-fx/pixi` for PixiJS integration.
- `nixie-fx/three` for Three.js integration.
- `nixie-fx/materials` for material graph contracts.
- `nixie-fx/export` for browser-safe export schemas and loading.
- `nixie-fx/export/node` only for Node filesystem export tooling.

Never deep-import `nixie-fx/src/**`, copy runtime source into the consumer, or import the unused renderer backend.

## Runtime rules

- Let the game own its application, scene, camera, clock, URLs, caches, and error reporting.
- Preload asynchronous assets before spawning an effect; provider getters used during rendering must be synchronous.
- Call `renderer.update(deltaSeconds)` once. Do not also call `instance.update(deltaSeconds)` in the same frame.
- Treat authored paths as bundle-relative lookup keys. Map them to URLs or atlas frames in the host provider.
- Use stable seeds when deterministic playback matters.
- Pause or destroy inactive runtimes; hidden scenes must not keep ticking.
- Do not claim editor parity until the real exported effect has been observed in the target renderer.

## Completion checks

- Importing the selected backend succeeds without installing the other peer.
- The loader accepts the manifest, required effect IDs, and selected backend.
- No manifest entry is blocked for the selected backend.
- Textures, material graphs, meshes, and sub-effects resolve without missing-reference statistics.
- Simulation advances once per frame and stops after teardown.
- The effect is visually checked in the real host application.
