# Browser-Native Renderer Experiment

Branch: `experimental/browser-native-renderer`

Base: `chatgpt/general-compositor-fix` at `8ff4fb95ef73e9244ff04781f16bfbaafd593424`

Status: experimental branch with browser-native normal rendering and direct GPU
shader presentation. See [current architecture and validation](DIRECT_GPU_RENDERER_VALIDATION.md).
The exploration and migration plan below describe the earlier design process.

## Why this experiment exists

ShowMe currently contains a growing custom composition path for cases such as CSS backdrop materials, retained scene surfaces, regional materialization and backdrop restoration.

That work can be technically correct while still moving the product in the wrong architectural direction.

Electron already gives ShowMe a mature Chromium renderer with support for:

- DOM and CSS
- text
- SVG
- images
- video
- masks and clipping
- transforms
- opacity
- blend modes
- `backdrop-filter`
- CSS animations and variables
- WebGL/WebGPU canvases
- arbitrary CSS+JS visual behavior

The experiment starts from a simpler product-level rule:

> Chromium is the canonical renderer for normal ShowMe content. ShowMe should own presentation semantics, timing and authoring, not reproduce Chromium paint unless a feature explicitly requires scene pixels.

The goal is not merely to simplify code. It is also to improve playback smoothness by removing duplicate rendering work from the hot path.

## Current problem

The difficult rendering path can become conceptually similar to:

```text
Motion update
  -> DOM mutation
  -> invalidation detection
  -> dependency analysis
  -> source preparation
  -> Canvas rasterization
  -> retained publication
  -> backdrop restoration
  -> DOM update
  -> Chromium paint/composition
  -> screen
```

Chromium already has its own style, layout, paint and compositing pipeline.

The target is to avoid placing a second general-purpose renderer in front of it.

For ordinary presentation playback, the desired path is closer to:

```text
sample canonical ShowMe time
  -> update CSS transforms / opacity / variables / GPU uniforms
  -> Chromium compositor
  -> screen
```

## Core rendering contract

### 1. Browser-native rendering is the default

These should render directly through Chromium unless there is a specific proven reason not to:

- text
- images
- video
- SVG
- rectangles and ellipses
- frames and clipping
- transforms
- opacity
- masks
- blend modes
- CSS Effects
- `backdrop-filter`
- CSS+JS Effects
- ordinary DOM nesting

ShowMe should accept Chromium's composition semantics as canonical for these cases.

A CSS glass card should be a real CSS glass card.

ShowMe should not secretly rasterize and reconstruct it merely to preserve an alternate composition model.

### 2. Motion remains a ShowMe semantic system

ShowMe still owns:

- Motion recipes
- Presence
- Click Timeline
- start / stop / speed
- presentation / slide / click timing
- Effect parameters
- canonical time and progress

But ordinary playback should update browser/GPU properties imperatively rather than structurally rebuilding the scene.

Typical hot-path updates should be limited to:

- `transform`
- `opacity`
- CSS custom properties
- Effect parameters
- shader uniforms

React should own document structure and editing state, not drive every animation frame.

### 3. Keep Elements mounted when practical

Presentation playback should avoid repeated mount/unmount and scene reconstruction.

Presence should primarily control rendering participation and hit testing while preserving media and expensive resources where appropriate.

Structural work belongs to editing or slide preparation, not the frame loop.

## Effect classes

The experiment should move toward explicit Effect classes with clear rendering ownership.

### Browser-native Effect

Examples:

- CSS glass
- blur
- shadows
- masks
- blend modes
- CSS filters
- CSS transforms
- CSS+JS DOM effects
- programmable text effects that operate on owned DOM/text

Rendering owner: Chromium.

No scene materialization should be involved.

### Generated GPU Effect

A shader generates its own pixels procedurally.

Examples:

- animated background shader
- procedural noise
- dither pattern
- particle field
- generative texture

Rendering owner: persistent WebGL/WebGPU canvas or GPU surface owned by the Effect.

