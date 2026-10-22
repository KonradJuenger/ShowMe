# General compositor prototype

Status: prototype implemented and verified on `chatgpt/general-compositor-prototype`. This is research code, not a production merge recommendation by itself.

## What the renderer already had

The current renderer already contained most of the semantic pieces needed for a retained prefix.

- `compositionPlan.ts` owns semantic paint order. Its `ScenePrefix` chain is persistent structural data and already excludes the target element from an element-entry backdrop.
- `elementRaster.ts` is the existing ShowMe-owned primitive painter. It can combine slide background, shape fill/stroke, decoded image media using the canonical media DOM transform, child groups, and mounted shader outputs.
- `effectRuntime.ts` publishes an `effectRevision` and exposes mounted Effect surfaces.
- `MotionVisualSample` is the existing semantic Motion boundary and remains the only consumer-animation state.
- `cssBackdrop.ts` already provides the expensive correctness fallback.

The old `backdropRestoration.ts` was the wrong source boundary. It selected shader versus image, looked up Effect canvases, reproduced image Fit/Fill/Free reconstruction, and owned a source canvas. That knowledge now sits behind the compositor/materialization boundary.

The pre-existing `createBackdropRasterSource` is not a retained semantic prefix because it rasterizes in consumer-local coordinates and includes the target transform in its source signature. The prototype therefore uses a slide-space retained surface and crops it per consumer.

## Resulting data flow

```text
CompositionPlan
    |
    v
BackdropPoint
    |
    v
planOwnedPrefixSurface()
    |
    v
PrefixSurfaceRef
  structural identity = ordered semantic source elements
    |
    v
PrefixMaterializer
  retained surface per PrefixSurfaceRef
  source revisions / invalidation
    |
    v
createScenePrefixRasterSource()
    |
    +--> existing elementRaster primitive painter
    |      +--> image pixels / canonical media transform
    |      +--> shapes / fills / strokes
    |      +--> mounted generated GLSL output
    |
    v
MaterializedPrefix { canvas, revision }
    |
    +------------------------+
    |                        |
    v                        v
crop for glass A        crop for glass B
    |                        |
    +-----------+------------+
                |
                v
backdropRestoration
  B = materialized prefix crop
  R = native resolved CSS glass/card
  a = MotionVisualSample alpha
  output = aR + (1-a)B
```

`PrefixSurfaceRef` is renderer-local derived state. It is not persisted into the ShowMe document.

## Prefix identity

A prefix has two separate concepts of identity.

1. Structural identity is the ordered list of semantic source groups before the backdrop point. Inside one `CompositionPlan`, equal ordered owned-source prefixes resolve to the same `PrefixSurfaceRef`.
2. Material revision belongs to the retained source. It increments when those source pixels repaint.

This separation is important. A glass card moving over the same prefix changes neither the prefix structure nor its material revision. An image or GLSL output below the glass can change the material revision without changing structural identity.

For the two-consumer fixture, both glass cards resolve to:

```text
prefix:
  lower image A
  + mixed-rectangle
  + mixed-shader
  + image B
```

The second consumer does not replay those sources independently.

A later element is not part of the semantic prefix. The prototype deliberately changed one old conservative behavior: a later overlapping element no longer disqualifies an earlier glass backdrop. Paint after the backdrop point cannot contribute to the backdrop.

## Generic materialization boundary

`backdropRestoration.ts` now asks the materializer for a `PrefixSurfaceRef` and receives a resolved canvas/revision. It no longer contains:

- image Fit/Fill/Free rules
- media transforms
- shader canvas lookup
- shape painting
- source-type switches

Source-specific knowledge is delegated to the existing `elementRaster.ts` primitive painter and `effectRuntime.ts` output publication.

The prototype uses one retained Canvas2D slide-space accumulator per prefix. Generated GLSL is not read back with `gl.readPixels`; the already-published Effect canvas is composed as a source. Consumer Motion therefore does not require a synchronous GPU readback.

## Supported owned-prefix sources

The prototype-owned path currently accepts:

- slide background
- ordinary shapes, fills and strokes
- decoded static images
- generated fragment GLSL with `input: "none"`
- nested combinations of the above that form a complete prefix

The critical deterministic fixture is:

```text
opaque slide background
image A
rectangle
generated GLSL
image B
glass A
glass B
later unrelated element
```

Both disjoint glass cards consume one retained lower prefix.

## Invalidation results

The materializer observes only source subtrees and Effect-output publication. Consumer Motion is outside that observation set.

Measured from the mixed-prefix Electron fixture:

```text
initial:
  consumers          2
  uniquePrefixes     1
  retained surfaces  1
  materialize calls  1
  builds             1
  reuses             0
  DOM captures       0

later in the same deterministic run:
  materialize calls  20
  builds             8
  reuses             12
  retained surfaces  1
  uniquePrefixes     1
  DOM captures       0
  cssBackdrop        0
```

