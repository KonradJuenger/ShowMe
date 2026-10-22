# Ordered composition and native lowering

Updated 2026-10-22. Derived paint order, semantic render samples, centralized
backend selection and renderer-owned composition outputs. Earlier measurements
below retain their original revision and scope.

## Current verification: 2026-10-22

Image-background follow-up, renderer `229bffc`: the supplied image deck selected
the fallback route because restoration admitted only a full-slide shader. A fixed
geometry probe changed the final consumer's alpha from 0.999999 to 1; releasing
fallback material changed earlier panels by maximum RGB 110/131. Their native
material therefore did not match the replay at the completion handoff. Static
clipped images now feed the existing restoration operation, removing that handoff
without changing native card paint or the unsupported-case fallback.

The new named image regression verifies first-frame readiness, independent source
placement/content alpha with rotated/flipped media, near-finish continuity, exact
static native reference, replay, output resizing and cancellation. The native
selection command below passed all 11 declarations; its image declaration passed
again after adding the resize assertion. The same browser selection passed all
26 declarations, including both audience-navigation tests. Registry-selected
effects/Motion units passed 138 declarations; build, typecheck, changed-file ESLint,
stats/audit (642 active tests) and whitespace checks passed.

The real image-deck finish filmstrip was reviewed without the flash: 614 visible
partial-alpha observations had populated restoration and matching inverse alpha,
and no CSS replay output. All three production lifecycle modes retained
`native-backdrop-restore`, no missing assets and no effect errors. Cold entry
retained one 110 ms rAF gap. The
[image follow-up evidence](evidence/image-background-restoration-2026-10-22.json)
records the probe, source/build digests and timing provenance. Earlier results
below describe the original procedural-background workload.

Renderer `506fd7c` follows semantic coordination commit `cba8c57`. Proven local
CSS omits unnecessary backdrop dependencies; unknown, escaped and external styles
remain conservative. Regional admission checks descendant effects before treating
a clipped subtree as bounded. The shared shader presentation buffer is reused
for smaller outputs, copies only the active rectangle and releases to 1×1 when
the last output is disposed. Independent multi-scale gradient pixel tests verify
orientation, alpha and idle release; existing context-loss tests also pass.

Final Windows verification:

- `SHOWME_TEST_FILES='["tests/feature/effects/native-composition.spec.ts"]'; npx playwright test --config playwright.electron.config.ts`: 10 passed, including first-frame readiness, current-sample placement, replay, ordinary opacity and cancellation.
- `SHOWME_TEST_FILES='["tests/feature/effects/css-backdrop-opacity.spec.ts","tests/feature/effects/mixed-compositing.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]'; SHOWME_TEST_PORT=5181; npx playwright test --config playwright.config.ts`: 26 passed, including both audience-navigation declarations.
- Registry-selected active effects/Motion unit files, `npx vitest run`: 138 passed across 14 files. `npm test`: 15 core tests passed.
- `npm run build`, changed-file `npx eslint`, `npm run test:stats`, `npm run test:audit` and `git diff --check`: passed; 641 active tests.

The final original slide-4 filmstrip shows no entrance flash. All 140 visible
partial-alpha observations had populated restoration and matching inverse alpha
(tolerance 0.00001). Three cropped outputs total 311,386 pixels at the probe scale,
versus 4,005,540 pixels for three full-source copies; the shared source remains
1,335,180 pixels. The route remains `native-backdrop-restore`.

[Compact evidence](evidence/composition-coordination-2026-10-22.json) and
`areweslowyet.md` record production timing and provenance. Cold entry retains
occasional longer gaps. Full/release, packaging, macOS and explicit export visual
checks were not run. Document ownership, persistence, v1 formats and fallback
correctness remain unchanged. No main integration.

## Model

An Element is a visual group with an independent transport matrix and one final
group alpha. It consumes an incoming scene and produces an ordered visual result.
The plan is derived from the current v1 document; it is never persisted and owns
neither document changes nor animation time.

`compositionPlan.ts` compiles these operations:

- `source`: intrinsic text/media; media retains its own frame and content alpha.
- `children`: recursively composed child groups, in scene order.
- `fill` and `stroke`: authored appearance at their existing paint points.
- `clip`: the existing rounded overflow scope; the stroke remains outside it.
- `effect`: an existing Effect instance and its exact local input operation.
- `sequence`: ordered paint operations; it implies no intermediate allocation.