The canvas is simply another browser layer in the scene.

Inputs may include ShowMe's canonical:

- `t`
- `p`
- dimensions
- Effect parameters
- click-derived values

It should not require the general scene compositor.

### Media GPU Effect

A shader processes media that ShowMe already owns directly.

Examples:

- image color transformation
- image distortion
- video processing
- image displacement using another known texture

Rendering owner: GPU Effect.

Inputs are explicit media textures, not arbitrary reconstructed browser paint.

### Scene GPU Effect

This is the advanced category.

A Scene Effect explicitly requires already-rendered scene pixels as an input texture.

Examples:

- full-slide post-processing
- chromatic aberration over the final slide
- feedback
- scene displacement
- scene-level pixel sorting
- edge detection over composed content
- shader transitions between outgoing and incoming slides
- explicit flattened-group processing

This path may require capture, flattening or an advanced GPU backend.

It should be rare and explicit.

## When the advanced GPU path is actually needed

Use it when one of these conditions is true:

1. The Effect needs the already-rendered slide as a texture.
2. The Effect needs an explicit flattened group as a texture.
3. A transition needs both outgoing and incoming slides as textures.
4. Multiple GPU Effects form an intentional texture graph.
5. The visual is fundamentally GPU-native and large-scale, such as heavy procedural or particle rendering.
6. A user explicitly requests flattening before applying an Effect.

Do not use the advanced GPU path merely because:

- an Element has opacity
- an Element moves
- an Element scales
- an Element rotates
- CSS uses `backdrop-filter`
- CSS uses a blend mode
- a frame clips an image
- text is present
- SVG is present
- a CSS+JS Effect exists

Those remain browser-native.

## Important product boundary

There are two fundamentally different renderer models.

### Browser renderer

Advantages:

- arbitrary HTML/CSS
- excellent text
- media
- SVG
- browser layout
- browser clipping
- browser masks
- browser backdrop effects
- low authoring friction
- direct CSS+JS extensibility

Limitation:

JavaScript does not automatically receive arbitrary intermediate Chromium paint states as textures.

### Full custom GPU renderer

Advantages:

- exact programmable texture graph
- arbitrary intermediate shader sampling

Cost:

ShowMe would need to own or faithfully reproduce much more of:

- text rendering
- font layout
- media
- SVG
- masks
- clipping
- CSS-like layout
- blend modes
- browser paint
- rasterization
- texture lifetime
- GPU synchronization

ShowMe should not become a full custom renderer unless the product direction changes radically.

The preferred architecture is therefore browser-native with a narrow explicit Scene GPU escape hatch.

## Target architecture

```text
                     ShowMe document
                            |
                    semantic scene
                            |
             +--------------+--------------+
             |                             |
      Browser-native path           Explicit GPU path
        majority of scene              minority
             |                             |
      DOM / CSS / media          generated textures
      CSS+JS Effects             media textures
      native backdrop            scene textures
      text / SVG / video         slide transitions
             |                             |
             +--------------+--------------+
                            |
                         Chromium
                            |
                            GPU
```

The general SceneSurface materializer must not sit on the normal rendering path.

## What happens to the current compositor work

Do not delete it immediately.

The work in:

- `compositionPlan.ts`
- `compositionSurface.ts`
- `compositionRuntime.ts`
- `compositionBackendPlan.ts`
- `backdropRestoration.ts`
- `elementRaster.ts`

contains useful architectural lessons and may remain useful for explicit SceneTexture requests.

However, the experiment should stop making that subsystem more general for ordinary DOM rendering.

The long-term direction should be to reduce it to a narrow service such as:

```text
request explicit scene texture
  -> materialize/capture defined region
  -> hand texture/surface to advanced Effect
```

rather than:

```text
ordinary Element
  -> inspect capabilities
  -> reconstruct browser paint
  -> restore backdrop
  -> recompose
```

## CSS glass decision

CSS glass is the first important experiment.

