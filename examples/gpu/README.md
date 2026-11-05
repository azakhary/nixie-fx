# Exported GPU integration consumer

A minimal implementation check, not a showcase. It loads only normal exported
assets and the public package, with no editor server or source alias.

From the matching runtime/editor delivery checkouts:

```sh
# runtime root
mkdir -p ../.local-packages
npm pack --pack-destination ../.local-packages
# editor root, with that tarball installed as described in its QA guide
node scripts/export-gpu-review.mjs ../nixie-fx/examples/gpu/public
# runtime root
cd examples/gpu
npm install
npm install --no-save --package-lock=false ../../../.local-packages/nixie-fx-0.1.24.tgz
npm run build
npm run dev
```

Open http://127.0.0.1:8087. Select a normal exported effect, pause/restart or
seek 10 seconds. `?effect=gpu-density` selects the density check. Add `&fallback`
to force the renderer's WebGL fallback: GPU profiles block unless the selected
effect explicitly declares a CPU fallback. `authored-fallback` limits that CPU
path to 1,024 slots. Reload after device loss to recreate buffers.

The gray surface receives GPU clustered lights in the hybrid fixture. Camera,
resolution/DPR and material are fixed for comparisons; bloom is absent. Status
shows CPU simulation/render submission time, conservative slot/light counts and
support reasons. GPU execution timing is not measured. Hidden pages stop their
frame loop. The host owns all update/render scheduling and cleanup.

For profiling, warm up at least five seconds, then sample rAF intervals and the
visible status for 30 seconds. Use the same viewport/DPR and effect settings.
Compare `cpu-comparison`, `gpu-comparison`, `gpu-density`; the latter changes only
rate/capacity. Do not describe CPU submission time as GPU execution time. Consult
[`../../docs/gpu-simulation.md`](../../docs/gpu-simulation.md) for the full contract.
