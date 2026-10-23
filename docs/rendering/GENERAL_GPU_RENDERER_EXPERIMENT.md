# General GPU renderer experiment

Status: architecture research branch. No production renderer replacement is authorized.

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
