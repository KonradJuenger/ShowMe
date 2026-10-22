# General compositor prototype

Status: implementation research on `chatgpt/general-compositor-prototype`.

## Phase 1 code findings

The current renderer already contains most of the semantic pieces needed for a retained prefix.

- `compositionPlan.ts` owns semantic paint order. Its `ScenePrefix` chain is persistent structural data and already excludes the target element from an element-entry backdrop.
- `elementRaster.ts` is the existing ShowMe-owned primitive painter. It can combine slide background, shape fill/stroke, decoded image media using the canonical media DOM transform, child groups, and mounted shader outputs. This is a better source boundary than teaching restoration about those types again.
- `effectRuntime.ts` publishes an `effectRevision` and exposes mounted effect surfaces. Those revisions can invalidate a retained prefix without a second animation clock.
- `MotionVisualSample` is already the correct consumer-motion boundary. Prefix identity must therefore be independent of the glass consumer's animated transform and opacity.
- `backdropRestoration.ts` is the wrong current boundary: it selects shader versus image, looks up effect canvases, reproduces media transforms, and owns a full source canvas.
- `cssBackdrop.ts` should remain untouched as the fallback path.

The existing `createBackdropRasterSource` is not the retained prefix we need. It rasterizes in consumer-local coordinates and includes the target world transform in its source signature. Moving the consumer therefore changes the source identity. The prototype instead needs one slide-space surface per semantic prefix revision, followed by consumer crops.

## Smallest prototype boundary

```text
CompositionPlan
    |
    v
BackdropPoint
    |
    v
PrefixSurfaceRef ------------------------------+
    |                                         |
    v                                         |
PrefixMaterializer                            |
    | owns one retained slide-space canvas    |
    | per prefix identity                     |
    v                                         |
MaterializedSurface { canvas, revision }      |
    |                                         |
    +--> crop for glass A                     |
    +--> crop for glass B                     |
                                              |
MotionVisualSample ---------------------------+
    |
    v
backdropRestoration: output = aR + (1-a)B
```

`PrefixSurfaceRef` is renderer-local derived state. It is not persisted. Equal ordered source prefixes share the same reference inside one `CompositionPlan`, even when multiple disjoint restoration consumers occur after that source prefix.

The materializer delegates actual source painting to the existing primitive raster path. Source-specific knowledge stays there. Restoration receives only a materialized surface and crops it.

## Prototype capability

The first owned-prefix provider accepts ShowMe-controlled paint that the primitive raster path can resolve without browser capture:

- slide background
- shapes/fills/strokes
- static decoded images
- generated GLSL surfaces
- nested combinations of those

It declines browser-owned or dynamic cases that are not proven in this prototype, including CSS/text-function source effects and video. Declined prefixes remain on the existing fallback route.

For multiple restoration consumers, an earlier restoration consumer may be omitted from a later consumer's prefix only when their conservative paint envelopes are disjoint. That permits both consumers to share the same lower prefix without changing pixels in either requested crop.

## Revision and invalidation model

A retained surface has two identities:

1. structural identity: ordered semantic source groups at the paint point;
2. material revision: increments only when those sources repaint.

The materializer observes only mounted source subtrees and effect-output publication. Consumer Motion is outside those subtrees, so Move/Fade does not dirty the prefix. A later unrelated element is not part of the structural prefix and therefore cannot dirty it. A changed earlier image/style/effect output marks the retained source dirty and produces a new material revision on the next flush.

The prototype intentionally keeps one Canvas2D slide-space accumulator per retained prefix. It does not add a persistent GPU scene graph. The existing GLSL canvas is drawn as an owned source, so no explicit `readPixels` is introduced in the Motion path.

## What remains unchanged

- document schema and persistence
- `CompositionPlan` paint semantics
- one `MotionVisualSample` stream
- native CSS rendering for the glass/card
- restoration equation and readiness/publication ownership
- `cssBackdrop.ts` fallback
- effect clocks and effect execution

## Decision criterion

Canvas2D is sufficient for the prototype if one materialized prefix can be reused by both glass consumers and remains stable through consumer Motion. If shader-heavy source changes make the Canvas2D transfer itself the dominant hot-path cost, that is evidence for a retained GPU surface later. It is not a reason to move source knowledge back into restoration.
