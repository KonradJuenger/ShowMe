# General GPU renderer experiment

Status: architecture research branch with an isolated runnable prototype. No production renderer replacement is authorized.

Branch: `research/general-gpu-renderer`

Base: `22836e64b0b2ff2a2a0d42cac742baf81646af47` — PR #19 Phase 3,
before qualified GPU SceneTexture assembly was introduced.

## Why this experiment exists

ShowMe needs a rendering architecture that is both general enough for presentation
authoring and fast enough for layered real-time effects.

The recent renderer work exposed a recurring architectural conflict.

### What we want

- normal text, images, video and CSS should look correct;
- Motion, Presence, transforms, groups and clipping should remain predictable;
- GLSL Effects should be able to layer naturally;
- a shader should be able to consume the visual result painted before it;
- representative layered scenes should be capable of approximately 60 Hz playback;
- the architecture should remain understandable rather than accumulating special
  rendering modes.

### What happened

The browser-native refactor in PR #18 deliberately removed the earlier general
composition/restoration system. Chromium again became authoritative for ordinary
DOM/CSS/media rendering, while shaders remained GPU-native.

That architecture is clean until a shader asks for already-rendered scene pixels.

The current boundary is:

```text
ShowMe semantic scene
        ↓
Chromium DOM/CSS/media compositor
        ↓
rendered scene pixels
        ↓
SceneTexture capture
        ↓
GPU texture
        ↓
GLSL
```

A normal WebGL context cannot directly sample Chromium's arbitrary intermediate
paint result. SceneTexture therefore captures/rasterizes the native scene and
uploads the result.

That path is general and semantically correct, but the measured dynamic glass
case remained too slow. On the Phase 3 reference workload, audience cadence was
approximately 49.7 callbacks/sec while glass still published at approximately
24.8/sec. The roughly 2:1 cadence persisted.

PR #19 Phase 4 proved that explicitly reconstructing a qualified scene on the GPU
can remove that bottleneck. The reference workload reached approximately 60
audience callbacks/sec and 60 glass publications/sec.

However, extending that approach from its narrow reference case toward Motion,
video, transforms, nested groups, arbitrary CSS and richer effect stacks would
gradually create a second renderer/compositor behind the SceneTexture abstraction.

This experiment asks the more direct question:

> If ShowMe needs a compositor for general layered effects, is a deliberately
> designed GPU renderer actually simpler, more predictable and faster than
> repeatedly crossing between Chromium composition and GPU shaders?

This branch exists to answer that question explicitly instead of continuing to
grow qualified special cases.

## Why this base commit

The branch starts at PR #19 Phase 3 because that point keeps architecture-neutral
performance improvements while excluding the Phase 4 GPU scene reconstruction.

Retained from Phase 1–3:

- redundant editor/presenter visual playback is suspended during presentation;
- stable WebGL resource ownership and program bindings are cached;
- shader work uses two bounded shared contexts rather than one context per chain;
- current browser-native document/rendering semantics remain intact.

Not present:

- `sceneTextureGpu.ts`;
- qualified GPU reconstruction of native scene prefixes;
- a new production compositor.

This provides a neutral comparison point for both architecture experiments:

1. Chromium-native composition + shared-GPU-texture bridge;
2. deliberate ShowMe GPU composition.

The sibling research branch for the first experiment is:

`research/native-gpu-shared-texture-boundary`

The two experiments should be compared, not combined prematurely.

## Existing ShowMe model is already close to a render graph

This experiment must not create a second document model.

The existing ShowMe data already provides most of the semantic information a GPU
renderer would need.

An Element already has:

- explicit x/y/width/height;
- rotation;
- scale;
- flip;
- transform origin;
- opacity;
- fill;
- stroke;
- corner radius;
- image/video/SVG/text content;
- media Fit / Fill / Free transforms;
- nested children;
- clipping;
- ordered Effects.

`compositionPlan.ts` already derives renderer-independent paint semantics:

- source;
- fill;
- stroke;
- children;
- clipping;
- Effect stages;
- exact Effect inputs;
- semantic backdrop paint points;
- scene prefixes;
- Effect dependencies.