The compiler deliberately preserves v1 ordering. Text JS evaluates before layout.
CSS content stages initially wrap text/media/children. At the first content-input
shader, the input expands to the whole base visual, including fill, background,
children, overlay and stroke. Later content stages wrap that accumulated result.
Background and overlay lanes preserve authored relative order; they are layers,
not automatic shader chains. Editing bypasses only the edited element's content
pipeline.

`SlideRenderer` lowers this plan into the existing DOM. `EffectGraph` receives
explicit element/instance input identities instead of rediscovering those scopes
from DOM containment. Instance identities remain element-scoped. Mounted effects
replan after dependency/resource changes, without requiring a remount solely to
refresh a dependency edge. Standalone Effect previews retain their existing
mounted-DOM adapter when no scene plan is supplied.

Scene prefixes use persistent links to complete earlier groups and unfinished
ancestor scopes. Indexing stores O(elements) structural state. The primitive and
DOM capture adapters project their existing element-shaped input from this same
plan. GLSL backdrop input retains the v1 **element-entry background lens** rule,
including saved overlay placement coercion. Its input excludes its own source and
completed ancestor outputs; those would depend on the consumer itself. CSS names
its own effect-entry paint point. A persistent operation-prefix index records
completed scene and ancestor paint at that point, excluding unfinished enclosing
effects. Foreground dependencies remain separate from that backdrop prefix.
The semantic input is `styled`, not a `native` backend choice. These references
do not change the persisted v1 ordering.

## Runtime ownership and backend selection

`legacyCssBackdropValidation.ts` selects native group, bounded restoration or fallback
per material. `compositionCapabilities.ts` owns scoped declaration parsing,
declaration capabilities and one tested engine capability table. Native and
restoration routes do not construct the fallback capture/observer machinery.
Fallback capture can retain its own implementation-specific optimizations, using
the same declaration capabilities.

Motion publishes its completed semantic frame (frame geometry, group alpha and
Presence) through `MotionRenderSink`; it imports no compositor or backend registry.
The same resolved sample drives Motion's DOM transport writes and the renderer.
The restoration backend never reconstructs animated state with computed styles
or world-transform DOM reads. A retained input sample supports asynchronous
publication; it has no clock or interpolation logic. The hidden DOM alpha proxy
has been removed.

`SlideRenderer` owns the paint wrapper, restoration sibling and canvas. Presence
owns the outer element's visibility/content visibility; resource readiness owns
only the inner paint wrapper. A backend cannot override Presence's fields.
`compositionRuntime.ts` owns activation/disposal and the renderer sink, while the
generic `compositionReadiness.ts` lets Effect execution await output preparation
without importing a particular backend.

Regional admission uses swept paint bounds. A bounded image, clipped subtree or
ordinary translation elsewhere does not globally disable unrelated restoration.
An overlap rejects the affected materials. Native text ink is checked once after
fonts are ready and font changes reject only affected regions. Unknown paint that
can escape a model bound (for example arbitrary external CSS) remains a
conservative veto; regional admission does not assume such paint is local.

## Native visual group

When the CSS backdrop stage's original prefix and bounds equal the group's entry
prefix and bounds, the native lowering can put backdrop filtering and group alpha
on one visual node while leaving geometry/transport on the canonical element node.
Motion binds alpha to that visual node and transport to the element node. Ordinary
tracks, exact seeks, Presence samples and cancellation use those same values and
restore both owners. The Presence recipe and lifecycle are unchanged.

Admission is conservative:

- One content CSS stage with a constant scoped declaration; no intervening
  authored fill, rounded geometry, unknown sizing/mask/blend/filter operations,
  dynamic CSS values or external stylesheet.
- No ancestor effect, authored ancestor alpha or scheduled ancestor alpha/Presence
  boundary that would hide the required external scene during the interval.
- No descendant effects or authored classes whose dependencies are opaque to
  this lowering. Native text/media and ordinary children keep their normal paint.
- Matching supported compositor behavior, rather than syntax support alone.

