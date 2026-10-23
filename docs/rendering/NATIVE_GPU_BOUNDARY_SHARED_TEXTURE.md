# Native Chromium ↔ GPU shader boundary

Status: architecture research branch based on Phase 3 of PR #19.

Base commit: `22836e64b0b2ff2a2a0d42cac742baf81646af47` (`Record paired bounded-context performance results`).

This branch intentionally stops before PR #19 Phase 4 (`qualified GPU SceneTexture assembly`). It keeps the Phase 1–3 performance work only:

- suspend redundant editor/presenter visual playback during presentation;
- cache GPU resource ownership and program bindings instead of querying stable WebGL objects in the steady-state hot path;
- use two bounded shared shader contexts to reduce drawing-buffer contention without creating one context per shader chain.

The purpose of this branch is to resolve the remaining architecture question before adding another renderer/compositor path.

## Product requirement

ShowMe should have one general rendering model that is both predictable and performant:

- Chromium remains authoritative for ordinary text, DOM, CSS, images, video and native browser paint semantics;
- GLSL Effects can be layered and can consume explicit scene pixels when their `content` / `backdrop` semantics require it;
- performance-sensitive layered effects should be capable of sustained near-60 Hz presentation on representative hardware;
- the solution must not grow a second renderer that gradually reimplements Chromium paint, transforms, clipping, groups, video and CSS case by case.

The current problem is not ordinary DOM rendering. It is the boundary between Chromium's composited output and ShowMe's GPU shader pipeline.

## The actual boundary problem

For ordinary content the ownership is simple:

```text
ShowMe semantic scene
        ↓
DOM / CSS / media
        ↓
Chromium renderer + compositor
        ↓
visible pixels
```

For generated or directly chained shaders the ownership is also simple:

```text
ShowMe Effect
        ↓
WebGL shader / retained GPU texture
        ↓
next shader or visible bitmap
```

The difficult case is a shader whose authored input means "the exact pixels already painted below/inside this element":

```text
Chromium-rendered scene prefix
        ↓
??? native/GPU boundary ???
        ↓
GLSL sampler2D input
        ↓
shader output
```

A normal WebGL context in the renderer cannot directly sample Chromium's already-composited DOM framebuffer as a texture. The browser owns that compositor surface; ShowMe owns the WebGL shader contexts. There is no ordinary DOM/WebGL API that exposes an arbitrary Chromium paint prefix as a directly sampleable WebGL texture.

That leaves three broad strategies.

### 1. Capture Chromium pixels

This is the current `SceneTexture` fallback model. Chromium paints the scene correctly, then ShowMe captures/rasterizes the required input and uploads it for the shader.

Advantages:

- general and semantically correct;
- Chromium remains the sole implementation of CSS/text/media paint;
- handles arbitrary content without duplicating browser semantics.

Problem:

- for continuously changing inputs the capture path crosses paint/capture/upload synchronization boundaries;
- the real Radeon 880M reference workload showed glass publishing at approximately half audience cadence;
- fixing capture starvation restored correctness but did not make the dynamic capture path fast enough for the desired 60 Hz layered-effect workload.

### 2. Reconstruct the scene prefix on the GPU

PR #19 Phase 4 proved that a narrowly qualified reconstruction can be fast. It retained/captured static native pieces, imported the animated shader result, assembled them in an FBO and fed that texture to the glass shader. On the reference workload this reached approximately 60 audience callbacks/sec and 60 glass publications/sec.

The performance result is useful evidence, but this branch intentionally does not contain that implementation.

The architecture problem is that this path must understand enough scene semantics to reproduce Chromium's result. Extending it from the reference case to Motion, transforms, video, nested groups, arbitrary CSS, clipping, alpha and additional effect stacks would gradually create a second compositor. That is the same architecture we deliberately removed in PR #18, only hidden behind the `SceneTexture` API.

Therefore "add more qualification cases to GPU SceneTexture" is not the default next step.

### 3. Obtain Chromium's composited output as a GPU resource

This is the next experiment.

The goal is to keep Chromium authoritative while avoiding the CPU/raster/upload path:

```text
DOM / CSS / media
        ↓
Chromium compositor
        ↓
GPU shared texture
        ↓
ShowMe shader input
```

If this boundary can be made practical, it is conceptually different from Phase 4. ShowMe would not reconstruct Chromium's scene. It would consume Chromium's own GPU output.

## Electron offscreen GPU shared-texture capability

Electron exposes offscreen rendering for a `BrowserWindow`. With:

```js
webPreferences: {
  offscreen: {
    useSharedTexture: true
  }
}
```

Chromium performs GPU-accelerated offscreen composition and the `paint` event can expose an `OffscreenSharedTexture` instead of requiring a CPU bitmap path.

Electron documents this mode as intended for high-performance rendering: the result remains a GPU texture and can be imported into another rendering pipeline without a CPU↔GPU memory round-trip.

Relevant current APIs/concepts:

- `BrowserWindow.webPreferences.offscreen.useSharedTexture`
- `offscreen.deviceScaleFactor`
- `offscreen.sharedTexturePixelFormat`
- `webContents.setFrameRate(...)`
- `paint` event `event.texture`
- `OffscreenSharedTexture.textureInfo`
- `OffscreenSharedTexture.release()`
- `sharedTexture.importSharedTexture(...)`
- `sharedTexture.sendSharedTexture(...)`
- `sharedTexture.setSharedTextureReceiver(...)`
- `SharedTextureImported.getVideoFrame()`

Important lifecycle constraint: only a limited number of shared textures may exist simultaneously. Every received OSR texture must be released as soon as its consumers are finished. The source texture cannot be released while an imported/forwarded consumer still depends on it.

On Windows the shared handle is an NT handle for the D3D texture; macOS uses IOSurface; Linux uses native pixmap/dmabuf-style plane handles. The experiment must not hard-code a Windows-only architecture even if Windows/Radeon is the first performance target.

The existing ShowMe Electron line (44.4.x in the measured work) already contains the offscreen/shared-texture functionality needed to prototype this. Electron 44 also contains fixes for shared-texture object lifetime and offscreen device-scale-factor capture behavior, so the experiment should use the actual project Electron version rather than an old standalone example.

## Critical distinction: full frame vs arbitrary paint prefix

Offscreen shared rendering does **not** automatically solve every SceneTexture request.

Electron OSR exposes the compositor result of a `BrowserWindow`/webContents frame. A shader's `backdrop` input may require the scene at an intermediate paint point rather than the final complete slide.

The experiment therefore has two separate questions:

1. **Transport question:** Can ShowMe receive Chromium-composited pixels as a GPU-backed resource and feed them into its shader pipeline at 60 Hz without the current CPU/capture/upload cost?
2. **Semantic question:** Can the browser-native slide be arranged so the required shader input corresponds to a practical Chromium output surface without creating one BrowserWindow/webContents per effect or recreating scene composition in ShowMe?

Do not claim success by solving only the first question.

A full-slide final-frame texture is useful for post-processing, but it cannot by itself represent arbitrary intermediate backdrop inputs without feedback/recursion. Likewise, creating a separate offscreen renderer for every effect boundary would likely duplicate Chromium work and destroy the performance/complexity advantage.

## Next experiment: offscreen Chromium → shared GPU texture → shader

This must begin as an isolated prototype, not as a production renderer rewrite.

### Experiment A — prove the transport

Create one minimal offscreen `BrowserWindow`/webContents that renders a representative native scene:

- shader or animated canvas background;
- native text;
- CSS styling that proves Chromium is actually doing the paint;
- optional image/video follow-up after the static case works.

Configure GPU offscreen rendering with `useSharedTexture: true`, output at the same logical size/DPR used by the reference audience workload, and request 60 Hz.

Receive the shared texture from the `paint` event and establish the smallest viable path into a shader consumer.

Preferred order to investigate:

1. Electron shared-texture transfer/import APIs, producing a `VideoFrame` in the consumer renderer;
2. WebGPU `importExternalTexture({ source: videoFrame })` if supported reliably in the Electron/Chromium version;
3. WebGL `texImage2D(VideoFrame)` only as a comparison, because DOM/video texture uploads can still introduce driver-side processing/pipeline flushes and should not be assumed zero-copy;
4. a native Node/D3D/ANGLE import only if the built-in Electron shared-texture path cannot preserve the required GPU residency/performance.

The experiment must measure whether the actual consumer path remains GPU-resident. Do not infer zero-copy merely because the source is a shared texture.

### Experiment B — compare against current SceneTexture capture

The ideal controlled comparison uses the same native scene and shader, same resolution/DPR and same production Electron environment. The current branch does **not** yet have pixel/workload-equivalent scenes on both sides, so its legacy runner is only a broad cadence reference. CPU/process cost from the two current fixtures must not be presented as an apples-to-apples transport speedup until the scenes are made materially equivalent.

