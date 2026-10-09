# Exported WebGPU comparison consumer

This is a standalone Vite/Three app using normal `nixie-fx` package exports. It
loads a normal exported manifest, effects, material graphs, textures and geometry;
it has no editor imports. The scene file is an exported authoring asset.

From the runtime repository on `codex/2215-webgpu-materials`:

```sh
npm ci
mkdir -p ../.local-packages
npm pack --pack-destination ../.local-packages
cd examples/webgpu
npm install
npm install --no-save --package-lock=false ../../../.local-packages/nixie-fx-0.1.20.tgz
npm run dev
```

Open `http://127.0.0.1:8085/`. Choose WebGPU or **Three WebGL2 fallback (forced)**.
The active backend is explicit. Use **Checkpoint 1.5s** (seed 1234) for a paused
comparison; switch implementations without losing time/camera. The camera uses
orthographic view height 12, target `(0,.85,0)`, yaw 0, pitch -.82. OrbitControls
permits camera review. Choose 1/3 instances and budgets 0/2/4 to verify the shared
light pool never changes the host-owned directional/ambient lights.

Bloom, Tint, pause/play, seek and restart are live controls. The Tint control edits
the graph's tint node snapshot in memory; reloading returns the shipped fixture.
Choose **Scene lighting graph inputs** for the lighting-read probe. Choose
**Unsupported · explicit diagnostic** on a node backend for an emitter/material/
node error. Fix or choose a supported effect; this fixture's deferred feed is not
an appearance reference on legacy WebGL either.

Under **Recovery demonstrations (injected)**, initialization failure and loss
notification exercise error/stop/retry/fallback behavior. They are explicitly
injected, not evidence of a real GPU/driver loss. Rapid backend choices cancel
stale startup; inactive documents stop their host rAF. GPU helper initialization
also stops Three's private bookkeeping heartbeat.

After ten seconds warmup, **Measure 30 seconds** records every frame interval,
CPU simulation/preparation/selection, CPU render submission and total work. The
consumer's editor cost is zero. Repeat budget 4, three instances, bloom on, then
repeat after a multi-minute thermal soak. Record device model/GPU, OS/browser,
DPR/viewport, frame lows and spikes, light radius/overlap and material settings.
The desktop results supplied with this example fail the 120Hz gate; they are not
a shipping performance budget.

For physical phones, WebGPU needs a secure origin. Use a trusted HTTPS development
host/tunnel you already control and serve this app with HTTPS. Plain LAN HTTP is
not equivalent to localhost and may only exercise fallback; do not bypass browser
certificate warnings. Record actual backend, including unsupported browser/device
results. No physical iOS or Android device was available in this session.

Regenerate from the editor's editable fixture using its
`scripts/export-webgpu-review.mjs <this-example>/public` command after saving.
See [runtime matrix](../../docs/webgpu.md) and `public/results.json`. The human
reviewer records and attaches video; this app does not capture it.