Rejected cases use the retained correctness fallback. There is no per-descendant
alpha multiplication, no altered Move In recipe and no blanket CSS-filter hoist.
Background/overlay placements keep their existing order. Rounded and filled cards
remain outside this filter-hoisting lowering. A separate bounded restoration
operation below preserves their original native paint order.

## Filled, rounded glass: backdrop restoration

The real card paints authored fill, then the CSS backdrop stage and its children,
inside an enclosing rounded overflow clip. The ShowMe stroke is outside that clip;
the entire result then receives group alpha and transport. Hoisting the filter
past the fill changes its input: filtering `B overlaid with fill` differs from
overlaying fill on `filter(B)`. The rounded fill also changes samples near corners.
Removing the CSS border and shadow did not remove that mismatch.

Radius has a separate ownership problem. An outer rounded clip around the
filter/alpha owner preserved the empty rounded card exactly in the independent
probe. Putting the clip inside that owner, or changing the filter to rectangular
bounds, changed antialiased corner coverage. A low whole-card mean therefore did
not establish equivalence. The [probe](evidence/native-filled-rounded.mjs) records
card, edge and interior errors, including maxima. Keeping the filtered material
under an ordinary alpha wrapper preserved the static image but failed the fade.

The missing operation is backdrop restoration, rather than another filter hoist.
Resolve the original card natively at opacity one, producing R. Overlay its
incoming opaque backdrop B at opacity `1 - alpha`. Source-over then gives
`alpha * R + (1 - alpha) * B`: one resolved-group fade, including overlapping
children, tint, border, shadow and rounded-edge coverage. The card's original fill,
filter and clips stay in place. Motion sends alpha to the renderer sink; the
element node continues to own transport and keeps native opacity one.

Restoration images stay in slide coordinates as siblings immediately after their
card. A rectangular clip follows the moving card with a small output-pixel outset.
It does not clip at the rounded boundary. This matters: a canvas inside the rounded
clip changed coverage, and inverse-transforming a canvas inside the moving card
introduced another sampling phase at fractional display density. Neither variant
met the strict pixel contract. The slide-coordinate restoration passed unchanged
static output and resolved Move In pixels at the machine's fractional DPR.

Admission is intentionally narrow: the verified Electron engine, an opaque slide
background, one full-slide procedural background shader or one static clipped
image (which may cover only part of the slide), flat cards with one
constant CSS material and static children, and bounded translation/fade Presence.
Swept card bounds must be disjoint. Other shape paint and native text ink must not
contribute to a restoration rectangle; text bounds are checked after fonts are
ready and again when fonts load. Thus the same background snapshot is the exact
incoming scene within each restoration rectangle. Earlier cards are culled by
that proof, not reconstructed per consumer. Native backdrop filtering still sees
all actual lower paint, including paint outside the restoration rectangle.

Static image sources use the native media model's canonical Fit/Fill/Free frame,
including content opacity, cropping, rotation and flips. The image must be decoded
before restoration publication. Output density comes from the renderer's existing
render profile, without per-frame layout measurement. Image sources use the same
cropped outputs, readiness gate, Motion samples and teardown as shader sources.
The real card stays native throughout the fade and at alpha one, avoiding a
fallback-material/native-filter handoff at Move In completion. Moving backgrounds,
video, unbounded image paint and image effects remain outside this admission.

This is not a general retained compositor. Overlapping envelopes, nested alpha,
mixed effect stacks, unsupported motion/CSS and unknown engines retain the
existing lowering. Bounded media elsewhere is regionally admitted. Static export
keeps its existing route. The document model,
Presence recipes and authority/persistence path are unchanged.

Snapshot publication follows the effect cohort and participates in audience
readiness. It uses the existing shader output and GPU-backed bitmap publication;
there is no DOM backdrop capture, primitive replay, custom blur or CPU pixel read
in this operation. One scene source feeds pixel-grid-aligned cropped images for
the materials' swept regions. The existing audience-readiness flush prepares all
admitted crops before their entrance, including currently absent cards. These
small images remain resident for replay and are released at renderer disposal.
An unchanged background revision does not republish them for Motion-only changes.
The 256 MiB logical RGBA limit covers the shared source and cropped current/pending
images rather than a full-frame image per material. Optional-capability or preparation
failure restores the existing backend and rebinds Motion at its current time.

