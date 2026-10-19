# CSS backdrop + Motion investigation

2026-10-19 · inspected `345c7c624619971d0699f57e8237ab56d3671d98`,
`codex/local-mcp-server` (PR [#15](https://github.com/KonradJuenger/ShowMe/pull/15)).
No production fix, merge, commit, document change, or format change was made.

## Conclusion

**Confirmed: C + D cause the rendering-path switch; B and synchronization costs
explain the expensive workaround. E/A amplify work but are not sufficient explanations.**

The glass's `backdrop-filter` is on a **descendant** of the element receiving
Motion opacity. Chromium stops its backdrop at that opacity ancestor. Declaring
`will-change: opacity` on the ancestor does this even at opacity 1. A transform
stacking context alone does not. PR #15 detects these conditions and reconstructs
the lower scene inside the group. That restores pixels but introduces repeated
prefix painting, material composition, and sometimes asynchronous DOM capture.

This distinguishes two failures: before the workaround, fading loses the intended
blur; with the workaround, maintaining that blur can stall. Neither establishes
that correct native backdrop filtering intrinsically requires raster replay.

**Strong evidence:** normal Presence slows substantially with overlapping cards;
movement-only Presence stays native and smooth. With replay disabled, native
Presence is smooth but visually wrong. The saved production traces contain long
GPU readback waits inside paint, not just slow JavaScript.

**Still unvalidated:** a general production mapping preserving every Effect
placement, nested group fade, clipping, stroke, arbitrary CSS and effect stack.
The diagnostic same-node correction below proves one useful case, not that all
group-opacity semantics can be expressed by moving a CSS property.

## Method and evidence

Read the requested Motion, Presence, effect, raster, SlideRenderer and audience
paths; inspected PR #15's diff, its pixel tests and benchmark history, PR #4
(`d6028161de30720ad755067868390446b9185098`), and subsequent glass experiments.
PR #15's remote head matched the inspected checkout during this investigation.

New measurements use the real `SlideRenderer`, Effect runtime and
`createMotionRuntime` in an isolated Electron window, served by Vite. Temporary
Vite transforms add counters and diagnostic switches **in memory**. Production
source files were never edited. The retained [probe](evidence/css-backdrop-motion-probe.mjs)
is diagnostic tooling, not application behavior or a registered product test.

Windows; Electron 44.4.1 / Chromium 152.0.7977.78; Motion 14.0.0; AMD Radeon 880M, driver
32.0.13062.24001; GPU compositing/WebGL enabled; DPR 1.6041666. Fixture: 960×540,
live stripe GLSL background, 300×200 glass cards offset 35×15 with blur(12px),
1,600 ms linear transitions, 2,100 ms observation. Host viewport 1028×660 DIP;
the probe is vsync-limited around 60 Hz. The production benchmark used a larger
1596×998 audience viewport and different scheduling. Do not compare their
absolute frame rates as equivalent benchmarks.

All new timings are **single-run, instrumented development observations**, not
clean-commit speedups. [Structured evidence](evidence/css-backdrop-motion-2026-10-19.json)
retains configurations, counters, intermediate DOM state, timings and environment.
Full per-frame data, screenshots and new traces remain locally under
`test-results-backdrop-root-cause/`; older production traces remain under
`test-results-glass-final-lowpass/`. No huge traces are added to Git.

## Exact static, Move and Move In paths

The ordinary DOM is approximately:

```text
slide-renderer
  lower element → GLSL surface → visible 2D canvas
  glass element [transform; appearance.opacity; Motion target]
    rounded clipping container + authored fill
      CSS Effect surface [backdrop-filter; CSS background/border; children]
```

**Static:** top-level GLSL renders to its WebGL output framebuffer, then
`materialize()` blits to the shared GL canvas and copies into its visible 2D
canvas. Chromium samples this visible canvas directly for CSS backdrop filtering.
`cssBackdrop.update()` still runs, reads styles and checks eligibility, but chooses
the native fast return; there is no replay canvas or DOM capture. Static does
not mean the entire Effect scheduler is idle or that GLSL is zero-copy.

**Ordinary Move:** `compileMotionStage()` drives x/y through Motion controls.
`styleEffect` binds transform components **and opacity**, initially the authored
opacity. The current runtime sets `will-change: transform` for compiled tracks,
including Fade. At authored opacity 1, a pure Move retains native filtering.
Transform writes invalidate observers, but no backdrop reconstruction is needed.
Historically the hint was `transform, opacity`; commit `03569f0` removed opacity
from that hint. Thus an older ordinary Move was not a transform-only experiment.

**Move In / Presence:** `presetSpecs()` appends opacity 0→base to entrance recipes,
including Move In. `presenceElement()` samples both position and opacity.
Presence bindings run through JS/rAF sampling and explicit `styleEffect.flush()`;
they are not just the ordinary x/y animation. Presence alone does not receive
the compiled-track will-change hint. During intermediate alpha, `cssBackdrop`
finds the opacity ancestor below `.slide-renderer` and activates replay.
At alpha 1, a sole/topmost eligible card returns to native CSS and disposes replay.
An earlier card can remain materialized while a later fading card needs its pixels.

Presence also writes visibility, pointer-events, content-visibility, inert and
`data-presentation-absent`. Before its interval, absent elements do not draw;
during the interval they become visible. The main probe starts at offset zero,
so it isolates the entrance properties rather than delayed hidden preparation.
The prior hidden-preparation experiment tested that separate boundary and was
reverted after worse production measurements; see `areweslowyet.md`.

Effect timing is separate from Presence sampling. `useMotionRuntime` supplies
continuous clocks; runtime controls also deliver an effect clock during stages.
`sync()` materializes an exact sample and calls `flushEffectSurfaces()` once.
The Presence-only per-frame sampling path returns before that global flush.
It does **not** force a full synchronous scene flush on every Presence tick.

Source anchors: [Motion runtime](../../src/components/motionRuntime.ts),
[clock hook](../../src/components/useMotionRuntime.ts),
[recipes](../../src/core/motion.ts), [Presence](../../src/core/presence.ts),
[DOM composition](../../src/components/SlideRenderer.tsx).

## Property isolation: confirmed triggers

| One card, live shader | Backend during motion | Entrance p95 gap (ms) |
| --- | --- | ---: |
| A. Static | Native CSS | 17.2 |
| B. Ordinary transform-only Move | Native CSS | 17.3 |
| C. Opacity-only Fade | Primitive replay | 17.2 |
| D. Move + opacity | Primitive replay | 17.1 |
| E. Production Presence Move In | Primitive replay | 17.4 |
| F. Same Presence, opacity experimentally fixed at authored 1 | Native CSS | 17.2 |
| Move, will-change: transform | Native CSS | 17.0 |
| Same Move, will-change: transform, opacity | Primitive replay | 17.1 |

One card fits the frame budget even on replay, so smoothness alone cannot detect
the switch. A separate **stationary** card with opacity in its will-change list
also entered primitive replay without animating either property. Three ordinary Move cards with the old combined
hint used primitive/native/native backends and had a 233.4 ms maximum gap.
This particular hint experiment did not activate the alpha-based material reuse
predicate: `needsMaterial()` checks later owner opacity, not its will-change hint.

To test Chromium independently of ShowMe's detector, disabled replay and captured
the frozen shader at identical time. Red-channel spatial deviation in a fixed
stripe crop was 7.18 with native blur, 8.04 with translation, 7.18 with the
transform hint, and 61.31 with the opacity hint at **unchanged alpha 1**. CDP
reported `WillChangeOpacity` on the owner, while the child still had a
`BackdropFilter` compositing reason. Layer count stayed at eight: counting layers
alone misses the changed backdrop scope. This is loss of access to lower pixels,
not merely a missing CSS declaration or an extra layer.

In a second native-only experiment, added overlapping semitransparent foreground
children and compared screenshots against `0.5 × full + 0.5 × backdrop`:

| Filter/alpha relationship | RGB RMSE, 0–255 | Maximum channel error |
| --- | ---: | ---: |
| Current descendant filter, alpha on parent | 21.64 | 38 |
| Filter moved experimentally onto alpha-owning element | 0.34 | 0.5 |

The same-node experiment retained a live-shader source but froze its sampled time
for pixel comparison. It required no capture/reconstruction. No such DOM change
was persisted in the application.

This matches the draft [Filter Effects Level 2 backdrop-root definition](https://drafts.csswg.org/filter-effects-2/#BackdropRoot):
ancestor opacity and will-change for such properties restrict the backdrop;
transforms alone do not. The draft is supporting context, not proof of browser
behavior; the screenshots and CDP results supply that proof here.

## Where ShowMe chooses reconstruction

[cssBackdrop.ts](../../src/components/cssBackdrop.ts) checks ancestor opacity <1
or a will-change list containing opacity, stopping before the slide root.
It can also materialize an earlier eligible card solely because a later fading
glass needs its pixels. It does not test every possible CSS backdrop-root trigger;
arbitrary ancestor filters/masks/blend modes remain outside this experiment.

* **Native fast return:** no detected boundary and no later material consumer.
  Native Chromium filters the actual shader canvas; no `domRaster` work.
* **Primitive replay:** eligible lower prefix, no contributing arbitrary CSS or
  intersecting unreused text. `createBackdropRasterSource()` replays the lower
  scene into the card's local padded viewport. Live shader canvases are reused.
  The CSS filter still runs natively against replay inserted inside the group.
* **Material:** eligible static scoped CSS, clipped card, one effect, no stroke,
  compatible geometry and static descendants; later fading glass needs output.
  Capture its foreground once without backdrop filtering. Repaint its prefix,
  filter a reduced-density 2D buffer, composite foreground, hide original surface
  with opacity 0, and publish `cssBackdropOutputs` for later cards.
* **Native DOM raster fallback:** contributing CSS/text/stylesheet prevents the
  primitive route. Mirror the lower DOM, normalize target ancestry to opacity 1
  and will-change auto, materialize shader dependencies, copy changing bitmaps,
  then await HTML-in-Canvas paint and `drawElementImage()`. Bitmap changes require
  a priming paint plus recording paint. Transform correction handles completion
  after the card has already moved. This is asynchronous native **DOM painting**,
  not `webContents.capturePage()` or desktop screenshot IPC per animation frame.

PR #4 introduced the native mirror and GPU chaining for **shader pixel inputs**
containing CSS/text, with demand-driven dependency resolution. PR #15 adds a CSS
backdrop consumer that can need those mechanisms solely because Motion alpha is
on its ancestor. Genuine CSS/text→GLSL input boundaries still need accurate
capture even if this specific CSS glass path is corrected.

## Invalidation, capture and scaling counts

One changing shader frame publishes `effectRevision` and `showme-effect-output`.
CSS surfaces also publish when their style signature changes: their conservative
clock key includes time even for these constant declarations. CSS backdrop
listeners see earlier publications; scene MutationObservers see clock/transform
style changes and replay writes. Each `schedule()` increments graph dirtiness,
including transitive consumers, and requests `frame.postRender(flushScheduled)`.

The scheduled Map coalesces node jobs; the graph shares pending input promises.
`flushScheduled()` prepares reads after Motion writes, resolves dependencies, and
reschedules unresolved dirty versions. DOM raster has its own in-flight and
snapshot guards; shader materialization has a revision guard. These guards work:
request counts must not be described as completed captures or shader draws.

Representative **settled entrance frame** counts (mean of probe bins 12–29,
excluding startup and transition completion):

| Configuration | schedule calls | Graph dirty increments | Effect executions | Prefix paints | Completed DOM captures | Shader materialization attempts / actual copies |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Static, 10 cards | 121 | 506 | 11 | 0 | 0 | 1 / 1 |
| Presence, 1 card | 12 | 14 | 2 | 1 | 0 | 3 / 1 |
| Presence, 3 cards | 50 | 99 | 4 | 3 | 0 | 13 / 1 |
| Presence, 10 cards | 309 | 1394 | 11 | 10 | 0 | 111 / 1 |

No surface drew more than once per sampled bin. In the 2.1-second simple-prefix
runs, foreground DOM captures totaled **0 / 2 / 9** for 1 / 3 / 10 cards, despite
many `domRaster.update()` calls. Those are cached foreground captures, not one
full-scene capture per card per frame. With contributing text behind the cards,
the native fallback instead completed 47 captures for one card and 52 across
three cards; asynchronous dependencies reduced output frequency. In the 10-card
native-fallback diagnostic, several consumers still lacked output at the 700 ms
sample. Its timing is not an equivalent completed-visual workload.

The prefix work is triangular: card 1 samples shader; card 2 samples shader plus
resolved card 1; card 3 samples shader plus resolved cards 1 and 2. Material reuse
avoids recursively rendering each earlier card's whole subtree, but does not
avoid revisiting/blitting the earlier prefix for every consumer. Additional
geometry/dependency reads and all-earlier input lists increase bookkeeping.
Ten settled cards caused 85 instrumented primitive-element visits, including
target-transform queries. Observer/event fan-out and transitive invalidation add
another substantial multiplier. This is not ten independent constant-cost blurs.

| Live shader, overlapping cards | 1 card p95 / max gap (ms) | 3 cards | 10 cards |
| --- | ---: | ---: | ---: |
| Static | 17.2 / 17.5 | 16.9 / 34.4 | 17.3 / 18.8 |
| Ordinary Move | 17.3 / 17.7 | 17.2 / 17.5 | 17.3 / 17.3 |
| Presence Move In | 17.4 / 19.9 | 17.2 / 183.2 | 49.9 / 166.5 |
| Presence, opacity fixed at 1 | 17.2 / 18.0 | 17.2 / 17.7 | 17.4 / 19.0 |

p95 is entrance-only; max is whole observation. Three-card startup stalls can
be large without moving its p95. With card text added in separate traced runs,
10-card Presence p95 was 66.8 ms versus 16.8 ms without opacity; trace overhead
and fixture changes prevent attributing that difference to text alone.

Corrected ablations: freezing shader timing eliminated all observed shader draws
but retained moving-prefix repaint and a 183.2 ms startup gap. Suppressing revision
publication/events retained shader draws and reconstruction (maximum 33.2 ms).
Suppressing only the CSS backdrop MutationObserver also retained reconstruction
(maximum 50.2 ms). These single runs do not establish a scheduler fix or a general
speedup. Direct rAF transform writes and Motion Move both stayed native and near
17 ms p95. Disabling replay for three-card Presence also stayed near 17 ms, but
the native-only pixel experiment demonstrates why that output is unacceptable.

## CPU, GPU and synchronization evidence

Reanalyzed the saved, clean `1a6d240` production traces against the **audience** PID
17832, main thread 3492, using its running `ShowMe:motion-sync` marker. The console
has its own matching marker; selecting the first marker would misattribute it.
Values below cover the 1,440 ms entrance; nested event categories are not additive.

| Audience event | Cold: count / total / max (ms) | Repeat: count / total / max (ms) |
| --- | --- | --- |
| RasterImplementation::ReadbackImagePixels | 15 / 370.8 / 71.7 | 19 / 257.6 / 27.8 |
| CommandBufferProxyImpl::WaitForGetOffset | 15 / 324.2 / 69.1 | 19 / 191.1 / 23.9 |
| Paint, same-name nesting excluded | 105 / 384.0 / 72.2 | 43 / 271.4 / 28.2 |
| Layout | 249 / 23.5 / 4.1 | 198 / 11.6 / 0.3 |
| UpdateLayoutTree | 522 / 58.9 / 0.7 | 617 / 67.9 / 0.6 |

The cold 72.227 ms Paint contains 71.744 ms ReadbackImagePixels, which contains
69.142 ms WaitForGetOffset. Paint's recorded **thread CPU** is 4.243 ms; the
readback's thread CPU is 3.786 ms. That spike is mostly waiting, not 72 ms of JS
or CPU raster arithmetic. These readbacks disappear in the selected following
3 seconds of steady playback, while GLSL continues. The retained benchmark reports
59.9 / 40.1 ms entrance p95 for cold/repeat, versus 5.8 / 6.8 ms steady p95.

The probe also shows CPU work: prefix scans, style resolution, geometry reads,
drawImage submissions, and per-card 2D material filtering. Rich 10-card traces
contain many forced-style/layout calls and long animation callbacks. Timing only
the `getComputedStyle()` function return undercounts deferred property resolution;
do not infer negligible style cost from that wrapper's duration. Likewise a fast
drawImage submission does not bound later compositor/readback cost.

Allocation probes observed no `compileShader`, `createTexture`, `texImage2D` or
WebGL `readPixels` calls during static/Presence sampling after mount. Three/ten
cards invoked 2D getImageData allocation checks 9/37 times over the whole window;
these were not repeated each settled frame. Cached shaders and fixed shader
textures therefore do not explain recurring entrance stalls. GC was minor in
the selected audience entrance; repeated shader compilation is unsupported.
Chromium's internal GPU readback is real despite zero JS `readPixels` calls.

**Remaining attribution limit:** the traces establish CPU/GPU synchronization at
canvas paint/readback, not which exact Skia backing-store decision caused every
readback, GPU execution occupancy, or bytes uploaded/read back. Concurrent console
and preview renderers also share the GPU in the production trace. Do not label
the result pure CPU load, pure shader saturation, or conclusively GPU-free.

## Editor versus audience

Both use the same SlideRenderer/EffectSurface/Document model. The editor canvas
normally has no running Motion state, so these cards have alpha 1; audience
activates Presence and shared presentation clocks. Editor Motion preview can
cross the same boundary; `presentation` is not a separate shader renderer.

`AudienceSlide` fits to the window, negotiates an image profile, prepares images
and flushes effects before readiness. Its outside-slide wrapper uses opacity
0/1 for inactive/preparing slides, plus optional native slide transitions. That
wrapper encloses **both shader and glass**, so it does not itself cut the glass
off from that same-slide shader as the per-card opacity wrapper does. The
backdrop detector intentionally stops at the slide root. Cross-slide sampling
and ancestor-trigger edge cases were not validated here.

Effect density comes from render profile × fit scale × display DPR. Audience
can therefore prepare more pixels than a zoomed-out editor. `retain` is
`deferImageUpdates || playing`; it holds shader sampling density and envelopes,
not a backdrop snapshot or a native compositing exemption. Editor gesture image
deferral changes admission, not backdrop-root semantics. Audience passes
`presentation`, `staticVideo` according to activation, Motion state and explicit
effect-clock origins; continuous effects are enabled for active clocks. Static
video does not by itself freeze shaders when an explicit effect clock exists.

There are potentially two Presence sampling sources in audience playback:
the continuous effect-hook rAF calls `samplePresence()` with explicit origins,
while `runtime.sync()` can also start its Presence rAF for a running state.
The probe uses manual timing plus the runtime clock, not the full production
audience-hook combination; it confirms repeated timing/invalidation requests,
not the exact production per-frame split between these loops. This duplication
is worth auditing, but native movement-only output remains smooth despite the
runtime sampling, and the property/hierarchy tests isolate a separate cause.

## Smallest plausible correction; PR #15 assessment

Investigate the native DOM paint boundary first: for eligible glass, make the
backdrop-filtered material itself the Motion alpha/transform subject, so backdrop
resolution precedes its own group fade. The same-node pixel experiment validates
this principle for a card with overlapping children. Preserve the existing
semantic effect order, one group alpha, child overlap, clipping and placement;
do not simply fade each primitive separately or remove opacity from Move In.
Maintain transform-only will-change when opacity is not needed. General nested
group fades may still require an explicit solution and are not solved by this
limited experiment. Audit redundant timing deliveries and dependency fan-out
after that boundary is understood.

Useful PR #15 evidence: resolved-then-faded pixel composition tests, real Move In
intermediate samples, overlapping-material and custom-CSS cases, production
entrance/steady measurements, capture diagnostics and the failed hidden-prewarm
experiment. Its correctness target is valid. Its asserted primitive/native/
material backend choices describe the experiment, not an architectural necessity.

The large CSS-specific prefix replay, static foreground mirrors, low-pass canvas
filter, material publication and transform reprojection compensate for putting
backdrop resolution inside the wrong alpha ancestor in these eligible cases.
They should not be generalized before validating the native boundary correction.
The low-pass change reduces the cost of that workaround, not its cause. PR #4's
accurate CSS/text→shader capture and guarded GPU handoffs remain useful for real
mixed-effect pixel dependencies.

## Reproduction and verification

From repository root (installed dependencies, Electron available):

```powershell
node docs/rendering/evidence/css-backdrop-motion-probe.mjs
$env:PROBE_CASES='[{"mode":"static","n":1}]'
$env:PROBE_SEMANTICS='1'
node docs/rendering/evidence/css-backdrop-motion-probe.mjs
```

The first command runs the property/scaling matrix and corrected ablations.
PROBE_CASES selects supplementary configurations recorded in the JSON; PROBE_TRACE=1
adds browser-wide traces. Each invocation overwrites local matrix.json; copy it
between groups to retain each result. The probe creates and closes its own
Electron process; it does not edit production sources or the user's document.
[Trace analyzer](evidence/analyze-backdrop-trace.mjs) accepts a trace prefix;
the original `test-results-glass-final-lowpass/summary.json` supplies audience
process identity and duration for the saved production runs. Commands used:

```powershell
node --max-old-space-size=8192 docs/rendering/evidence/analyze-backdrop-trace.mjs test-results-glass-final-lowpass/cold-entry
node --max-old-space-size=8192 docs/rendering/evidence/analyze-backdrop-trace.mjs test-results-glass-final-lowpass/warm-repeat
```

Existing regression verification:

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/effects/css-backdrop-opacity.spec.ts"]'
npx playwright test --config playwright.config.ts
git diff --check
```

Six existing browser declarations passed; diff/whitespace checks passed.
Both retained diagnostic scripts passed `node --check`; the evidence JSON parsed
and its recorded probe SHA-256 matched. No tests were added or weakened.
No full suite, build, release/package checks, macOS checks or audience-navigation
gate were run in this pass. This report/evidence-only change does not affect
slide rendering and is exempt from that commit/integration gate; no commit or
integration is being made. Remaining validation is a production native-boundary
prototype against the retained visual contracts, not more unqualified caching.
