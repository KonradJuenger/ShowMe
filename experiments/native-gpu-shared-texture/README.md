# Native GPU shared-texture boundary experiment

This folder is an isolated architecture experiment. It does not participate in normal ShowMe rendering and must not be treated as a SceneTexture backend.

## What it tests

The source window is an Electron offscreen `BrowserWindow` configured with `offscreen.useSharedTexture = true`. It renders a representative layered Chromium scene: an animated WebGL background followed by native DOM text/CSS with rounded geometry, opacity and shadow.

The main process imports each `OffscreenSharedTexture`, transfers it to a second renderer with Electron's managed `sharedTexture` API, obtains a `VideoFrame` there, then runs one deliberately cheap shader:

- `webgpu`: `VideoFrame -> GPUDevice.importExternalTexture -> WGSL -> visible canvas`
- `webgl`: `VideoFrame -> texImage2D -> GLSL -> visible canvas`

The WebGPU path is the primary experiment. The WebGL path is only a comparison and must not be described as zero-copy without measurement. After a WebGPU submission the consumer closes its `VideoFrame`; Electron's shared-texture lifetime machinery keeps the underlying GPU resource alive until GPU use completes. `GPUQueue.onSubmittedWorkDone()` is sampled periodically for diagnostics only and is not awaited in the per-frame hot path.

The source-frame queue is bounded: at most two transferred frames are active by default and at most one pending frame is retained. If a newer frame arrives while the pending slot is occupied, the older pending texture is released immediately. The pending frame is therefore "latest frame wins" and retained shared textures cannot grow without bound.

## Commands

No ShowMe production-path change is required to launch the transport harness because it is plain Electron/JavaScript code.

Run the lifetime policy self-check:

```text
npm run test:shared-texture-policy
```

Interactive WebGPU run:

```text
npm run experiment:shared-texture -- --show --backend=webgpu --duration=15000 --verbose
```

Primary hardware benchmark at the Radeon reference workload:

```text
npm run benchmark:shared-texture -- --backend=webgpu --width=1596 --height=998 --dpr=1.6042 --fps=60 --duration=30000 --output=.benchmark-data/shared-texture/webgpu.json --evidence=.benchmark-data/shared-texture/webgpu.png
```

WebGL comparison:

```text
npm run benchmark:shared-texture -- --backend=webgl --width=1596 --height=998 --dpr=1.6042 --fps=60 --duration=30000 --output=.benchmark-data/shared-texture/webgl.json
```

Controlled approximate-scene comparison against the current `SceneTexture` implementation:

```text
npm run benchmark:shared-texture:compare -- --width=1596 --height=998 --dpr=1.6042 --duration=30000 --output=.benchmark-data/shared-texture/comparison.json --evidence-dir=.benchmark-data/shared-texture/evidence
```

The legacy side uses the real ShowMe `SlideRenderer`, effect runtime and current `SceneTexture` implementation through the existing Vite/Electron harness. Both sides use the same logical dimensions, DPR, duration and the same cheap invert/channel final shader. Both scenes are structurally equivalent (`generated GPU background -> native text/CSS -> final shader`) but intentionally not pixel-identical. The comparison report says this explicitly.

For historical reference-deck measurements, the existing production benchmark remains available separately:

```text
npm run build
npm run benchmark:animation -- <path-to-shader-text-shader.sme>
```

Do not mix historical deck results into the controlled experiment report as if they were the same fixture.

## Output

The shared benchmark prints one `SHARED_TEXTURE_BENCHMARK {...}` JSON line and optionally writes the same report to `--output`.

Important fields:

- source paint events/sec and paint interval p50/p95/max;
- source `metadata.frameCount` gaps;
- actual shared texture format and coded size;
- platform handle kind seen by Electron;
- bounded queue counts and maximum retained textures;
- source texture release latency and drain timeout status;
- consumer arrivals/sec, shader publications/sec and rAF callbacks/sec;
- consumer interval p50/p95/max;
- WebGPU/WebGL submit-call duration and WebGPU completion wait;
- renderer/context loss count;
- initial/final Electron process metrics and cumulative CPU deltas;
- GPU feature/basic information;
- optional post-timing evidence PNG.

`shaderPublicationsPerSec` means application-level shader submissions that reached the consumer path, not measured physical-display FPS.

## Success signal

On the Radeon 880M reference machine at 1596 x 998 CSS pixels and DPR 1.6042, the transport is interesting if the WebGPU path sustains approximately 58-60 source texture updates/sec and 58-60 shader publications/sec with stable bounded lifetime, no context loss and no retained queue at shutdown.

That result answers only the transport question. The OSR texture represents the completed compositor frame of one `webContents`. It does not by itself represent an arbitrary ShowMe backdrop paint prefix.