The targeted invalidation checkpoints were:

```text
build count before direct consumer Motion   5
after consumer Move/Fade sample             5
after later unrelated element change        5
after lower image source change             7
after explicit lower GLSL revision          8
```

The image update produces more than one dirty notification because changing `src` and completing decode/load are separate browser events. The important retained behavior is that those notifications still rebuild the single shared prefix, not one copy per consumer.

A continuously running source shader is different from consumer Motion. Advancing the slide runtime legitimately publishes a new shader revision and can rebuild the prefix. Tests therefore isolate the “Motion-only” invariant with direct semantic `MotionVisualSample` updates.

## Motion result

There remains one Motion state.

The prototype does not add compositor clocks, DOM transform sampling, requestAnimationFrame delays, or timeouts. Move In/Fade remains sourced by `MotionVisualSample`.

The glass restoration overlay uses the current semantic frame/alpha while the prefix surface remains independent of that consumer state. The existing final-frame continuity tests continue to pass, including the transition from partial restoration alpha to fully native resolved CSS paint.

## Fallback boundary

`cssBackdrop.ts` was not rewritten. It remains the correctness fallback when the owned-prefix materializer cannot prove the requested pixels.

The current prototype declines or leaves on the existing fallback route at least these cases:

- deck-level stylesheet interactions that make native paint difficult to reproduce safely
- text as a prefix source
- video as a prefix source
- CSS classes on source elements
- CSS source effects
- text-JS source effects
- fragment shaders that require `content` or `backdrop` input rather than generated `input: "none"`
- incomplete/partial prefixes through an ancestor
- overlapping restoration consumers whose own resolved glass could contribute to a later consumer
- restoration consumers outside the existing safe glass topology, such as unsupported transforms, nesting or effect stacks

These are prototype admission limits, not claims that Canvas2D cannot eventually handle all of them. Text/CSS in particular are good candidates to remain browser-owned and use capture only at the unresolved scene-prefix operation.

The known-source mixed fixture produces no `cssBackdrop` output and no DOM capture.

## Verification

Focused compositor verification on the prototype candidate passed:

```text
tests/feature/effects/native-composition.spec.ts
12 passed
```

The headless Linux sandbox required Chromium SwiftShader launch flags to expose WebGL2. Without those flags the renderer correctly reported that WebGL2 was unavailable, so GLSL assertions were not meaningful. The flags were used only in the ephemeral test harness and were not committed to ShowMe.

Static checks also passed:

```text
npm run typecheck
focused ESLint on changed implementation/test files
npm run test:stats
npm run test:audit
```

## What was learned

1. **Can ShowMe represent semantic scene prefixes cleanly?** Yes. The existing `CompositionPlan` is already the right structural authority. No second scene graph was required.

2. **Can different source types feed one generic prefix?** Yes for the prototype set. Image, shape and generated GLSL all feed the same retained surface through the existing primitive rasterizer.

3. **Can consumers share the same prefix?** Yes. Two glass consumers used one `PrefixSurfaceRef`, one retained surface and one initial build.

4. **Can invalidation remain local?** Yes at the architectural level. Consumer Motion and later paint do not rebuild the prefix; source changes do. Browser resource events may issue multiple dirty notifications and could be coalesced later.

5. **Can restoration become source-agnostic?** Yes. The prototype restoration module no longer knows image/shader/shape source semantics.

6. **Can `cssBackdrop.ts` naturally become a fallback provider?** Yes. Nothing in the generic path requires it to be the primary representation. Unsupported prefix operations can fall through to the existing capture route.

7. **Is Canvas2D sufficient for the retained prefix?** Sufficient for this architecture prototype. It proves identity, sharing, invalidation and mixed-source composition without a retained GPU scene graph. This does not yet prove that Canvas2D is the final performance representation for continuously changing shader-heavy scenes.

8. **Does this make CSS + GLSL + images feel like one renderer?** Structurally, yes. CSS glass remains native CSS while its incoming backdrop is represented as a semantic prefix whose source types are hidden behind one materialization boundary.

## Production recommendation

Develop this direction further rather than discard it.

The useful production abstraction is small: semantic prefix identity plus a reusable materialization boundary. Do not promote the prototype into a large retained compositor framework yet.

Before productionizing it:

- formalize the source/pixel-density contract rather than leaving it implicit in a canvas
- decide how browser-owned text/CSS joins the prefix as a fallback provider
- coalesce noisy resource invalidations
- make retained-surface lifetime/eviction explicit
- add diagnostics that distinguish source-clock rebuilds from structural invalidation
- measure continuously animated GLSL scenes before deciding whether the retained representation should stay Canvas2D or move to GPU textures
- preserve the current rule that restoration remains a consumer of pixels, never the owner of source semantics

The prototype does not provide evidence that a full persistent GPU scene graph is necessary.