The Electron contract covers the actual filled/rounded CSS style over a GLSL
background, strict maximum RGB error of two for static/fade images, actual Move In,
overlapping translucent children, cancellation, 1/3/10 disjoint consumers, and
rejection of 3/10 overlapping consumers. Existing parent/nested and mixed handoff
contracts remain separate. The production-build performance record is below;
synthetic pixel tests alone are not performance evidence.

The 2026-10-22 contracts additionally cover regional selection with unrelated
image/translation and overlapping paint, pre-entry crop preparation, replay,
renderer disposal, ordinary opacity, and a composition update with animated DOM
reads prohibited. Composition tests verify CSS effect-entry references and
completed ancestor dependencies while retaining the v1 GLSL entry contract.

Reproduce the independent topology probe:

```powershell
node docs/rendering/evidence/native-filled-rounded.mjs
node docs/rendering/evidence/native-filled-rounded.mjs --no-border-shadow
```

The [compact pixel record](evidence/native-filled-rounded-2026-10-21.json) contains
the measured card/edge/interior maxima and the probe digest. In the filled rounded
case, the best filter-hoisting topology still had maximum static RGB error 10;
removing border/shadow did not make it exact. Restoration had static error zero
and maximum fade error 1.5 in the independent DPR-1 probe. The application tests
also passed at Windows fractional DPR with actual Move In.