Target behavior:

```css
.card {
  backdrop-filter: blur(...);
  background: ...;
}
```

Chromium renders it directly.

If Chromium's CSS semantics for opacity, stacking contexts and `backdrop-filter` produce a result that differs from ShowMe's previous custom group-alpha restoration semantics, the browser result becomes canonical for browser-native Effects.

Do not add a special restoration path simply to make ordinary CSS behave unlike CSS.

If a user needs a different compositing operation, that should be represented as an explicit advanced Effect.

## Migration plan

### Phase 1: Establish the contract

Document and enforce:

- Chromium owns normal paint.
- ShowMe owns semantic scene/timing.
- Scene texture access is explicit.
- Browser-native Effects must not silently enter a raster reconstruction path.

No broad code deletion yet.

### Phase 2: Browser-native CSS glass prototype

Create one representative presentation containing:

- background
- image
- text
- native CSS glass
- overlapping shapes
- Motion opacity
- Motion transform
- Presence
- another foreground Element

Render it without backdrop restoration or scene materialization for the CSS card.

Compare:

- visual result
- editor result
- audience result
- frame pacing
- CPU usage
- invalidation behavior

The experiment is successful if the browser-native path is visually acceptable and materially simpler/smoother.

### Phase 3: Make Motion hot-path friendly

During ordinary playback:

- no React reconciliation from the animation clock
- no DOM tree scans
- no scene rasterization
- no Canvas copies
- no image decode
- no shader compilation
- no compositor reconstruction

Motion should update a small bounded set of properties/uniforms.

### Phase 4: Move ordinary Effects fully native

Validate:

- CSS Effects
- CSS+JS Effects
- text JS Effects
- frames
- masks
- blend modes
- SVG
- video
- ordinary media
- generated shader canvases

Remove unnecessary compositor participation as each category proves stable.

### Phase 5: Simplify compositor responsibilities

After browser-native paths are established, identify which responsibilities can disappear from:

- `compositionBackendPlan.ts`
- `backdropRestoration.ts`
- `elementRaster.ts`
- `compositionSurface.ts`

Do not preserve complexity merely because it already exists.

Retain only what explicit SceneTexture consumers require.

### Phase 6: Generated and media shader cleanup

Generated shader:

```text
ShowMe timing + parameters
  -> persistent GPU Effect
  -> browser layer
```

Image/video shader:

```text
known media texture
  -> persistent GPU Effect
  -> browser layer
```

Neither should require arbitrary scene rasterization.

### Phase 7: Advanced Scene GPU path

Only after the browser-native renderer is stable.

Start with high-value bounded cases:

1. full-slide post-processing
2. outgoing/incoming slide transition textures
3. explicit flattened groups

Arbitrary intermediate per-Element scene capture should come later, if it is actually necessary.

## Editing versus playback

Editing and playback have different performance requirements.

Editing may legitimately perform:

- React reconciliation
- scene restructuring
- media preparation
- shader compilation
- asset loading
- expensive diagnostics

Playback should be structurally quiet.

When presentation mode begins, the scene should already be prepared.

The steady-state playback loop should avoid work that can be moved to preparation time.

## Performance contract

Create a deliberately difficult reference presentation containing:

- many images
- text
- nested frames
- CSS glass
- multiple generated shaders
- video
- Motion
- Presence
- overlapping Elements
- click-driven changes

Profile actual frame behavior.

During normal playback the target should be:

- no repeated shader compilation
- no repeated image decoding
- no React frame loop
- no general scene capture
- no Canvas scene reconstruction
- no full DOM scans
- no unnecessary layout
- minimal JS work per frame
- stable compositor-friendly transforms/opacity
- stable resource ownership

Dropped frames should eventually become a regression signal rather than a subjective observation.

## First implementation experiment

Do not begin by rewriting everything.

First create a branch-local browser-native path for one representative CSS glass + Motion presentation.

The experiment should answer:

1. Can CSS glass render directly through Chromium with acceptable semantics?
2. Does Motion remain correct when only native transform/opacity properties are updated?
3. Can Presence work without rebuilding the surrounding scene?
4. Does audience rendering match editor/preview sufficiently?
5. Does removing restoration/materialization reduce jitter or frame cost?
6. Which current compositor components become unnecessary for this presentation?
7. Are any visual differences genuine product problems, or merely differences from the custom compositor's previous semantics?

Do not broaden the experiment until these questions are answered.

## Acceptance criteria for the architecture direction

The browser-native architecture is favored if:

- normal CSS Effects require no custom raster reproduction
- Motion playback performs no general scene materialization
- generated shaders remain independent GPU-owned layers
- ordinary text/media/SVG stay entirely browser-native
- frame pacing improves or becomes more predictable
- code paths become substantially simpler
- editor and audience remain visually coherent
- advanced SceneTexture cases remain possible through an explicit separate API

## Non-goals

This experiment does not attempt to:

- build a complete GPU scene graph
- reproduce Chromium paint
- implement custom text rendering
- replace browser layout
- guarantee arbitrary intermediate DOM capture
- remove all compositor code immediately
- change ShowMe's canonical Motion/Presence timing model
- introduce backwards compatibility layers

## Working principle

The direction can be summarized as:

> Let Chromium render browser content. Let ShowMe define presentation semantics. Use custom GPU composition only when a feature explicitly requires pixels Chromium does not expose directly.

The measure of success is not how general the custom compositor becomes.

The measure of success is how rarely ShowMe needs one.

## Vertical slice result: browser-native CSS glass

Implemented on 2026-10-23 on `experimental/browser-native-renderer`.

### Render-path finding

The previous CSS glass path was not primarily required by CSS itself. It existed to preserve ShowMe's custom resolved-material/group-alpha semantic:

```text
CSS backdrop read
  -> CompositionPlan effect-entry backdrop identity
  -> compositionBackendPlan capability/admission checks
  -> native-group split wrapper OR backdrop-restoration
  -> SceneSurface materialization / retained prefix
  -> restoration canvas or CSS backdrop replay
  -> custom alpha reconstruction
  -> Chromium
```

The restoration equation intentionally reconstructed a resolved material before applying group alpha. That differs from normal Chromium stacking-context and `backdrop-filter` behavior. The experiment now treats that difference as a product-semantic change, not as an error to repair.

### New normal CSS path

Production `SlideRenderer` now mounts CSS unconditionally as browser-native CSS. There is no CSS rendering-backend decision in the normal renderer; the legacy CSS compositor is retained only by explicit validation modules:

```text
ShowMe document / CompositionPlan
  -> scoped CSS on the mounted Effect DOM node
  -> Motion writes transform / opacity
  -> Presence gates the existing mounted Element
  -> CSS variables / Effect timing update in place
  -> Chromium style / paint / compositing
```

For this route:

- `backdrop-filter` remains the real CSS property.
- CSS Effects receive no Element raster source.
- CSS Effects receive no scene composition dependencies.
- CSS, text JS and generated shaders do not join a scene EffectGraph and do not install a scene-root `MutationObserver`.
- `createCssBackdrop` is not created.
- `SlideRenderer` no longer mounts `CompositionRuntime` or emits restoration/split-alpha DOM at all. The retained compositor is now a separate explicit subsystem rather than a normal renderer fallback.
- no `data-composition-visual`, `data-composition-paint` or `data-backdrop-restore` wrapper is required for ordinary CSS.
- Motion continues to use the existing canonical runtime and Motion values. No new clock or playback state was introduced.
- Presence continues to use the existing canonical presence sampler and keeps the CSS subtree mounted while toggling visibility, hit testing, content visibility and inert state.

### Representative fixture

The Electron rendering fixture now has a browser-native case containing:

