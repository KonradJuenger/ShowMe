# General compositor foundation

Status: corrected implementation on `chatgpt/general-compositor-fix`, based on
the prototype at `407e70d0ec73493dc565c47ba1b92ff1ff1e4a3b`.

This branch does not broaden the set of source types. It corrects the abstraction
under the prototype so retained pixels can become shared renderer infrastructure
without weakening ShowMe's semantic paint model.

## Core model

The compositor remains hybrid:

- native DOM/CSS where the browser is the correct representation
- retained ShowMe-owned pixels where ShowMe can reproduce the source exactly
- existing GPU Effect outputs reused by the primitive painter
- existing DOM/capture behavior as correctness fallback for unresolved paint
- one document model, one Effect model and one Motion/Presence timing model

No compositor scene graph, animation clock or persisted surface was added.

`CompositionPlan` remains the authority for semantic paint order. It now exposes
an exact renderer-local `SceneSurfaceRef` for a `BackdropPoint`.

```text
CompositionPlan
    |
    +--> element-entry
    |      exact scene immediately before an Element
    |
    +--> effect-entry(elementId, effectId)
           exact paint immediately before that Effect
```

The surface identity contains the semantic point, the persistent structural
prefix and the ordered Effect paint dependencies at that point. It is
renderer-independent and does not depend on mounted DOM order.

Two CSS backdrop Effects in one Element therefore cannot collapse merely because
the same external Elements precede both. If Effect B is painted after Effect A,
B's surface records A in its paint prefix while A's surface does not.

The current Canvas2D provider intentionally materializes complete
`element-entry` surfaces only. Exact `effect-entry` refs are available to
future consumers, but unresolved internal Effect paint falls back rather than
being approximated.

## Semantic identity versus regional optimization

A semantic surface always describes exact ordered paint. Crop or overlap
information never changes that identity.

```text
SceneSurfaceRef
  exact ordered paint
        |
        v
MaterializeRequest
  surface
  + logical region R
  + explicit density
        |
        v
backend/provider
  may cull paint only when the caller proves it irrelevant to R
```

The existing disjoint-glass optimization is implemented at this lower layer.
Glass A and glass B can have different semantic surfaces while the provider
reuses one retained execution projection if the backend has proven that A cannot
intersect B's requested region. The semantic refs remain distinct.

## Renderer ownership and lifetime

`compositionRuntime.ts` owns one `SceneSurfaceMaterializer` for the active
composition runtime and passes the service to `backdropRestoration.ts`.

The materializer owns:

- provider selection
- retained execution surfaces
- source revisions
- invalidation
- publication
- reuse
- lifetime and disposal

A consumer owns:

- the exact `SceneSurfaceRef` it needs
- the logical region it needs
- how those pixels are combined with its output

The runtime exposes the same materializer service, so another compositor consumer
can request the same surface without creating a restoration-specific cache.

## Materialization contract

A request is spatial and density-explicit:

```text
MaterializeRequest
  surface: SceneSurfaceRef
  region: { x, y, width, height } in slide coordinates
  density: { x, y }
```

A result carries:

```text
MaterializedSurface
  surface
  source
  revision
  logicalBounds
  density
  pixelSize
```

Consumers do not infer scale from `canvas.width / deck.width`.

The source is backend-tagged. Today the owned provider publishes a Canvas image
source. The contract can later return a GPU texture without changing
`CompositionPlan` or semantic surface identity.

The current Canvas2D implementation still retains a full-slide execution surface.
That is an implementation choice only. Regional allocation/caching can replace
it later without changing callers.

## Source providers

Capability detection and execution are behind the same small
`PixelSourceProvider` boundary. This prevents a separate
`supportsOwnedElement()` table from drifting away from the actual painter.

The current owned provider accepts approximately:

- slide background
- rectangle/ellipse fill and stroke
- static image content using the canonical media transform
- nesting and clipping already supported by the primitive painter
- generated fragment GLSL with `input: "none"`

It conservatively declines:

- text
- video
- arbitrary CSS classes
- CSS Effects
- text-JS
- fragment GLSL requiring `content` or `backdrop`
- unresolved partial ancestor prefixes
- internal effect-entry paint the provider cannot reproduce exactly
- any other browser-owned paint it cannot prove equivalent

Those cases retain the existing correctness fallback.

## Invalidation flow

Retained scene surfaces use one renderer-root invalidation path rather than one
broad observer per retained prefix.

```text
source DOM / resource / Effect output changes
        |
        v
renderer-level source signal
        |
        v
source Element identity
        |
        v
dependent retained projections marked dirty
        |
        v
materializer rebuilds changed source revision
        |
        v
dependent consumers publish the new revision
```

The owned scene-prefix raster disables its older environment observer when used
through this materializer. Legacy raster callers retain their existing
conservative observation behavior.

Later unrelated paint is not a dependency of an earlier semantic surface and
does not dirty it. A lower image/style change or generated Effect-output revision
does.

## Coherent publication

The reviewed prototype had an asynchronous stale-frame window:

```text
source DOM changes
  -> prefix repaints
  -> createImageBitmap crop is pending
  -> old restoration pixels remain visible
```

The corrected path no longer depends on asynchronous `createImageBitmap()`
publication for retained restoration pixels.

The mutable primitive raster is copied synchronously into a fresh Canvas2D
snapshot. The materializer swaps the published revision only after that snapshot
is complete. Restoration then copies the requested crop from that published
snapshot into its visible canvas and presents after the materialized revision is
available.