That plan is important evidence that ShowMe's presentation model is much more
constrained than arbitrary HTML layout.

The experiment should therefore test whether this semantic model can drive one
explicit GPU composition graph.

Do not modify persistence merely to make rendering easier.

## Proposed renderer ownership

The experiment should test this ownership split.

### ShowMe GPU renderer owns

- scene ordering;
- element transforms;
- group transforms;
- group opacity;
- clipping;
- masks where already represented by ShowMe semantics;
- image/SVG textures;
- video textures where practical;
- generated GLSL;
- chained GLSL;
- content/backdrop shader inputs;
- intermediate render targets;
- ordered group composition;
- final presentation framebuffer.

### Chromium remains responsible for things it is uniquely good at

Primarily:

- text layout/rasterization;
- arbitrary authored CSS that ShowMe does not semantically understand;
- browser-native content whose exact pixels are easier to obtain from Chromium
  than reproduce.

The key experiment is whether Chromium can act as a **rasterization service**
rather than the final scene compositor.

For example:

```text
text/content changes
        ↓
Chromium rasterizes native element
        ↓
cached GPU/bitmap surface
        ↓
ShowMe GPU renderer positions/transforms/composites it every frame
```

Motion of a text element must not require rerasterizing the text. Only changes
that alter its native pixels should invalidate the raster.

Examples:

- move / rotate / scale text → reuse cached text surface;
- change text / font / typography / CSS appearance → rerasterize;
- group opacity → GPU composition only;
- clip/group transform → GPU composition only.

This is the hypothesis to test.

## This is not a browser replacement

Do not attempt to implement HTML/CSS layout in WebGL.

Do not write a custom text engine.

Do not reproduce arbitrary browser CSS property semantics one property at a time.

The experimental renderer should use ShowMe's explicit semantic scene model for
composition, while delegating native raster generation to Chromium where needed.

If the experiment requires reimplementing a browser to remain visually correct,
it has failed architecturally.

## Core architectural difference from PR #19 Phase 4

Phase 4 was a qualified SceneTexture optimization:

```text
if scene matches narrow pattern:
    reconstruct this SceneTexture input on GPU
else:
    native capture fallback
```

A general GPU renderer experiment instead asks:

```text
compile ShowMe scene once
        ↓
ordered render graph
        ↓
native raster sources + media textures + GLSL nodes
        ↓
GPU composition
        ↓
final framebuffer
```

The renderer should not need a growing set of conditions such as:

- transformed case;
- Motion case;
- simple group case;
- video case;
- two-effect case;
- etc.

Transforms, groups, opacity and shader stages should be normal graph operations.

Fallback should exist only for unsupported source rasterization/content, not as a
second scene-composition architecture.

## Minimal experimental scene

Do not begin with the whole application.

Build one isolated renderer/harness able to render a scene containing:

1. generated animated shader background;
2. native Chromium-rasterized text;
3. transformed image;
4. nested group;
5. group opacity;
6. clipping;
7. glass/backdrop GLSL shader;
8. moving native-text raster;
9. final shader stage.

A useful conceptual stack is:

```text
generated shader
→ native text raster
→ transformed image
→ nested clipped group
→ glass/backdrop shader
→ moving text raster
→ final shader
```

The scene should exercise actual composition semantics, not just several unrelated
rectangles.

Then add video as a separate follow-up.

## Render graph experiment

Derive the graph from the existing ShowMe semantic model where possible.

The graph should make intermediate scene state explicit.

A backdrop shader should naturally consume the render target representing
everything painted before its semantic paint point.

Example:

```text
RT0 = clear/background
RT1 = shaderBackground()
RT2 = composite(RT1, textTexture, transform)
RT3 = composite(RT2, imageTexture, transform)
RT4 = renderGroup(...)
RT5 = glassShader(input = RT4)
RT6 = composite(RT5, movingTextTexture)
FINAL = finalShader(RT6)
```

This is intentionally different from asking Chromium to repaint/capture each
prefix.

The implementation should minimize actual render-target allocations by analysing
lifetime and reuse, but correctness comes first in the initial experiment.

## Native raster cache