Measure at minimum:

- Chromium offscreen frame publications/sec;
- shader publications/sec;
- audience/consumer rAF rate;
- frame interval p50/p95/max;
- dropped/gapped frame counts from texture metadata when available;
- CPU task time by involved process;
- number of outstanding shared textures;
- texture lifetime/release latency;
- GPU/context loss behavior;
- memory growth over a longer run.

Compare against the Phase 3 SceneTexture capture path and the existing reference measurements. Hardware measurements are decisive; headless SwiftShader is secondary.

### Experiment C — determine semantic viability

Only after transport performance is proven, investigate whether native Chromium surfaces can map cleanly to ShowMe's actual effect semantics.

Test these progressively:

1. full-slide post-process shader;
2. one background/native-content/backdrop boundary;
3. two shader boundaries in a single slide;
4. Motion and video inside the native scene;
5. nested groups/custom CSS only to determine whether Chromium output remains authoritative—not to rebuild them in a custom compositor.

For each case record how many Chromium render surfaces/webContents are required.

The experiment fails architecturally if general layered effects require a separate Chromium renderer for every paint prefix or require ShowMe to reconstruct arbitrary native paint order on the GPU.

## Acceptance criteria

The shared-texture direction is promising only if all of the following are true:

1. Chromium remains authoritative for native pixels.
2. The shader consumes Chromium output without CPU pixel readback.
3. The reference native-content → shader case can sustain approximately 60 shader updates/sec on the Radeon 880M at the original output resolution.
4. Texture lifetime is bounded and stable over sustained playback.
5. Context loss/window teardown does not leak or deadlock shared resources.
6. A realistic ShowMe composition does not require unbounded BrowserWindows/webContents or one Chromium surface per effect instance.
7. The design can preserve authored paint ordering rather than only support a final full-slide post-process.

If these criteria are not achievable, record the result clearly. At that point we must make an explicit product architecture choice between:

- browser-native correctness with a performance ceiling for arbitrary scene-sampling GLSL; or
- a deliberate general GPU compositor with a defined supported scene model.

Do not return to an accumulating collection of narrow GPU reconstruction cases without making that decision.

## Non-goals for this branch

- Do not reintroduce PR #19 Phase 4 GPU SceneTexture assembly.
- Do not expand `SceneTexture` qualification case by case.
- Do not redesign document/persistence formats.
- Do not replace Chromium text/CSS/media rendering.
- Do not merge to `main` from this research branch.
- Do not promise universal 60 FPS from an isolated transport prototype.

## References

Electron documentation consulted for this experiment:

- https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
- https://www.electronjs.org/docs/latest/api/web-contents
- https://www.electronjs.org/docs/latest/api/structures/offscreen-shared-texture
- https://www.electronjs.org/docs/latest/api/shared-texture
- https://www.electronjs.org/docs/latest/api/structures/shared-texture-imported
- https://github.com/electron/electron/blob/v45.0.0/shell/common/api/shared_texture/README.md

Supporting Web platform references for the consumer-side experiment:

- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/importExternalTexture
- https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/texImage2D

The APIs above are experimental in Electron. Validate against the exact Electron version in `package.json` before production adoption and retain a clear fallback until the experiment establishes cross-platform viability.


## Implemented experiment on this branch

Implementation date: 2026-10-23.

The branch now contains an isolated harness under `experiments/native-gpu-shared-texture/`. It does not change `SlideRenderer`, `effectRuntime`, `SceneTexture`, persistence, presentation window creation or any normal product rendering path.

The repository lockfile resolves Electron **44.4.1**. No Electron upgrade was required for this prototype.

### Electron 44.4.1 API surface verified

The experiment was checked against Electron 44.4.1's documented/type-level API and the v44.4.1 shared-texture spec. The required managed path exists in this version:

- `webPreferences.offscreen = { useSharedTexture: true, sharedTexturePixelFormat, deviceScaleFactor }`;
- `webContents.setFrameRate(...)`;
- offscreen `paint` events with `event.texture: OffscreenSharedTexture`;
- `OffscreenSharedTexture.textureInfo` with coded size, pixel format, timestamp, optional frame-count metadata and a platform shared-texture handle;
- explicit `OffscreenSharedTexture.release()`;
- main-process `sharedTexture.importSharedTexture({ textureInfo, allReferencesReleased })`;
- main-process `sharedTexture.sendSharedTexture({ frame, importedSharedTexture }, ...args)`;
- renderer-side `sharedTexture.setSharedTextureReceiver(...)`;
- `SharedTextureImported.getVideoFrame()` plus explicit `release()`.

