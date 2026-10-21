# Ordered composition and native lowering

2026-10-21. First production phases of the compositing architecture: derived
paint order, explicit pixel dependencies, and a constrained native visual group.

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
completed ancestor outputs; those would depend on the consumer itself. CSS
backdrop input remains a browser paint-point read. These are distinct references,
not permission to reorder persisted effects.

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
are intentionally outside this native lowering until exact boundary parity is
proven.

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

Full/release suites, packaged output, macOS, production performance benchmarks
and explicit export visual validation were not run. The source was checked on
an isolated branch based on current `main`; no integration into `main` is part
of this work.