The experiment needs a small explicit cache for browser-rasterized native content.

A cache key/revision should represent changes that alter pixels, for example:

- text;
- font/font load;
- typography;
- native CSS/classes/style;
- element pixel dimensions;
- content source;
- relevant appearance.

Do not include world transform or group opacity if those are handled by the GPU
renderer.

The experiment should record:

- rasterizations/sec;
- retained native surfaces;
- GPU uploads;
- cache hits;
- invalidations;
- memory use estimate.

During pure Motion, static text should rasterize zero times after warmup.

## Images

Prefer direct texture ownership.

Use ShowMe's existing resolved Fit / Fill / Free media transform semantics.

The GPU renderer should compose the media texture through the same element/group
transform graph instead of asking Chromium to rasterize an already-transformed
image if practical.

## Video

Video is a separate experiment after the static scene works.

Investigate the most direct supported browser/GPU path available in the current
Electron version.

Do not add CPU per-frame readback.

Measure whether video frame upload/import becomes the new limiting factor.

## CSS

CSS is the hardest boundary and must remain explicit.

There are two categories.

### ShowMe-semantic properties

If ShowMe already owns the semantic value — for example frame transform, authored
opacity, clipping, fill, stroke or radius — prefer expressing it directly in the
GPU composition graph.

### Arbitrary browser CSS

If custom CSS changes pixels in ways the renderer does not semantically understand,
Chromium should rasterize the affected native source.

Do not gradually parse and recreate arbitrary CSS in the GPU renderer.

The experiment must determine whether this division is coherent enough for the
actual ShowMe authoring model.

## Motion and Presence

The GPU renderer should consume the same semantic Motion/Presence values as the
current runtime.

Do not create another animation state machine.

Motion should update render-node properties:

- transform;
- opacity;
- effect parameters;
- Presence.

It should not trigger browser rasterization when only compositional properties
changed.

Presence should gate graph participation/visibility according to the existing
runtime semantics.

## Effects

Respect the current Effect model.

Generated GLSL:

- no scene input;
- direct GPU stage.

Content GLSL:

- consumes the element's composed content according to the existing semantic
  composition plan.

Backdrop GLSL:

- consumes the exact render target representing the semantic scene prefix.

Shader chains should remain GPU-native.

Text JS and CSS/native effects may require native raster regeneration. Do not
silently change their semantics merely to keep everything on the GPU.

## Resolution

Render at the current audience output resolution.

Do not reduce SceneTexture/native raster/GPU output resolution to make the
experiment look faster.

Use the existing render-profile/density semantics where practical.

## Performance target

The first important target is the Radeon 880M / D3D11 reference hardware already
used for the renderer investigation.

For the representative layered scene, target:

- approximately 58–60 audience/render callbacks per second;
- approximately 58–60 backdrop/final shader publications per second;
- frame p95 near one refresh rather than recurring 33/50/66/83 ms cadence;
- zero native rerasterization during transform-only Motion after warmup;
- bounded render-target/resource counts;
- no unbounded memory growth.

Do not equate callback rate with physical display FPS.

Record actual publication rates separately.

## Correctness target

Compare the experimental output against the existing Chromium-native renderer for
static reference frames.

Important cases:

- alpha;
- text appearance;
- gradient/image sampling;
- fractional edges;
- nested transforms;
- clipping;
- group opacity;
- effect ordering;
- content shader input;
- backdrop shader input.

Pixel-perfect identity may not always be realistic across different compositor
sampling paths, but discrepancies must be understood rather than accepted because
the result is faster.

## Architecture success criteria

The GPU renderer is promising if:

1. ShowMe's existing semantic scene model maps naturally to a render graph.
2. Transforms, groups, clipping and opacity are ordinary operations rather than
   qualification cases.
3. Shader input semantics become simpler, not more complicated.
4. Chromium-native text/CSS can be cached and reused without rasterization during
   transform-only animation.
5. Representative layered scenes sustain approximately 60 Hz on the target
   hardware.
6. Resource lifetime and render-target allocation remain bounded.
7. The renderer can plausibly support images and video without CPU readback.
8. The code is conceptually simpler than a growing set of native/GPU boundary
   exceptions.