Restoration verification on Windows:

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/effects/native-composition.spec.ts"]'
npx playwright test --config playwright.electron.config.ts
$env:SHOWME_TEST_FILES='["tests/feature/effects/css-backdrop-opacity.spec.ts","tests/feature/effects/mixed-compositing.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]'
$env:SHOWME_TEST_PORT='5181'
npx playwright test --config playwright.config.ts
```

All six Electron and 25 browser declarations passed, including both unchanged
audience-navigation declarations, parent/nested fades and the PR #4 GPU handoff,
context-loss and intervening-CSS contracts. The active effects unit selection
passed all 102 declarations; `npm test` passed 15. `npm run build`, changed-file
ESLint, `npm run test:stats`, `npm run test:audit` and whitespace checks passed.
The registry contains 634 active tests. Full/release, packaging and macOS checks
were not run. No integration into `main` is part of this change.

## Native engine evidence

The same-node backdrop/group-opacity operation is observably different across
the two installed engines. The independent
[probe](evidence/native-group-alpha.mjs) uses a stationary CSS stripe background,
translucent foreground and no ShowMe renderer. It compares the faded screenshot
with `0.5 * full + 0.5 * backdrop` over the full 640 × 360 viewport at matched DPR 1.

| Engine | Mean absolute RGB error, 0–255 | Maximum error |
| --- | ---: | ---: |
| Electron 44.4.1 / Chromium 152.0.7977.78 | 0.0745 | 0.5 |
| Playwright Chromium 153.0.8010.12 | 1.6675 | 19 |

The actual SlideRenderer/Move In candidate also failed the Chromium 153 pixel
comparison (whole-image MAE about 2.18), while its Electron pixel contract passed.
No tolerance was relaxed to enable that route. Native admission currently accepts
the tested Electron/Chromium 152 engine family; unknown engines keep the fallback.
An engine upgrade must run the native pixel contract before changing admission.
This is a conservative capability boundary, not a new document behavior.

The registered Electron contract compares the lowered static image with the
original filter topology, verifies real intermediate Presence alpha and transform,
checks resolved-fade pixels including overlapping translucent children, confirms
zero completed DOM captures/prefix replay, and verifies cancellation restoration.
The companion contract exercises parent-alpha, rounded and filled fallback cases.
These are correctness observations, not production performance benchmarks.

Run the independent probe from the repository root:

```powershell
node docs/rendering/evidence/native-group-alpha.mjs
node docs/rendering/evidence/native-group-alpha.mjs electron
```

## Contextual groups and retained surfaces: remaining phases

A group containing an external backdrop consumer is context-dependent, not
necessarily a reusable transparent sprite. For incoming scene B, the intended
group-alpha contract is `mix(B, Resolve(group, B), alpha)`, with children resolved
using earlier internal paint and external context before the containing alpha.
Nested groups apply that rule recursively. An explicit compositor must publish
replacement coverage for a result containing B; source-over of that bitmap would
paint the lower scene twice. Transparent export needs RGBA/coverage validation.

This PR establishes the ordering/input model and native binding boundary. It
does **not** implement a general retained GPU scene-prefix accumulator or eliminate
the existing fallback's repeated prefix work. Native browser composition remains
the normal path where it already represents the order. Real CSS/text-to-GLSL
inputs still use accurate capture; adjacent neutral shaders retain direct GPU
texture handoff and context-loss recovery.

Next, prove a bounded GPU region using the existing GL context: accumulate scene
prefixes once, pin incoming group states, resolve child effects, then composite
group changes once. Test independent nested alphas, transparent edges and
out-of-bounds children before expanding it to native DOM segments. Sampling and
writing the same attached texture is invalid; use bounded read/write targets.
Add native segment capture only after verifying its clock/revision and GPU copy
boundary. A graph cannot export an inaccessible browser-owned backdrop texture.
Arbitrary live CSS may still require a per-change capture; no readback-free
arbitrary-CSS claim is made here.

The retained CSS-specific replay/material modules are a correctness fallback
from PR #15, not the core plan or the intended future prefix accumulator. This
PR deliberately excludes that PR's benchmark tooling, native test-mode changes,
revert history and large diagnostic dumps. Remove fallback pieces only when the
same visual and lifecycle contracts pass through a replacement.

One document, one Effect representation, one Motion/Presence system and one
shared editor/preview/audience renderer remain. Formats, persistence, authority,
UI interaction semantics and media admission are unchanged.

## Verification

### Presence restoration entry synchronization, 2026-10-21

The clean `fe30101` production run of the original slide 4 completed cold entry,
replay and new-audience navigation. Entrance frame-gap p95 was respectively
66.5, 17.0 and 33.4 ms; steady p95 was 16.8 ms in each mode. All three modes
used `native-backdrop-restore`, three restoration overlays and zero CSS replay
outputs, with no effect errors or missing assets. The warm audience entrance
trace contained no `ReadbackImagePixels` or `WaitForGetOffset` events.
Warm entrance cadence is retained, but cold entry and occasional steady stalls
remain; this is not a uniformly smooth playback claim. These are single
sequential observations, not controlled repeated trials. The
[compact performance record](evidence/presence-restoration-performance-2026-10-21.json)
preserves the pre-fix, unbatched and final observations and build provenance.

The real slide-4 entry recording confirmed an unpopulated first restoration:
`motion-one` was visible at native opacity 1 with Motion alpha 0.0109461,
restoration opacity 0 and an empty bitmap canvas. Its next sample had alpha
0.121433 but restoration opacity 0.989054 and placement from the previous
sample. See the [compact entry evidence](evidence/presence-restoration-entry-2026-10-21.json).

The fix preserves backdrop restoration. Motion synchronously updates the
overlay's inverse alpha and world clip after flushing its existing values.
`RestoredCard.populated` gates the card's `content-visibility` until publication;
the native card's opacity stays 1. Bitmap publication resamples current DOM
values before revealing both parts together, rather than publishing captured
alpha/geometry from before the asynchronous request. The sampler batches DOM reads before writes and avoids redundant style updates.
No timer, extra Motion state or compositor was added. Cancellation synchronizes the restored state too.

The focused entrance test holds first bitmap publication across an actual
paint, advances the existing Motion sampler while it is pending, and checks
readiness, native opacity, inverse alpha and current world placement at reveal.
The real slide-4 filmstrip was visually reviewed without the entrance flash;
all 134 observed visible partial-alpha card samples were populated and matched
inverse alpha. These capture observations do not measure playback performance.

The final Electron selection below passes all **seven** native-composition
declarations, including filled/rounded Move In and cancellation. The browser
selection passes **25** declarations, including CSS backdrop correctness and
both audience-navigation declarations. Build (including TypeScript), changed-file
ESLint, stats and registry audit pass (635 active tests). Full/release suites,
packaged output and macOS checks were not run. Earlier verification and baseline
measurements below remain historical records.

### Real-deck performance follow-up, 2026-10-21

The initial `f620e6a` implementation did **not** fix filled, rounded glass cards.
The user's `ShowMe — Ideas in motion.sme`, slide 4, stayed on the correctness
fallback. Testing the correct checkout reproduced the stalls, independently of
the earlier wrong-folder issue. The original presentation was not changed.

The clean `f620e6a` production build measured entrance frame-gap p95 of
133.3 ms on cold entry, 83.4 ms on replay and 83.4 ms after opening a new audience
window. Corresponding steady p95 values were 16.8 ms. These are one observation
of each lifecycle mode on the same machine, not repeated statistical trials.
The measured stage includes Presence blocks and lasts 1440 ms; measuring only
ordinary track keyframes would incorrectly classify this entrance as zero length.

In the warm entrance trace, audience-main-thread Paint intervals contain
321.8 ms of `ReadbackImagePixels`, including 269.6 ms of `WaitForGetOffset`.
These are nested durations and must not be added together. This identifies a
paint/readback synchronization cost; it does not establish GPU occupancy or a
particular backing-store decision.

Experiments covered layer promotion, resolving the final glass consumer as a
material, GPU image filtering, retained GPU prefix/material textures, bitmap
publication and preparation/retention changes. Those earlier experiments did not
establish smooth production playback. Later runs also differed in steady frame cadence, so they cannot support
a speedup claim against the clean baseline. The experiments remain local and are
excluded from production code. Backdrop restoration above is a subsequent change.

The [compact measurement record](evidence/backdrop-motion-performance-2026-10-21.json)
contains the source/build digests, environment, all three lifecycle observations
and selected trace totals. Raw traces and append-only benchmark history remain
local under `test-results-compositing-f620e6a-entry` and
`.benchmark-data/animation/history.jsonl`. The benchmark harness was exactly
`scripts/benchmark-animation.mjs` from `28b9038` (Git blob
`1e0a8936ca1dcd3475be87cb220a94047ffbd090`), copied into an ignored helper so the
production renderer and tracked benchmark tooling were unchanged. Reproduction:

```powershell
npm run build
git show 28b9038:scripts/benchmark-animation.mjs | Set-Content -Encoding utf8 .agenttmp/benchmark-current.mjs
$env:SHOWME_BENCHMARK_OUTPUT='test-results-compositing-real-deck'
node .agenttmp/benchmark-current.mjs '<path-to-original.sme>' 4
```

The helper uses an isolated library and user-data directory, normal console and
preview rendering, and a six-second observation. The committed record is a
baseline performance limitation, not a completed retained GPU compositor.

The commands and results below describe the unchanged implementation at
`f620e6a`. This follow-up adds documentation and measurement data only.

Final focused browser selection:

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/effects/css-backdrop-opacity.spec.ts","tests/feature/effects/mixed-compositing.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]'
$env:SHOWME_TEST_PORT='5181'
npx playwright test --config playwright.config.ts
```

