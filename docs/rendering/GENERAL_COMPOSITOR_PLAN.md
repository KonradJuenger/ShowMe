# General compositor plan

Status: design plan only. No implementation in this branch.

Base: `main` after PR #16 (`1778927`).

## Goal

PR #16 established the right semantic direction:

- `CompositionPlan` describes paint order and effect inputs independently of the document format.
- CSS backdrop reads have explicit paint points.
- Motion publishes semantic frame / alpha / Presence samples through a renderer sink.
- Backend selection is centralized.
- Filled/rounded glass can stay native while group alpha is reconstructed by backdrop restoration.
- Restoration now works for both a procedural GLSL background and a static clipped image background.
- `cssBackdrop.ts` remains the conservative correctness fallback.

The next phase should make that system general rather than add more source-specific fast paths.

The target is:

```text
CompositionPlan
    ↓
BackdropPoint / paint point
    ↓
first-class retained scene prefix
    ↓
materialize pixels only when a backend needs them
    ↓
native / restoration / GPU composition / correctness fallback
```

The key architectural rule is:

> A composition backend requests the pixels at a semantic paint point. It must not need to know whether those pixels came from an image, GLSL, shapes, text, CSS, or a combination of them.

This phase should not add another effect-specific compositor.

## Current limitation

The current restoration backend is intentionally bounded, but it still understands specific backdrop producers.

Today the important cases are approximately:

```text
procedural GLSL background
    → obtain Effect canvas
    → build restoration source

static clipped image background
    → find <img>
    → reproduce Fit / Fill / Free transform
    → build restoration source
```

That is already much better than a dedicated optimization for one glass effect, but it does not scale cleanly to:

```text
image + rectangle + GLSL + another image
                    ↓
                  glass
```

or to several independent effects reading different paint points.

The semantic model already knows *where* a backdrop is read. The missing piece is a reusable execution representation of the pixels at that point.

## Desired architecture

### 1. First-class scene-prefix references

A backdrop dependency should not ultimately mean "all earlier EffectRefs".

Introduce a stable renderer-local reference for a semantic paint result, conceptually:

```ts
type SurfaceRef = {
  paintPoint: BackdropPoint;
  revision: number;
};
```

The exact type is an implementation decision. The important property is that multiple consumers of the same paint point can share one retained result.

Conceptually:

```text
S0 = slide background
S1 = S0 + image
S2 = S1 + rectangle
S3 = S2 + shader

glass A reads S3
glass B reads S3
```

Both consumers should reference the same `S3`, not independently rebuild "image + rectangle + shader".

Do not persist these surfaces in the document. They are derived renderer state.

### 2. Generic materialized pixel source

Introduce one backend-neutral abstraction for a materialized prefix / effect output.

Conceptually:

```ts
interface PixelSource {
  revision: number;
  width: number;
  height: number;
  densityX: number;
  densityY: number;

  // One or more of these may be available depending on backend.
  canvas?: HTMLCanvasElement;
  texture?: WebGLTexture;

  crop(bounds: Bounds): Promise<PixelRegion>;
}
```

The concrete API should be smaller if possible. Do not build a speculative framework.

The important boundary is:

```text
backdropRestoration
    asks for pixels at BackdropPoint

NOT

backdropRestoration
    asks "is this a shader?"
    asks "is this an image?"
```

The existing shader output and image renderer should become providers of pixels to the compositor, not special knowledge embedded in restoration.

### 3. Prefix materialization chooses the cheapest source

For a requested scene prefix, materialization should prefer sources ShowMe already owns.

Examples:

```text
generated GLSL
    → existing GPU / Effect output

image
    → decoded asset + canonical media transform

simple shape
    → renderer primitive

several known sources
    → retained composition of those sources

text / arbitrary CSS / unsupported browser paint
    → DOM/capture fallback only where required
```

This does not mean reimplementing the browser in ShowMe.

Native DOM/CSS remains the preferred execution path whenever it is semantically correct. Pixel materialization exists only where another operation actually needs a resolved input.