9. Document/persistence semantics do not need to change.
10. Chromium can remain a raster source for native content instead of requiring
    ShowMe to reimplement browser layout/CSS.

## Architecture failure criteria

Treat the experiment as unsuccessful if it requires:

- implementing a general browser/CSS engine;
- a second animation state machine;
- persistent per-element full-resolution render targets for ordinary composition;
- CPU readback every frame;
- rerasterizing static native content during transform-only Motion;
- large unbounded GPU memory;
- numerous special-case render modes comparable to the qualified SceneTexture
  approach;
- changing the document model substantially just to make rendering possible;
- visibly unacceptable text/media quality;
- performance no better than the native/capture renderer on representative
  layered scenes.

A negative result is useful. Record it rather than hiding it behind additional
special cases.

## Comparison with the shared-texture experiment

There are now two explicit candidate architectures.

### A. Chromium-native composition

```text
ShowMe scene
→ Chromium compositor
→ GPU shared texture bridge
→ shaders
```

Strength:

- Chromium remains the general compositor.

Main unresolved question:

- can arbitrary intermediate Effect paint points be exposed efficiently without
  one Chromium renderer/surface per prefix?

Research branch:

`research/native-gpu-shared-texture-boundary`

### B. ShowMe GPU composition

```text
ShowMe scene
→ semantic GPU render graph
    ↳ Chromium native raster sources
    ↳ image/video textures
    ↳ GLSL
→ final framebuffer
```

Strength:

- intermediate Effect inputs are natural render-graph states;
- transform/group composition is explicit and GPU-native.

Main unresolved question:

- can native text/CSS rasterization remain accurate and sufficiently simple
  without recreating Chromium semantics?

Research branch:

`research/general-gpu-renderer`

Do not merge the two experiments until both have produced evidence.

The purpose is to choose one honest architecture, not create a hybrid containing
both full composition models.

## Suggested implementation phases

### Phase G0 — graph only

Build a renderer-independent GPU render graph compiler from a small ShowMe scene.

No product integration.

Inspect the graph and validate ordering/input dependencies.

### Phase G1 — basic GPU composition

Support:

- generated shader;
- image texture;
- transforms;
- opacity;
- nested groups;
- rectangular clipping;
- intermediate FBO;
- backdrop shader;
- final output.

Measure resource count and frame cadence.

### Phase G2 — Chromium text raster source

Render native text through Chromium once, upload/cache the resulting surface and
compose it through the GPU graph.

Verify:

- text pixel changes rerasterize;
- transform-only Motion does not;
- font completion invalidates correctly.

### Phase G3 — parity/reference scene

Implement the representative layered scene and compare static frames against the
current native renderer.

Then measure sustained playback.

### Phase G4 — video

Add one video source through the most direct supported path and measure separately.

### Phase G5 — decision

Do not proceed toward product integration until there is an architecture review
comparing:

- native + shared texture;
- general GPU renderer;
- current Phase 3 renderer.

Document:

- correctness;
- complexity;
- performance;
- memory;
- resource ownership;
- cross-platform implications;
- unsupported semantics.

## Non-goals

- No main merge.
- No user-facing renderer toggle.
- No persistence changes.
- No replacement of the current renderer.
- No revival of PR #19 Phase 4 qualified SceneTexture logic.
- No attempt to implement arbitrary CSS in GLSL.
- No broad UI work.
- No GitHub Actions/CI work.
- No 60 FPS claim until measured on visible production Electron hardware.

## Expected output of this branch

The branch should eventually contain:

- one isolated GPU-renderer prototype;
- focused tests/harnesses;
- performance diagnostics;
- static parity evidence;
- a concise architecture result.

The final result should answer:

> Is ShowMe's explicit presentation scene model constrained enough that one
> deliberate GPU compositor, using Chromium only for native raster sources,
> gives a cleaner and more performant architecture than keeping Chromium as the
> scene compositor and repeatedly crossing the native/GPU boundary?

## Prototype implementation snapshot — 2026-10-24