Electron's own managed API test uses the same ownership pattern as this harness: import the OSR texture, transfer a reference to the target renderer, release the main-process imported reference, and release the original OSR texture only from `allReferencesReleased`.

Platform handle semantics remain Electron/Chromium-owned:

- Windows: an NT handle for the shared D3D texture;
- macOS: IOSurface;
- Linux: native-pixmap/dmabuf-style plane handles.

The prototype only records the handle kind reported at runtime. It does not open, duplicate or interpret native handles itself.

Two caveats are material:

1. Electron's v44.4.1 shared-texture spec is gated to macOS arm64. The existence of the API is therefore proven, but the repository still needs local Windows/Radeon validation.
2. A current Electron 44 Linux/Vulkan issue reports GPU-process crashes when importing OSR shared textures. That is not evidence about the Windows D3D11 target, but it is a cross-platform warning against treating this experimental API as production-ready without platform testing.

### Experimental transport

The implemented primary path is:

```text
offscreen BrowserWindow/webContents
  Chromium compositor
  animated WebGL background + native DOM/text/CSS
        ↓ paint event
OffscreenSharedTexture
        ↓ importSharedTexture
SharedTextureImported in main
        ↓ sendSharedTexture
SharedTextureImported in consumer renderer
        ↓ getVideoFrame()
VideoFrame
        ↓ device.importExternalTexture()
WebGPU texture_external
        ↓ cheap WGSL color transform
visible consumer canvas
```

A separate comparison backend uses:

```text
VideoFrame
        ↓ WebGL texImage2D(VideoFrame)
WebGL texture
        ↓ same cheap color transform
visible canvas
```

The WebGL path is intentionally labelled `webgl-videoframe-upload`. JavaScript accepting a `VideoFrame` is not evidence of zero-copy transport.

For WebGPU, the harness calls `device.importExternalTexture({ source: frame })`. The Web platform allows this to remain external/GPU-backed, but the implementation is allowed to perform internal conversion or copying. Therefore the prototype records **no zero-copy claim**. Hardware measurements, GPU traces or equivalent platform evidence are still required.

### Source scene

The offscreen source is not an empty canvas. It combines:

- a continuously animated WebGL background;
- native Chromium text;
- native CSS grid styling;
- rounded geometry;
- opacity;
- shadows;
- independent CSS animation.

This is sufficient to establish that the shared texture represents Chromium composition rather than only a ShowMe-generated texture.

The requested workload defaults are:

- 1596 × 998 CSS pixels;
- DPR 1.6042;
- 60 Hz requested OSR frame rate.

All are command-line configurable.

### Resource ownership and backpressure

The transport has an explicit bounded latest-frame policy.

Default limit:

- at most 2 textures actively transferred/consumed;
- at most 1 pending texture;
- maximum retained source textures therefore 3.

If a newer source texture arrives while both active slots are occupied, it replaces the pending texture and the stale pending texture is immediately released. There is no FIFO backlog.

For an active texture:

1. the OSR `OffscreenSharedTexture` remains owned by the main-process frame record;
2. `sharedTexture.importSharedTexture` establishes the imported reference;
3. `sendSharedTexture` transfers a managed reference to the target renderer;
4. the main imported reference is released;
5. the consumer obtains a `VideoFrame`, releases its imported wrapper, submits the shader work, then closes the `VideoFrame`;
6. `allReferencesReleased` releases the original OSR texture only after Electron reports that all imported references are done.

On shutdown the source first calls `stopPainting()`, the pending frame is released, and active references are allowed to drain. A bounded drain timeout fails the experiment rather than silently abandoning retained textures.

The queue policy has a standalone self-test. It verifies latest-frame replacement, bounded retention, release after close and complete draining.

### Instrumentation

Cadence measurement now uses one explicit epoch-based window shared between the main process and consumer renderer. After source load, the pipeline warms up for 1500 ms by default. Main then publishes a future start/end epoch to the consumer. Source paint events, consumer arrivals, shader publications, rAF samples and per-frame submit costs are reset/countable only inside that window. At the end epoch, timed process metrics are sampled and painting is stopped; shared-texture references drain afterward. Drain time is therefore excluded from the cadence denominator. The warmup is configurable with `--warmup`.

The shared-texture harness records:

- OSR paint events/sec;
- OSR paint interval p50/p95/max;
- optional `textureInfo.metadata.frameCount` gaps;
- coded texture dimensions;
- pixel formats;
- platform handle kind;
- consumer shared-texture arrivals/sec;
- shader publications/sec;
- consumer `requestAnimationFrame` callbacks/sec;
- arrival/publication/rAF interval p50/p95/max;
- WebGPU/WebGL submission cost;
- WebGPU queue-completion wait time;
- source-release latency;
- skipped stale source textures;
- active/pending/max-retained texture counts;
- release and transfer errors;
- consumer render errors;
- WebGPU/WebGL context loss;
- renderer memory snapshots;
- Electron process CPU/memory metrics;
- Electron GPU feature status/basic GPU information.

Optional evidence capture saves the final transformed consumer image after the timed region. It is evidence that the Chromium scene was sampled by the shader, not a frame-rate measurement.

The experiment deliberately does not claim physical-display 60 FPS from application callbacks.

### Cadence reference with current SceneTexture

`legacy-scene-texture.mjs` builds a broad reference through the **current production ShowMe renderer**:

```text
generated ShowMe GPU shader
        ↓
native ShowMe text/CSS via SlideRenderer
        ↓
current backdrop SceneTexture boundary
        ↓
same cheap final color shader
```

It imports the existing `mountMixedEffectsHarness`, `SlideRenderer` path, `effectRuntime`, `sceneTextureDiagnostics` and shader diagnostics. The experiment does not modify the current SceneTexture implementation.

The runner holds constant:

- logical width;
- logical height;
- requested DPR;
- warmup;
- timed duration;
- the final shader transform;
- the same Electron installation/hardware used for the two sequential runs.

The source scenes are **not equivalent**. The shared-texture scene contains extra animated native CSS/decorative content that the legacy fixture does not reproduce. That makes the current shared source at least more demanding in some respects, but it also means CPU/process deltas are not a valid transport-speedup comparison. The report labels itself `cadence-reference-not-apples-to-apples` and explicitly marks CPU cost as not directly comparable.

The comparison report fails its validation checks if the requested size/DPR are not actually realized, if the legacy renderer reports effect errors, or if the shared-texture lifetime is not fully drained and bounded.

### Commands

Lightweight lifetime-policy check:

```bash
npm run test:shared-texture-policy
```

Interactive WebGPU transport:

```bash
npm run experiment:shared-texture -- --show --backend=webgpu --duration=15000 --verbose
```

Primary benchmark:

```bash
npm run benchmark:shared-texture -- \
  --backend=webgpu \
  --width=1596 --height=998 --dpr=1.6042 --fps=60 \
  --duration=30000 \
  --output=.benchmark-data/shared-texture/webgpu.json \
  --evidence=.benchmark-data/shared-texture/webgpu.png
```

WebGL VideoFrame comparison:

```bash
npm run benchmark:shared-texture -- \
  --backend=webgl \
  --width=1596 --height=998 --dpr=1.6042 --fps=60 \
  --duration=30000 \
  --output=.benchmark-data/shared-texture/webgl.json
```

Current-SceneTexture cadence reference vs shared-texture run:

```bash
npm run benchmark:shared-texture:compare -- \
  --width=1596 --height=998 --dpr=1.6042 \
  --duration=30000 --warmup=1500 \
  --output=.benchmark-data/shared-texture/comparison.json \
  --evidence-dir=.benchmark-data/shared-texture/evidence
```

For leak/lifetime testing, repeat the primary benchmark for several minutes and inspect both the retained-texture counters and process memory trend.

### Security isolation

The consumer window enables Node integration so the experiment renderer can directly access Electron's renderer-side `sharedTexture` API and report metrics over IPC. It loads only local files under the experiment directory. This is an experiment-only shortcut, not an acceptable production window configuration.

## Results status: facts, measurements and open questions

### Proven by repository/API inspection and implemented code

- Electron 44.4.1 exposes a managed OSR shared-texture → renderer `VideoFrame` path.
- The source can be Chromium-composited DOM/CSS/WebGL content.
- The harness does not request CPU pixel readback on the primary transport path.
- Resource ownership can be expressed with a bounded queue and Electron's reference-release callback.
- A `VideoFrame` can be presented to WebGPU through `importExternalTexture` in the implemented consumer path when WebGPU is available.
- The current SceneTexture baseline can be exercised separately without reintroducing Phase 4 or changing production rendering.

### Not measured in this ChatGPT pass

No Radeon 880M hardware benchmark was run here. Therefore there are currently **no new measured claims** for:

- Windows paint events/sec;
- shared-texture arrivals/sec;
- shader publications/sec;
- p95 frame interval;
- WebGPU vs WebGL transport cost;
- sustained memory behavior;
- actual zero-copy behavior;
- physical-display FPS.

Those values must come from the local Codex pass.

### Question A: transport status

**Promising enough to measure, not yet proven performant.**

Electron 44.4.1 exposes the needed GPU-backed OSR source and a managed import/transfer/`VideoFrame` path. The architecture can therefore test the desired boundary without starting with a native addon.

What remains unknown is whether the complete Windows Radeon 880M path, including OSR production, Electron transfer, `VideoFrame`, WebGPU external-texture import and shader publication, actually sustains approximately 58–60 Hz at the target resolution without hidden GPU→CPU→GPU work.

A successful local result requires the transport itself to meet the cadence target. Fast OSR source publication with a slower consumer is not a success.

### Question B: scene semantics status

**Still unresolved and potentially the architecture blocker.**

Case 1, native Chromium slide → final full-slide shader:

- naturally maps to one offscreen Chromium compositor result;
- this is the easiest useful class.

Case 2, generated background → native text → backdrop/glass shader:

- the shader requires the Chromium scene **before** the glass shader is applied;
- an OSR frame of a webContents that already includes the glass output is too late and creates a feedback problem;
- one separate Chromium surface that intentionally represents the required prefix could provide the right pixels, but the cost/ownership model must be evaluated.

Case 3, native layer → shader → more native content → second shader:

- there are two distinct Chromium paint prefixes;
- one final OSR frame cannot represent both;
- if each prefix requires its own duplicated BrowserWindow/webContents or separately rendered slide tree, this direction fails the stated architecture criteria.

Case 4, Motion, video, nested groups and arbitrary CSS:

- Chromium can remain authoritative for these features **inside any one Chromium surface**;
- the unresolved issue is how many such surfaces are required to expose the authored intermediate shader boundaries;
- this experiment must not solve that by recreating those native features in ShowMe GPU code.

Therefore a fast full-frame result is not sufficient to declare the ShowMe rendering architecture solved.

## Local verification decision points

On the Radeon 880M / D3D11 machine, local Codex should verify in this order:

1. Run the queue self-test and syntax/type/build checks.
2. Run the WebGPU shared-texture benchmark at 1596 × 998, DPR 1.6042, 60 Hz for 30 seconds.
3. Confirm the result actually reports the expected coded texture dimensions, GPU adapter/status and a Windows NT shared handle.
4. Confirm `paintEventsPerSec`, consumer arrivals and shader publications are all approximately 58–60/sec, not merely rAF.
5. Inspect p95/max intervals and metadata frame-count gaps.
6. Confirm `maxRetained <= maxActive + 1`, final retained count is zero, no release/transfer/render errors occur and teardown drains before timeout.
7. Repeat with the WebGL backend to expose any meaningful difference between external-texture sampling and `texImage2D(VideoFrame)`.
8. Run the SceneTexture cadence reference and compare publication cadence only. Do not interpret current CPU/process deltas as an apples-to-apples speedup unless the fixtures are first made materially equivalent.
9. Run a multi-minute WebGPU test and inspect memory and retained-texture stability.
10. Only if transport succeeds, prototype the smallest possible single intermediate-prefix case. Count Chromium surfaces explicitly. Stop if the model requires one duplicated webContents per effect boundary.

The transport experiment should be considered negative if it needs lower resolution, persistent CPU readback/upload, unbounded retained textures, or cannot sustain the target cadence. The architecture experiment should be considered negative even with fast transport if realistic layered ShowMe semantics require duplicated Chromium renderers per effect boundary.

## Updated exact-version references

- Electron v44.4.1 shared-texture spec: https://github.com/electron/electron/blob/v44.4.1/spec/api-shared-texture-spec.ts
- Electron v44.4.1 offscreen tutorial: https://github.com/electron/electron/blob/v44.4.1/docs/tutorial/offscreen-rendering.md
- Electron shared-texture design notes: https://github.com/electron/electron/blob/v44.4.1/shell/common/api/shared_texture/README.md
- Electron `OffscreenSharedTexture` structure: https://github.com/electron/electron/blob/v44.4.1/docs/api/structures/offscreen-shared-texture.md
- Electron `SharedTextureImported` structure: https://github.com/electron/electron/blob/v44.4.1/docs/api/structures/shared-texture-imported.md