### 4. Backdrop restoration becomes source-agnostic

The restoration operation itself should stay simple:

```text
B = materialize(backdropPoint)
R = native resolved card
a = semantic group alpha

result = aR + (1-a)B
```

`backdropRestoration.ts` should be responsible for:

- the restoration equation
- cropped output lifetime
- readiness
- Motion sample consumption
- publication / teardown

It should not be responsible for:

- image Fit / Fill / Free rules
- looking up shader Effect canvases
- deciding how shapes are rasterized
- traversing arbitrary DOM
- reconstructing scene-prefix semantics

Those responsibilities belong to the prefix materializer / source providers.

### 5. Backend routing moves toward operations, not whole elements

PR #16 currently chooses routes mostly at element level:

```text
native-group
backdrop-restoration
fallback
```

That is sufficient for the admitted single-material cases.

The general compositor should eventually make decisions at composition-operation boundaries.

Example:

```text
Element
  background CSS       → native
  content shader       → GPU
  overlay material     → restoration
```

Do not force this change before a real mixed case requires it. The first implementation can preserve current element-level routing while introducing the right prefix/source abstraction underneath it.

The important thing is to avoid designing the new source API in a way that makes operation-level routing impossible later.

## Relationship to cssBackdrop.ts

`cssBackdrop.ts` should remain the correctness fallback.

Its role should become narrower over time:

```text
semantic backdrop request
        ↓
known retained sources available?
        ├─ yes → materialize prefix cheaply
        │
        └─ no  → cssBackdrop / DOM capture fallback
```

Do not rewrite `cssBackdrop.ts` first.

Instead, move cases away from it as generic prefix materialization becomes capable of resolving them.

The end state should be:

- native CSS when Chromium semantics are correct
- retained ShowMe-controlled pixels when the input is already known
- GPU composition when explicit pixel operations require it
- DOM/capture fallback only for genuinely browser-owned paint

## Important non-goals

This phase should not:

- change the ShowMe document schema
- add persisted compositor nodes or surfaces
- create a second renderer
- convert arbitrary CSS into GLSL
- replace native text/layout with a custom text renderer
- implement every CSS filter
- remove `cssBackdrop.ts` before its cases have replacements
- optimize one visual effect at a time
- add compatibility for historical document formats
- introduce another Motion clock or animation state machine

Motion should continue to produce one semantic sample.

Effects should continue to use the existing Effect model.

## Implementation sequence

### Phase 1 — establish prefix identity

Extend the composition execution model so a `BackdropPoint` can resolve to a first-class prefix/surface reference.

Keep current rendering behavior unchanged.

Acceptance:

- two effects reading the same semantic prefix resolve to the same prefix identity
- dependency cycles remain impossible
- no document mutation
- existing v1 element-entry versus effect-entry semantics remain unchanged

### Phase 2 — introduce the minimal pixel-source contract

Expose current known outputs through one compositor-facing abstraction.

Start with the sources already proven by PR #16:

- generated GLSL output
- static image/media output

Move image media-frame logic out of `backdropRestoration.ts` into the image/source provider.

Move shader-canvas lookup out of `backdropRestoration.ts` into the Effect/source provider.

Acceptance:

- restoration no longer branches on shader versus image
- existing shader-backed and image-backed regression tests remain pixel-equivalent
- no additional DOM capture occurs

### Phase 3 — compose simple mixed prefixes

Add composition for simple ShowMe-owned sources:

- slide background
- shapes/fills
- static images
- generated GLSL outputs

The test scene should deliberately mix source types:

```text
slide background
+ image
+ rectangle
+ generated GLSL layer
+ second image
        ↓
      glass
```

The glass/restoration implementation must not contain source-type-specific logic for this case.

Acceptance:

- the same restoration backend handles the mixed prefix
- source ordering matches `CompositionPlan`
- shared prefixes are not independently rebuilt per glass consumer
- cropped materialization remains bounded

### Phase 4 — retained prefix reuse and invalidation