For source Motion, the DOM write, mutation delivery, retained rebuild and
restoration publication settle through the existing renderer/readiness flow. No
second Motion sample, animation clock, interpolation path or computed-style
animation read was added.

The compositor may keep the previous complete published revision while a source
resource itself is not ready. It does not label an old retained snapshot as the
new source revision.

## Backdrop restoration

`backdropRestoration.ts` remains source-agnostic.

It consumes only:

- the semantic backdrop surface
- a requested region
- published source pixels/revision
- the consumer's existing `MotionVisualSample`
- the native resolved material

It still implements the established restoration equation:

```text
B = incoming scene
R = native resolved material at opacity 1
a = canonical Motion group alpha

output = aR + (1-a)B
```

For this group-alpha operation, B is the Element-entry scene before the entire
resolved Element. The CSS Effect's own effect-entry backdrop point remains
separately modeled by `CompositionPlan`.

Restoration contains no image Fit/Fill logic, media transforms, shader lookup,
GLSL knowledge, shape traversal or source-specific invalidation.

## Sharing

Semantic and execution sharing are separate.

- Repeated requests for the same exact `SceneSurfaceRef` reuse the same
  materializer entry and published revision.
- Different consumer implementations can use the renderer-owned materializer
  rather than creating their own cache.
- Different semantic surfaces can reuse one execution projection only after a
  backend supplies a safe regional irrelevance proof.
- Region differences do not alter semantic identity.

## Failure isolation

Failure state is owned per semantic surface at the consumer boundary.

If semantic surface A cannot be materialized, only consumers depending on A are
disabled and returned to the existing fallback route. Consumers using independent
surface B remain operational. A failed request does not globally reject every
restoration consumer.

## Data flow

```text
document / Effects / Motion
        |
        v
CompositionPlan
  exact semantic paint order
        |
        v
SceneSurfaceRef
        |
        v
CompositionRuntime
  one SceneSurfaceMaterializer
        |
        +--> PixelSourceProvider
        |      +--> primitive Canvas2D painter
        |      +--> decoded image / canonical transform
        |      +--> existing generated GLSL output
        |
        +--> published revision
               |
               +--> backdrop restoration
               +--> future GLSL backdrop input
               +--> future capture fallback
               +--> future export consumer

unsupported exact paint
        |
        v
existing correctness fallback
```

## Regression contracts

The branch adds or strengthens tests for these contracts:

1. Two different effect-entry points in one Element do not collapse when their
   paint prefixes differ.
2. Semantic surface identity is independent of consumer crop.
3. Repeated and independent consumers can reuse one renderer-scoped retained
   materialization.
4. A lower owned source change publishes a coherent restoration revision with no
   asynchronous bitmap-publication gap.
5. Failure of one semantic surface leaves an independent surface usable.
6. Multiple requests for one surface build once and reuse.
7. Later unrelated paint does not invalidate an earlier surface.
8. Lower source mutation does invalidate dependent retained paint.

Existing native-composition coverage continues to protect first-frame readiness,
Presence replay/cancellation, image-backed restoration, mixed owned prefixes,
regional backend selection and fallback boundaries.

## Decision standard

1. **Can two different effect-entry points inside one Element resolve to the
   same `SceneSurfaceRef` when their paint differs?** No. The point and ordered
   paint dependencies are part of the structural key. The composition-plan
   regression creates two same-Element CSS backdrop Effects and verifies distinct
   refs and prefixes.

2. **Is a semantic surface independent of the crop requested by a consumer?**
   Yes. Region exists only on `MaterializeRequest`; it is not part of
   `SceneSurfaceRef`. Native-composition materializer tests request different
   regions from the same ref and verify reuse.

3. **Can unrelated consumer implementations share one retained
   materialization?** Yes. The materializer belongs to `CompositionRuntime`,
   is exposed as a service, and sharing is tested through independent requests
   outside restoration's private implementation.

4. **Can lower-source Motion expose pixels from an older retained revision as
   the new composition revision?** No. Publication uses a complete synchronous
   snapshot and increments the visible retained revision only with that complete
   snapshot. The source-change regression holds the legacy async bitmap primitive
   and verifies that the coherent painted frame does not depend on it.

5. **Does one source failure affect only consumers depending on that source?**
   Yes. Restoration tracks failed semantic surface IDs independently, and the
   failure-isolation regression verifies an unrelated retained surface remains
   usable.

6. **Is `backdropRestoration.ts` source-agnostic?** Yes. Source capability,
   resource preparation, primitive paint and invalidation live in
   `compositionSurface.ts` / `elementRaster.ts`.

7. **Can the materialization API later use a GPU texture instead of Canvas2D
   without changing semantic planning?** Yes. `MaterializedSurfaceSource` is
   backend-tagged and `SceneSurfaceRef` has no renderer representation.

8. **Does the architecture still use one canonical Motion/effect timing
   model?** Yes. Restoration consumes the existing `MotionVisualSample`;
   Effect timing remains in the existing Effect runtime. No compositor clock or
   parallel Motion state was introduced.

## Intentionally deferred

This branch deliberately does not add:

- text materialization
- video materialization
- general CSS capture as a new materializer provider
- a retained GPU scene graph
- arbitrary overlapping glass support
- new Effects
- export integration
- document schema changes
- historical compatibility paths

Canvas2D remains sufficient for the corrected foundation and current owned-source
scope. Continuously animated shader-heavy scenes may later justify a GPU retained
implementation, but that is a backend decision rather than a semantic rewrite.