- image background
- translucent geometry behind the card
- rounded/clipped CSS glass with `backdrop-filter`
- text inside the glass
- overlapping foreground geometry after the glass
- Move Motion
- Scale Motion
- Rotate Motion
- Fade/opacity Motion
- Presence enter and timed exit

The same boundary test runs through normal preview rendering and presentation-mode `SlideRenderer`.

The regression contract checks that ordinary Motion produces no backdrop restoration, no CSS backdrop replay, no split alpha wrapper and no CSS Effect canvas. It also checks stable DOM identity, no child-list churn during direct Motion sampling, Presence exit without unmounting, foreground ordering, and continued generated-GLSL canvas rendering.

### What remains custom

The custom compositor has not been deleted.

It is no longer mounted by the normal `SlideRenderer`. It remains available as an explicit pixel-oriented subsystem, and its existing low-level validation mounts it directly to exercise:

- semantic `SceneSurfaceRef` identity
- retained surface materialization
- regional reuse
- source invalidation
- coherent publication
- failure isolation
- legacy backdrop restoration when explicitly selected

Generated shaders with no scene input remain independent GPU/canvas layers.

Fragment shaders that explicitly request `content` or `backdrop` pixels now cross the explicit `SceneTexture` boundary. The temporary implementation behind that boundary still adapts the current raster/capture machinery.

### Visual semantic change

Normal CSS now follows Chromium exactly.

In particular, opacity on a glass Element is ordinary browser group opacity. The previous resolved-material restoration result `mix(B, R, alpha)` is no longer reproduced for CSS Effects. Depending on stacking context, clipping and alpha, the result can therefore differ from the old custom compositor. This is intentional.

If ShowMe later needs the old or another non-CSS compositing operation, it should be exposed as an explicit advanced pixel/GPU Effect rather than hidden behind normal CSS.

### Performance observation

No frame-time or CPU numbers are claimed from this pass.

The architectural hot path is nevertheless materially smaller: the representative CSS glass case no longer schedules scene-surface builds, retained-prefix invalidations, Canvas backdrop reconstruction, bitmap/raster copies or scene-root mutation observation. Ordinary Motion remains direct DOM transform/opacity work plus Effect CSS-variable timing before Chromium paint.

Local Electron profiling is still required to quantify frame pacing and CPU impact.

### Code that is no longer necessary for normal CSS glass

The following code remains in the repository, but is no longer part of `SlideRenderer`'s normal CSS glass render path:

- `nativeBackdropGroups`
- `restorationPlan`
- `backdropRestoration`
- `compositionSurface` materialization
- `elementRaster` backdrop reproduction
- `createCssBackdrop`

Keeping these modules temporarily is deliberate. They still document and support explicit advanced materialization cases while the browser-native boundary is validated.

### Remaining difficult work

The hard problem is now narrower:

1. define an explicit SceneTexture/flattened-group API for Effects that genuinely require rendered scene pixels
2. decide how explicit scene-input GLSL migrates onto that API without pulling ordinary DOM/CSS back into the compositor
3. validate browser-native CSS and CSS+JS across more nested stacking, mask, blend and media cases
4. profile real editor and audience playback with representative decks
5. remove legacy CSS-specific compositor admission/restoration code once the browser-native contract has enough local validation

The next safest simplification is to delete or shrink legacy capture implementations behind SceneTexture once representative scene-input shaders have enough local pixel validation.



## SceneTexture boundary refactor

Implemented on 2026-10-23 on `experimental/browser-native-renderer`.

The production rendering model is now intentionally three paths:

```text
browser-native
  DOM / CSS / media / text JS / Motion
  -> Chromium

GPU-owned
  generated GLSL and direct shader-to-shader GPU chaining
  -> persistent Effect GPU surface

rendered scene pixels
  explicit fragment input: content | backdrop
  -> SceneTexture
  -> temporary legacy capture adapter
```

### Normal renderer boundary

`SlideRenderer` no longer imports or computes CSS/compositor backend plans. It still uses `CompositionPlan` only as the semantic description of Element DOM ordering, clipping, fill/stroke and Effect nesting. The backend plan, browser-native CSS admission set, restoration plan and custom-alpha eligibility are not normal rendering concerns.