This section records the first runnable implementation pass on
`research/general-gpu-renderer`. It deliberately does not change the production
renderer and does not revive PR #19 Phase 4 SceneTexture reconstruction.

### Implemented facts

The prototype lives under `src/experiments/gpu-renderer/` and is exercised only
through a focused test harness.

`graph.ts` compiles directly from `compileCompositionPlan(...)`. It retains the
existing `Element`, `Composition`, Effect instance and Effect resource identities
rather than defining another persisted scene model. The experimental graph makes
these existing semantics explicit for the GPU executor:

- source kind: Chromium-native text, image, SVG or video;
- fill and stroke paint operations;
- child/group paint order;
- rectangular clip operations;
- ordered Effect stages;
- content versus backdrop versus generated shader input;
- the existing semantic backdrop paint point for diagnostics and validation.

`renderer.ts` owns one WebGL2 context. It implements:

- slide clear/background;
- premultiplied-alpha textured quads;
- affine element/group transforms using the existing `localMatrix(...)` rules;
- nested groups;
- group opacity applied once when a completed child/group target is composited;
- rectangular clipping by rendering clipped groups into their local frame target;
- direct image/SVG/video `TexImageSource` upload paths;
- existing Fit / Fill / Free placement through `resolveMediaFrame(...)`;
- pooled intermediate textures/FBOs;
- generated fragment shaders;
- content fragment shaders;
- backdrop fragment shaders;
- final fragment-shader stages;
- existing Effect timing and numeric Effect-parameter Motion;
- existing Motion and Presence sampling through `resolveMotion(...)`,
  `motionElement(...)`, `sampleElementPresence(...)` and
  `presenceElement(...)`.

The renderer does not call `SlideRenderer`, `SceneTexture`, `elementRaster` or
`domRaster`. The production renderer remains unchanged. The Chromium raster
implementation is injected by the experiment harness through a narrow native
raster-source contract, so existing production renderer architecture gates remain
unchanged.

Backdrop input is no longer a Chromium capture in this experiment. Completed
root groups already exist in the persistent full-slide GPU scene target. When a
backdrop Effect is reached inside an unfinished group, the renderer composes the
current scene target plus the unfinished ancestor/local group targets into a
pooled full-slide scratch target, then maps that scene through the inverse current
world transform into the Effect's local input target. The shader therefore
consumes the pixels that exist at its semantic paint point without asking
Chromium to repaint that prefix.

The render-target pool retains a bounded number of texture/FBO objects. An idle
target may be resized and reused when dimensions change instead of allocating a
new target for every historical size. The long-lived full-slide scene target is
one retained target; other group/effect/backdrop targets are explicitly acquired
and released during a frame. Diagnostics expose allocations, resizes, live FBOs,
live textures and estimated RGBA texture bytes.

### Native raster strategy

`nativeRaster.ts` defines the renderer-facing native-raster contract, the text
pixel identity and the DOM styling needed to match the current `TextView`. The
actual Chromium implementation lives in `tests/helpers/gpuNativeTextRaster.ts`
and uses the existing `createDomRasterSource(...)` native Chromium painter. The
GPU renderer receives that source through dependency injection. It does not
implement text layout itself and it does not import the production capture path.

The injected hidden source DOM reproduces the current `TextView` typography/flex layout
and applies the deck stylesheet inside a `.slide-renderer` scope. Its semantic
pixel key contains:

- text and placeholder state;
- auto-size mode;
- resolved typography;
- raster width/height;
- CSS classes;
- deck stylesheet.

It deliberately excludes:

- x/y;
- rotation;
- scale;
- flips;
- parent transforms;
- authored/group opacity.

The source therefore remains unchanged during transform-only Motion and Presence
transport. `createDomRasterSource(...)` still provides font-loading invalidation,
so a completed font load can dirty and rerasterize the native surface without
making transform Motion part of the raster key.

A focused browser check warms the native surfaces, runs transform/rotation/scale
Motion for many GPU frames and verifies that native rasterization and texture
upload counts do not increase. A separate pixel-changing text edit check verifies
that native rasterization does increase when text pixels change.

### Experiment scene and parity harness

