# Native Chromium ↔ GPU shader boundary

Status: architecture research branch based on Phase 3 of PR #19.

Local audit completed 2026-10-24: **TRANSPORT SUCCESS / GENERAL LAYERED ARCHITECTURE FAILURE**.
The [local audit below](#local-codex-audit--2026-10-24) supersedes the earlier unmeasured status notes.

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

## Local Codex audit — 2026-10-24

### Implementation audited

Audited all 32 commits and all 14 changed files after Phase 3
`22836e64b0b2ff2a2a0d42cac742baf81646af47`, through research branch HEAD
`72719c6ae0eb807ddc2def99cfc8f6f9c410d25f`. The initial checkout was clean on
`performance/native-presentation-workload` at `78971ae`; the requested research
branch was fetched and checked out. No merge, push, remote CI or main modification.
Main remained `a699fbdd3af0e3ff8ab940db53379a8e4aeb1dfc`.

Changes are isolated to the experiment directory, package scripts and these two
research documents. No production SlideRenderer, SceneTexture, effect semantics,
document authority, persistence or editor code changed. There is no Phase 4 GPU
scene reconstruction, DOM interpretation, manual text/group/clip composition or
scene-qualification backend. The generated background is ordinary authored canvas
content; Chromium composes it with native text, CSS animation, transforms, rounded
corners, translucent layers and shadows.

Installed and runtime Electron are **44.4.1**, Chromium **152.0.7977.78**;
host Node **26.3.0**, npm **11.16.0**. Local `electron.d.ts`, actual successful
runtime calls, and Electron's exact-version managed API and C++ implementation
agree on this pipeline:

```text
source renderer DOM/CSS/WebGL
→ Chromium GPU compositor / offscreen capture surface
→ main-process paint event: OffscreenSharedTexture, BGRA Windows NT handle
→ main sharedTexture.importSharedTexture(textureInfo)
→ main sharedTexture.sendSharedTexture(consumer mainFrame)
→ consumer SharedTextureImported.getVideoFrame()
→ WebGPU importExternalTexture → WGSL draw → consumer canvas
```

The alternate consumer is `VideoFrame → WebGL2 texImage2D → GLSL draw → canvas`.
The source and final shader are identical between these two transport runs.

| Boundary | Ownership/release | Copy evidence |
| --- | --- | --- |
| Chromium GPU output → main OSR event | Main retains OSR lease until consumers finish; stale pending leases release immediately | Shared GPU handle; OSR compositor/export may copy GPU pixels internally; no CPU bitmap requested |
| Main import | Electron duplicates the Windows NT handle and creates a SharedImage; main wrapper released after transfer acknowledgment | Handle/metadata duplication is not a pixel-buffer copy |
| Main → consumer renderer | Managed SharedImage export/import and sync tokens; consumer wrapper explicitly released | IPC serializes resource metadata, not an RGBA bitmap |
| Imported wrapper → VideoFrame | Frame retains the SharedImage after wrapper release; frame closed after submit | Exact-version C++ uses `VideoFrame::WrapSharedImage`, not CPU frame allocation |
| VideoFrame → WebGPU → output | External texture sampled; Electron/Chromium sync-token machinery retains GPU dependencies until completion | GPU-backed input established; internal Dawn/driver conversion/copy not excluded; shader writes a separate output |
| VideoFrame → WebGL → output | Separate WebGL texture populated, frame closed after submit | Texture materialization/upload API is explicit; GPU copy/conversion implementation not measured |

Reference inspection: [native import/frame implementation](https://github.com/electron/electron/blob/v44.4.1/shell/common/api/electron_api_shared_texture.cc),
[main managed lifetime](https://github.com/electron/electron/blob/v44.4.1/lib/browser/api/shared-texture.ts),
[renderer managed lifetime](https://github.com/electron/electron/blob/v44.4.1/lib/renderer/api/shared-texture.ts).
The harness has no per-frame `readPixels`, ImageData, bitmap conversion, pixel
buffer serialization, PNG/JPEG encoding or Canvas2D rasterization on either shared
transport path. Evidence PNG capture happens after measurement. No GPU trace was
collected, so **end-to-end zero-copy and absence of all implicit driver copies are
not proven**.

### Corrections made by Codex

- Bound `warmupMs` in the legacy page-evaluation argument; passing it without
  destructuring caused a runtime ReferenceError.
- Replaced literal backslash-n sequences in legacy GLSL with actual newlines.
  The original programs failed with `unexpected token` compiler errors. Fixed the
  text fixture's newline too.
- Corrected legacy renderProfile density. It originally rendered a 1596×998
  shader canvas instead of the required approximately 2561×1601 output.
- Corrected initial Windows window/work-area clamping and OSR DIP rounding by
  checking the real source CSS viewport before warmup. Original source was only
  2564×1526 pixels. Final source is exactly 1596×998 CSS, DPR 1.6042000055,
  coded size 2561×1601. Normal-window legacy fixture uses explicit CDP viewport/DPR
  metrics; comparison checks require these values and full physical output.
- Changed the comparison's expected physical dimensions from round to ceil,
  matching actual OSR and ShowMe allocation. Both measured outputs are checked.
- Sampled complete GPU identity after initialization. Original early basic GPU
  snapshot incorrectly showed all adapters inactive and software/disabled status.
  Added consumer adapter identity, successful VideoFrame import counts, output
  canvas dimensions and uncaptured WebGPU error reporting.
- Comparison children clear inherited `ELECTRON_RUN_AS_NODE`; local direct npm
  Electron launches also cleared it. Its inherited value `1` caused the first
  launch to execute as Node with undefined `ipcMain`. No dependency upgrade.
- Added ten-second process/lifetime samples and failure exits for release errors,
  consumer errors, context loss and incomplete runs. Hidden consumer rAF can be
  throttled to 1 Hz, so final measured transport and comparison runs use `--show`.
- Source destruction originally hung without a report. Close/quit/navigation now
  stop painting, close the pending queue and attempt bounded drain; destroyed
  windows are guarded. Context loss stops the experiment instead of continuing
  to count invalid draws. Drain timeouts now preserve failing diagnostics before
  process exit. No automatic device/reload recovery was added.

Measurements were taken with local uncommitted research changes. Performance results are dirty
exploratory runs at the audited HEAD plus corrections, not clean-commit speedup
claims. Close/navigation/context-loss refinements followed the main measurements;
they do not change steady-state shader or transfer work. Evidence records final
file hashes separately rather than attributing dirty results to the parent SHA.

### Proven

Visible screenshots were inspected for both backends: native Chromium glyphs,
translucent CSS card, rounded corners, shadow, rotated geometry and animated native
decoration are visibly transformed by the shader (white glyphs become green).
This is Chromium DOM/CSS → shared GPU resource → shader → visible output, not a
canvas-only input. Local PNGs are under `.benchmark-data/shared-texture/`.

Both managed transports work on the actual Radeon 880M. The initialized GPU report
identifies AMD Radeon 880M, ANGLE D3D11, enabled GPU composition and D3D shared-image
support. WebGPU reports AMD / RDNA-3. `--force_low_power_gpu` prevents this dual-GPU
machine from selecting its NVIDIA RTX 5060 Laptop GPU. No resolution reduction.

### Performance measurements

Windows x64, Ryzen AI 9 365, Radeon 880M driver 32.0.13062.24001, production Electron
44.4.1 executable. Three serial ten-second runs per shared backend, each after
1500 ms warmup and a 250 ms timing barrier. Source CSS 1596×998, DPR 1.6042,
requested 60 Hz; actual source and consumer canvas 2561×1601. No builds or tests
ran during measurements. These are source/arrival/import/submission counters,
not physical-display measurements or rAF-only FPS claims.

| Path/run | OSR/sec | Arrivals = imports/sec | Shader submits/sec | rAF/sec | Shader p50 / p95 / max ms | >33.34 ms |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| WebGPU 1 | 60.0 | 60.0 | 60.0 | 60.0 | 16.7 / 19.4 / 22.1 | 0 |
| WebGPU 2 | 60.0 | 60.0 | 60.0 | 60.0 | 16.7 / 18.3 / 23.2 | 0 |
| WebGPU 3 | 60.1 | 60.1 | 60.1 | 60.0 | 16.6 / 20.7 / 26.1 | 0 |
| WebGL 1 | 60.0 | 60.0 | 60.0 | 60.0 | 16.7 / 20.6 / 29.1 | 0 |
| WebGL 2 | 60.0 | 60.0 | 60.0 | 59.9 | 16.6 / 20.9 / 47.9 | 1 |
| WebGL 3 | 59.9 | 59.9 | 59.9 | 60.0 | 16.6 / 20.5 / 25.0 | 0 |
| WebGPU 120 seconds | 59.90 | 59.74 | 59.74 | 59.98 | 16.7 / 21.9 / 71.0 | 35 |

All six short runs have zero timed stale replacements, metadata frame gaps,
consumer drops, render/transfer/release errors or context losses. WebGPU aggregate
CPU use was 6.19–9.47 process CPU seconds per ten seconds (0.62–0.95 core-equivalent);
WebGL 7.04–7.90 seconds (0.70–0.79 core-equivalent), including browser, GPU, utility
and both renderer processes. These are not GPU execution times.

The corrected synthetic SceneTexture cadence reference passed all 11 checks at
the same dimensions/DPR/cheap final shader: **19.3 shader publications/sec**,
p95 61.4 ms over three seconds. Its renderer sources are served through the Vite
fixture, not the bundled production application. Different native scenes and a
fixture loop that awaits `flushEffectSurfaces` prevent a transport-speedup or
half-rate inference from this synthetic comparison.

The supplied `shader-text-shader.sme` was separately measured through the bundled
production application, using an identical isolated copy and fresh user profiles.
Original SHA-256: `5fa0835bf156b18ec81067569002163cbae888356124e36c581a66477bf4fe4c`.
Audience 1596×998 CSS, real DPR 1.6041666269, same AMD D3D11, presenter enabled:

| Production deck run | Audience rAF/sec | Generated shader/sec | Glass/sec | Audience p95 / max ms |
| --- | ---: | ---: | ---: | --- |
| 1 | 43.78 | 43.78 | 21.84 | 33.7 / 50.4 |
| 2 | 48.19 | 48.19 | 24.05 | 33.5 / 51.4 |
| 3 | 52.38 | 52.38 | 26.19 | 33.5 / 66.7 |

The original **approximately 2:1 audience/glass cadence persists** in the real
SceneTexture workload. Shared transport does not impose that cadence in its own
fixture. This does not prove the supplied deck would reach 60 Hz after integration:
the scene and shader workloads differ. No presenter-off repeat or old-renderer
comparison was needed for this transport audit.

### Resource lifetime

The main OSR lease is released only by `allReferencesReleased` for imported frames;
unimported stale/pending frames release directly. Main imports release after send
acknowledgment, consumer imports after obtaining the VideoFrame, frames after GPU
submission. Electron's source implements shared-image sync-token destruction,
so closing the JS frame does not itself mean the GPU has finished.

Two active transfers plus one latest pending frame remain the hard queue bound.
All six short runs offered/released respectively 718/718, 718/718, 718/718,
716/716, 707/707 and 713/713. Every final retained count is zero, peak three.
Each run is a fresh open/run/close/reopen cycle; no orphan Electron processes
remained after the diagnostics.

The two-minute run published 7188 source textures and imported/submitted 7169.
Its 19 timed stale replacements explain that difference; there were zero
consumer-side drops/errors/context losses. Including warmup, all **7306/7306**
offered textures released and final retention was zero. Source release latency
p50/p95/max was 4.17/11.66/95.57 ms. Sampled retained counts were zero or one,
global peak three. The 35 output intervals above 33.34 ms mean this is near-60 Hz
throughput, **not a stall-free guarantee**.

Consumer working set rose 81.1 → 90.7 MiB and private memory 31.6 → 35.6 MiB.
Aggregate process working set fell 1088.1 → 984.6 MiB; ten-second samples ranged
938.3–978.6 MiB, without monotonic growth. GPU-process working set fell
765.1 → 625.3 MiB. These are process memory counters, not dedicated VRAM.
Total CPU over 120 seconds was 101.04 CPU seconds. Two minutes and bounded
ownership do not establish absence of all driver/GPU leaks.

Fault diagnostics, excluded from performance results:

- 700 ms blocked consumer: 415/415 textures released, 42 stale replacements
  including warmup, peak retained three, final zero; latest-frame backpressure works.
- Source destruction, consumer close and application quit: bounded shutdown and
  complete release after the fixes. Consumer close uses the three-second missing
  consumer-result timeout and exits unsuccessfully rather than claiming a benchmark.
- Forced WebGL context loss: one detected loss, all 115/115 textures released,
  final zero, explicit failed/aborted run. Recovery is not implemented.
- Reload: first diagnostic retained one active managed texture beyond five seconds
  and required process exit. A subsequent diagnostic drained all 121/121. This is
  an **unresolved intermittent lifetime failure**, not a passing result obtained
  by retrying. The experiment aborts on navigation; it does not support reload as
  a seamless recovery operation. Do not integrate before investigating this.

### Semantic findings

| Case | Finding | Chromium surface/window count |
| --- | --- | --- |
| Complete native slide → final shader | Demonstrated visually and measured | Current harness: 2 BrowserWindows / 2 webContents, 1 OSR source, 1 visible shader consumer |
| Generated background → native text → one glass boundary | Source already demonstrates Chromium's combined background/text prefix. A glass shader could sample this **if that prefix is the entire OSR document**. The actual ShowMe glass shader was not ported into this experiment. | Same 1 OSR source plus consumer for an isolated final boundary. Integrating into a slide requires arranging the prefix separately from later painted content. |
| Native A → shader 1 → native B → shader 2 | Requires two different scene states. One final OSR frame exposes neither arbitrary prefix selection nor insertion points. | A separate-surface implementation needs at least 2 OSR sources/webContents plus 1 output consumer: at least 3 windows/webContents in this harness topology, and 2 Chromium composition passes. First shader output must feed the second native surface. Not implemented or benchmarked. |
| Video, Motion, nested groups, arbitrary CSS, clipping, transforms, group opacity | Chromium can render these inside an exported document; the API still exports only its whole compositor result. It exposes no authored intermediate group/paint-point selection. | Additional distinct prefixes require more explicitly arranged surfaces or serial Chromium passes; some prefixes may share a surface, but overhead is not constant for general layering. |

Native transforms, opacity and CSS effects were exercised. Video, authored Motion,
general nested groups and two-boundary surface feedback were considered against
the API, not claimed as completed experiment runs. Production regression tests
cover existing video/context handoff independently of the new transport.

One could serially change/render prefixes in a single webContents instead of
allocating a renderer for each boundary, but that replaces extra renderers with
extra Chromium passes, state/synchronization work and feedback transport. It is
not an exposed intermediate surface, and this experiment supplies no evidence
that such a scheme meets the required general layered cadence. No custom GPU
reconstruction was added to make these semantics appear solved.

### Architecture verdict

**TRANSPORT SUCCESS / GENERAL LAYERED ARCHITECTURE FAILURE.** More precisely:
**PARTIALLY** for the overall direction. The full-frame transport works near 60 Hz
at full size on Radeon 880M. It is a useful final post-processing primitive.

**Can this deliver general layered ShowMe effect pixels while retaining one
Chromium-native rendering architecture, without another compositor or duplicated
Chromium rendering per distinct boundary? No.** The installed Electron shared
texture API exposes complete webContents output, not arbitrary intermediate paint
surfaces. Transport speed does not change that semantic limit. It also remains
short of a production stability claim because of the reload drain failure.

Recommendation: retain this experiment as evidence that shared GPU transport is
viable for final post-processing. Do not integrate it as a general SceneTexture
backend. ShowMe still needs an explicit choice between browser-native rendering
with limits on arbitrary scene-sampling GLSL, and a deliberately defined general
GPU composition model. Neither Phase 4 qualification patches nor one Chromium
renderer per distinct effect prefix should be adopted implicitly. No recommendation
was implemented during this audit.

### Remaining unknowns

- Exact OSR/Dawn/ANGLE/driver copy and conversion behavior; no end-to-end zero-copy
  proof, GPU trace, GPU timing or physical-display cadence measurement.
- Cause of occasional long-run stalls and intermittent reload release timeout;
  forced WebGPU device loss, whole GPU-process loss and context restoration untested.
- Dedicated/shared GPU memory trend, multi-hour endurance and cross-platform behavior.
- General multi-prefix composition, video/Motion/group boundaries, real glass on
  the shared input and production security isolation have not been implemented.
- Synthetic SceneTexture and shared scenes are intentionally not equivalent; the
  supplied production deck is a separate cadence reference, not a speedup baseline.

### Verification and reproducibility

- `npm run typecheck`: passed, repeated after final code corrections.
- `npm run build`: passed (TypeScript, Vite production and Electron build).
- `npm run verify:build`: passed. No additional experiment compilation is needed:
  it is plain CJS/JS/MJS. `node --check` on all eight JS/CJS/MJS experiment files
  and `npm run test:shared-texture-policy` passed.
- `SHOWME_TEST_FILES='["tests/feature/effects/execution-graph.test.ts","tests/feature/effects/renderer-architecture.test.ts"]' npx vitest run`:
  **18 passed**.
- `npx playwright install chromium`, then with SHOWME_TEST_FILES selecting
  `tests/feature/effects/mixed-compositing.spec.ts`:
  `npx playwright test --config playwright.config.ts --grep 'GPU shader handoff|continuous invalidation|neutral live video|mixed-size shader' --output test-results-shared-texture-audit`:
  **4 passed**, including pixels/alpha, context loss, video, bounded output context
  release and continuously invalidated SceneTexture capture.
- With `SHOWME_TESTING=1`, isolated `SHOWME_TEST_ROOT_SELECTION` and SHOWME_TEST_FILES
  selecting `tests/feature/presenter/displays-electron.spec.ts`:
  `npx playwright test --config playwright.electron.config.ts --output test-results-shared-texture-electron`:
  **1 passed**.
- `git diff --check`: passed. Full/release suites, installer packaging and main's
  audience-navigation commit gate were not run; there is no main commit/integration
  and no production rendering change in this audit.

Measurement commands (clear ELECTRON_RUN_AS_NODE for direct Electron launches):

```text
npm run benchmark:shared-texture -- --backend=webgpu --force_low_power_gpu --show --duration=10000 --width=1596 --height=998 --dpr=1.6042 --fps=60 --output=.benchmark-data/shared-texture/audit-webgpu-N.json --evidence=.benchmark-data/shared-texture/audit-webgpu-N.png
npm run benchmark:shared-texture -- --backend=webgl --force_low_power_gpu --show --duration=10000 --width=1596 --height=998 --dpr=1.6042 --fps=60 --output=.benchmark-data/shared-texture/audit-webgl-N.json --evidence=.benchmark-data/shared-texture/audit-webgl-N.png
npm run benchmark:shared-texture -- --backend=webgpu --force_low_power_gpu --show --duration=120000 --width=1596 --height=998 --dpr=1.6042 --fps=60 --output=.benchmark-data/shared-texture/audit-webgpu-stability.json --evidence=.benchmark-data/shared-texture/audit-webgpu-stability.png
npm run benchmark:shared-texture:compare -- --force_low_power_gpu --duration=3000 --output=.benchmark-data/shared-texture/audit-comparison.json --evidence-dir=.benchmark-data/shared-texture/audit-comparison-evidence
node .agenttmp/shared-texture-reference.mjs
node .agenttmp/shared-texture-faults.mjs <source-close|consumer-close|reload|context-loss|stall|quit>
```

For N = 1, 2, 3, these are separate sequential measured runs. Every shared run
includes its own warmup. Deck runs use FPS_RUN=`shared-texture-audit-1` through `-3`.
Original deck and user settings were not edited. Local harnesses/logs/screenshots
remain under `.agenttmp`, `.git` and `.benchmark-data`.
Persistent [raw audit evidence](evidence/native-gpu-shared-texture-audit-2026-10-24.json)
contains all six transport runs, stability samples, comparison, production deck
runs, fault outcomes, commit/file inventory and final source hashes.