25 declarations passed, including both audience-navigation declarations and the
independent nested-alpha contract. Native selection:

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/effects/native-composition.spec.ts"]'
npx playwright test --config playwright.electron.config.ts
```

All three Electron declarations passed. `npm test` passed all 15 core tests;
effects unit coverage passed 102 declarations. `npm run build`, changed-file
ESLint, `npm run test:stats`, `npm run test:audit` and whitespace checks passed.

The broader `npm run test:feature -- effects` run passed its build, 102 unit and
47 of 48 browser declarations, then stopped at an existing authoring-prompt
assertion in `authoring.spec.ts:507`. The same assertion failed when run against
the original checkout's renderer source matching `main`; it expects a timeline
prompt sentence that the existing prompt no longer contains. It was not modified
or excluded to make that aggregate command pass. The native group was run
explicitly as shown above because the aggregate stopped before its Electron step.

Full/release suites, packaged output, macOS
and explicit export visual validation were not run. Production measurements for
the later restoration implementation are recorded above. The source was checked on
an isolated branch based on current `main`; no integration into `main` is part
of this work.


> Current experiment note (2026-10-23): this document describes the retained legacy compositor validation subsystem. Normal `SlideRenderer` rendering no longer selects these backends. Explicit rendered-pixel shaders enter legacy capture only through `sceneTexture.ts`.