`tests/helpers/gpuRendererHarness.tsx` creates the requested layered scene:

```text
generated animated shader
→ Chromium-rasterized native text
→ direct transformed Fill image
→ nested clipped group with group opacity
→ backdrop/glass shader
→ moving Chromium-rasterized native text
→ final backdrop shader
```

The image is an actual browser-platform imported PNG with asymmetric coloured
quadrants, so orientation and Fit/Fill sampling can be inspected. The same ShowMe
model can also be mounted through the current `SlideRenderer` beside the GPU
canvas. A static parity helper captures that Chromium-native reference only for
comparison and reports coarse channel/alpha error. That reference capture is not
used by the GPU render loop.

The browser test also probes the asymmetric image orientation and checks that the
GPU graph remains free of reported runtime errors. The parity check is
intentionally coarse. It is evidence for obvious semantic disagreement, not a
production golden-image framework.

### Diagnostics implemented

`GpuRendererExperiment.diagnostics()` currently reports:

- WebGL context count;
- unmasked GPU vendor/renderer when Chromium exposes it;
- recent render callbacks/sec;
- total and recent shader publications/sec;
- per-Effect shader publication totals and recent rates;
- native text rasterizations/sec and total rasterizations;
- native raster cache hits and invalidations;
- live native surfaces;
- GPU source uploads;
- render-target allocations and resizes;
- live texture/FBO counts;
- render-target/source/total logical RGBA texture-byte estimates;
- frame interval p50/p95/max;
- explicit test-only readback count;
- diagnosed renderer errors.

Callback/publication rates are application-level measurements. They are not a
claim about physical display FPS.

### Unsupported or deliberately incomplete

This first pass intentionally stops before the following work:

- CSS Effects and text-JS Effects are not recreated in WebGL. The renderer throws
  an explicit unsupported-feature error rather than silently changing semantics.
  A later native-surface adapter would have to rasterize their browser result.
- Rounded clipping, ellipse masks and arbitrary masks are not implemented.
- The prototype compiles a slide snapshot when the renderer is constructed. It
  does not yet implement incremental graph recompilation for editor mutations.
- Video uses the same direct `TexImageSource` upload path and revision model, but
  it has not been exercised or benchmarked in this pass.
- Arbitrary deck CSS is only exercised through the Chromium-native text surface.
  No CSS parser/compositor is being added to WebGL.
- Static parity is intentionally lightweight; fractional-edge, rotated nested
  group and cross-DPR tolerances still need hardware inspection.
- The pooled full-slide scratch used to materialize nested backdrop input may
  still be a meaningful memory/bandwidth cost at 4K. It is explicit and bounded,
  but not yet measured.

None of these gaps caused a new document/persistence model, a second Motion state
machine, CPU per-frame scene readback, or transform-driven native rerasterization
in the current prototype.

### Local measurements from this ChatGPT pass

No Radeon 880M / D3D11 performance result was produced here. This environment has
no checkout with the repository's installed dependencies and its available Node
runtime is older than the repository's declared Node 24/26 requirement. It would
be misleading to quote frame-rate numbers from it.

A syntax-oriented TypeScript pass was run over the new experiment files with the
available global TypeScript compiler. The actual repository build, TypeScript 6
check, Playwright Chromium painter path and native Windows GPU measurements remain
for the local handoff below.

### Exact experiment/test commands

From the repository root in PowerShell, with the repository's required Node and
dependencies installed:

Unit graph/cache-key checks:

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/effects/gpu-renderer-experiment.test.ts"]'
npx vitest run --config vitest.config.ts
```

Focused browser architecture/parity checks:

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/effects/gpu-renderer-experiment.spec.ts"]'
npx playwright test --config playwright.config.ts
```

