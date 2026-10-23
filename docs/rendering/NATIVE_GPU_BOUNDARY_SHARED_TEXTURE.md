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

Use the same native scene and shader, same resolution/DPR and same production Electron environment.

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