`EffectSurface` no longer accepts a CSS backend mode or compositor dependency list. A CSS definition always mounts scoped CSS. Chromium semantics are canonical.

The canonical Motion/Presence clock is unchanged. `useMotionRuntime` receives no compositor-backend topology from `SlideRenderer`. Ordinary frame sampling continues to write native transform/opacity properties, CSS variables and shader uniforms without React rendering, scene planning or capture.

### SceneTexture API

`sceneTexture.ts` defines the narrow semantic boundary:

- `SceneTextureRequest`: currently `element` or `backdrop`, identified by Element/Effect identity
- `SceneTextureSampling`: requested pixel and logical dimensions
- `SceneTextureProvider.prepare(...)`
- `SceneTextureProvider.acquire(...)`
- `SceneTexture.bind(gl)`
- `SceneTextureProvider.invalidate()`
- `SceneTextureProvider.dispose()`

The consumer receives only a revision and the ability to bind the resulting pixels to a WebGL context. It does not receive a Canvas, DOM clone, primitive raster, capture backend name or compositor surface.

`sceneTextureLegacy.ts` is the temporary adapter. It contains the old implementation knowledge required by explicit scene-pixel shaders: primitive-vs-DOM capture choice, backdrop prefix filtering, dependency flushing, media invalidation, source transforms, retained raster leases and DOM observation. `effectRuntime.ts` no longer imports `elementRaster`, `domRaster`, `cssBackdrop`, `compositionSurface` or `backdropRestoration`.

### Which shaders cross the boundary

- `input: "none"`: does not create SceneTexture. The shader owns its pixels.
- direct compatible shader-to-shader content chaining: stays on the GPU and does not capture the DOM.
- `input: "content"`: currently requests an Element SceneTexture when direct GPU chaining cannot satisfy the input.
- `input: "backdrop"`: requests a backdrop SceneTexture.

The current schema is retained. Architecturally, `content` is now understood as rendered-scene input unless a known owned source can be bound directly. A future image/video direct-texture path can therefore bypass SceneTexture without forcing normal media through capture.

### Remaining MutationObservers

Normal `SlideRenderer`, `EffectSurface`, `effectRuntime` and `useMotionRuntime` do not install a `MutationObserver`.

Observers remain only inside exceptional/legacy capture implementation:

- `sceneTextureLegacy.ts`: moved from the former Effect runtime to invalidate an explicit scene-pixel request when its captured DOM changes
- `domRaster.ts`: maintains the temporary Chromium capture mirror
- `elementRaster.ts`: observes style/environment changes for the legacy primitive raster
- `compositionSurface.ts`: retained legacy compositor validation, not mounted by normal SlideRenderer

These observers are not part of CSS, Motion, Presence, generated GLSL, normal media or text-JS correctness.

### Remaining legacy modules

The CSS backend admission code is now named `legacyCssBackdropValidation.ts`. `compositionRuntime.ts`, `backdropRestoration.ts`, `compositionSurface.ts`, `cssBackdrop.ts` and the legacy capability planner remain for explicit low-level validation only. Normal production rendering does not import or mount them.

`elementRaster.ts` and `domRaster.ts` remain production-reachable only through `sceneTextureLegacy.ts` for explicit rendered-pixel shaders.

### Next deletion candidates

After content/backdrop shader pixel parity is validated locally, the safest next steps are:

1. remove CSS-only legacy backdrop replay and restoration tests/modules that no longer define product semantics
2. shrink the SceneTexture legacy adapter by replacing primitive reconstruction with one capture implementation where practical
3. add direct owned-media texture input so image/video shaders need no SceneTexture
4. delete unused EffectGraph/source-planning code if no other explicit pixel path depends on it
5. keep `compositionPlan` only for semantic DOM/Effect ordering, not renderer-backend selection