Headed visual inspection of the same harness:

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/effects/gpu-renderer-experiment.spec.ts"]'
npx playwright test --config playwright.config.ts --headed
```

Full build/type verification requested for the local follow-up:

```powershell
npm run typecheck
npm run build
```

The harness URL served by Vite is:

```text
/tests/helpers/gpu-renderer-experiment.html
```

It requires Chromium's `CanvasDrawElement` feature for the native raster source.
The repository Playwright browser configuration already launches Chromium with
`--enable-blink-features=CanvasDrawElement`.

### Radeon 880M / D3D11 benchmark procedure

The browser spec contains an explicitly skipped 1920 × 1080 manual benchmark. It
uses the same renderer and scene, disables the comparison `SlideRenderer`, keeps
native text at its authored raster resolution and does not downscale the GPU
scene to obtain a better result.

Run on the reference Windows machine:

```powershell
$env:SHOWME_GPU_BENCHMARK='1'
$env:SHOWME_TEST_FILES='["tests/feature/effects/gpu-renderer-experiment.spec.ts"]'
npx playwright test --config playwright.config.ts --headed -g "manual 1080p GPU renderer benchmark"
```

The test prints one `SHOWME_GPU_RENDERER_BENCHMARK` JSON object. Inspect:

- `after.gpu.renderer`: confirm Radeon 880M and ANGLE/D3D11 rather than a software
  renderer;
- `benchmark.callbackRate`: target roughly 58–60 application render callbacks/s;
- `after.shaderByEffect[ids.glass].perSecond`: target roughly 58–60;
- `after.shaderByEffect[ids.final].perSecond`: target roughly 58–60;
- `after.nativeRasterizations - before.nativeRasterizations`: must be `0` for
  transform-only Motion after warmup;
- `after.gpuUploads - before.gpuUploads`: should remain `0` for static text/image
  sources during the Motion benchmark;
- `after.renderTargetAllocations`: must remain stable after warmup;
- `after.renderTargetResizes`: should remain stable for this fixed-local-bounds
  scene;
- `after.frameIntervalMs.p95`: should be near one refresh interval and should not
  show a persistent 33/50/66/83 ms cadence;
- `after.logicalTextureBytes`, `activeTextures` and `activeFbos`: confirm bounded
  ownership without frame-over-frame growth;
- `after.errors`: must remain empty.

Do not interpret `callbackRate` as physical monitor FPS.

### Assumptions to validate locally

- The current ShowMe fragment-shader convention is effectively premultiplied for
  composited input/output, matching the experiment's `ONE / ONE_MINUS_SRC_ALPHA`
  composition path.
- Existing group-opacity semantics are preserved when an unfinished ancestor is
  materialized for a nested backdrop Effect. Group opacity is intentionally
  applied only when that group is composited into its parent.
- Browser `texImage2D(video)` remains an acceptable direct upload/import boundary
  on Electron/ANGLE without introducing CPU pixel readback.
- Chromium native-raster output at audience density remains visually acceptable
  through repeated GPU affine sampling.

### Open questions for local Codex

1. Run TypeScript 6, lint if useful, the focused unit test and focused Playwright
   browser test. Fix experiment-local mistakes without weakening existing tests.
2. Inspect the side-by-side static reference for text metrics, image orientation,
   alpha, rectangular clipping, nested transform/group opacity and Effect order.
3. Run the explicit 1080p benchmark on Radeon 880M / D3D11 and record the printed
   diagnostics in this document under a new `Local hardware measurements`
   subsection. Do not replace callback/publication rates with a physical-FPS
   claim.
4. Watch GPU memory while running the benchmark repeatedly. Confirm the pool's
   texture/FBO count and logical byte estimate stabilize.
5. Exercise one direct video source. Confirm frame updates use the direct WebGL
   upload/import path and do not introduce CPU `getImageData`/`readPixels` work in
   the render loop.
6. Stress nested backdrop Effects inside transformed/opaque groups. Validate the
   current-scene + unfinished-ancestor reconstruction against `SlideRenderer`.
7. Decide whether native CSS/text-JS Effect output can be represented as another
   cached Chromium raster source without making Chromium a second scene
   compositor. If not, record that as an architectural failure rather than adding
   qualification rules.
8. Measure 4K render-target memory/bandwidth before considering any product
   integration.

The architectural question remains open until those hardware measurements and
native-surface semantics are validated. This pass shows that transforms, nesting,
rectangular clipping, group opacity and backdrop input can be represented as
ordinary graph operations without Phase 4-style scene-pattern qualification.