Add explicit revision/lifetime handling so unchanged prefix results are reused.

Invalidation should come from semantic source revisions, not MutationObserver scanning when the source is already ShowMe-owned.

Examples:

- Motion of the glass card alone must not rebuild a static backdrop prefix
- changing an image invalidates prefixes after that image
- changing a shader invalidates prefixes after that shader
- unrelated later paint does not invalidate an earlier prefix

Do not overbuild a cache. Retain only results that have actual consumers.

### Phase 5 — route difficult cases to the existing fallback

Integrate the generic prefix materializer with the fallback boundary.

If a prefix contains paint that cannot be represented by current native/GPU/image/primitive providers, the materializer may request the existing DOM/capture path.

This keeps correctness while avoiding special cases in individual consumers.

Only after this is proven should duplicated prefix-reconstruction logic inside `cssBackdrop.ts` be considered for deletion.

## Performance model

The general compositor must avoid turning "general" into "rasterize the whole slide".

Prefer:

```text
semantic prefix
    ↓
shared retained result
    ↓
small consumer crops
```

Avoid:

```text
consumer A → rebuild full slide
consumer B → rebuild full slide
consumer C → rebuild full slide
```

Important properties:

- one materialization per changed prefix revision
- shared results for consumers of the same prefix
- bounded cropped outputs for restoration
- no per-frame DOM capture for Motion-only changes
- no synchronous GPU readback in the animation hot path
- release surfaces when no consumers remain

A future GPU scene-prefix accumulator may become useful, but it should be introduced only when the source abstraction and measurements justify it.

## Correctness model

For any effect reading backdrop at paint point `P`:

```text
materialize(P)
```

must equal the pixels the semantic ShowMe paint model defines immediately before that operation.

This is more important than backend uniformity.

A backend may decline a case and use fallback.

It must not silently approximate ordering, alpha, clipping or paint input.

## Tests for the first implementation

Keep the tests small and semantic.

Required contracts:

1. A shader-only backdrop still matches PR #16.
2. An image-only backdrop still matches PR #16.
3. A mixed image + shape + shader prefix produces correct restoration.
4. Two glass cards reading the same prefix share the prefix result.
5. An unrelated later element does not change that prefix.
6. Updating one source invalidates only dependent prefixes.
7. Motion of the glass consumer does not rematerialize an unchanged backdrop.
8. Unsupported browser-owned paint falls back without changing pixels.
9. Presence entry / replay / cancellation remain coherent.
10. The mandatory audience-navigation gate passes before any rendering-affecting integration into `main`.

Do not add tests for temporary DOM structure unless that structure is part of a real renderer contract.

## Suggested file boundaries

Names are illustrative, not mandatory.

```text
compositionPlan.ts
    semantic paint order and BackdropPoint

compositionBackendPlan.ts
    capability / backend routing

compositionSurface.ts
    SurfaceRef / PixelSource contracts and retained prefix registry

compositionMaterializer.ts
    resolves BackdropPoint → materialized prefix

backdropRestoration.ts
    source-agnostic mix(B,R,a) operation

effectRuntime.ts
    exposes Effect output as a compositor source

media renderer/source
    exposes decoded image pixels with canonical transform

cssBackdrop.ts
    fallback provider for unresolved browser-owned paint
```

Prefer fewer files if responsibilities stay clear.

## Stop conditions

Do not keep broadening this phase indefinitely.

The first coherent milestone is complete when:

- `backdropRestoration.ts` no longer contains image- or shader-specific source reconstruction
- a mixed known-source prefix works through the same generic path
- prefix results are shareable and revisioned
- unsupported paint still falls back correctly
- PR #16's shader and image regressions still pass
- performance does not regress back to repeated full-prefix replay/readback

At that point reassess whether a retained GPU scene accumulator is actually needed.

## Design principle

The compositor should answer:

> What are the pixels at this semantic paint point, and what is the cheapest correct way to provide them?

It should not answer:

> Which special-case renderer do we have for this particular effect?
