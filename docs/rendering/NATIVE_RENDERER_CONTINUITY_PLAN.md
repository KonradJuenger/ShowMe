# Native renderer continuity plan

Branch: `experimental/browser-native-renderer`.

Status: native alpha routing and focused continuity verification implemented.
See [validation and remaining limits](NATIVE_RENDERER_CONTINUITY_VALIDATION.md).
Full-rate physical-display flicker coverage and dense-workload smoothness remain
open; the implementation does not claim those completion criteria are achieved.
Stay on this branch; do not merge or create a PR.

## Product target

Native rendering should support layered text, images, video, CSS, JS and shaders
with smooth movement, stable effects and responsive controls. A modest, consistent
composition approximation during a transition is preferable to flicker, missing
effects, visible stalls or frame-to-frame changes in rendering strategy.

Acceptance priorities, in order:

1. No unintended disappearance, blank canvas, flash of unfiltered content, stale
   activation or foreground-order change in any observed presented frame.
2. Smooth temporal progression, including pause, seek, reverse and navigation.
3. Bounded input-to-visible-response latency and resource residency.
4. Preserve resting-state composition and minimize transition-only differences.

An opacity approximation is not permission for a one-frame defect. An effect
that disappears throughout an entrance also fails, even if it returns at the end.

## Architecture boundaries

- Retain the existing document model, authority, persistence and canonical clock.
- Keep normal DOM, CSS, JS, images and video native; keep generated shaders and
  compatible shader chains GPU-owned.
- Keep rendered-scene shader inputs behind the existing SceneTexture boundary.
- Separate transform transport from visual alpha where that preserves effect
  order, clipping, selector scope and backdrop access.
- Derive any alpha-routing decision from accepted structure when it changes;
  never select a different rendering strategy on individual animation frames.
- Do not add general scene capture, per-frame React rendering, scene planning or
  DOM observation to ordinary Motion playback.
- Use the same visual rules for editor playback, preview, audience and export.

## 1. Establish reproducible workloads and baseline

Use both supplied Ideas in motion decks as local reproduction inputs, including
the real image asset. Preserve those files. Add a small repository-owned fixture
with generated/licensable assets so maintained tests do not depend on local paths.

Cover these named scenarios without a combinatorial suite:

| Scenario | Main contract |
| --- | --- |
| Single glass card over an image | Blur stays visible throughout Presence Move In and Out |
| Glass over generated GLSL and moving video | Backdrop updates without blank or stale layers |
| Two overlapping glass cards | Accepted alpha approximation remains continuous |
| Nested frame with text, image and CSS/JS | Clipping, ordering and live DOM output remain coherent |
| CSS/JS followed by a content-input shader | Captured input is ready before it becomes visible |
| Explicit backdrop shader beside native glass | Capture does not interrupt unrelated native layers |
| Dense audience slide and late-image navigation | Readiness, motion and bounded residency remain intact |

Exercise cold entry and warm revisit, entrance and exit, pause/resume, forward and
backward seeks, stage boundaries, rapid navigation and output resizing. Run the
primary cases in Electron; use Chromium for faster diagnosis. Include 1080p and
the intended 4K audience workload when measuring the completed candidate.

Record branch SHA, dirty state, OS, CPU/GPU, runtime versions, DPR, output size,
refresh rate and workload. A baseline containing the known blur failure is useful
for timing comparison but is not a visual acceptance reference.

## 2. Build and validate explicit flicker detection before fixing the renderer

### Deterministic painted samples

Drive the existing canonical clock through each short transition in increments
no larger than one target refresh interval. Sample immediately before, at and
after entrance/exit endpoints, presence boundaries and readiness handoffs.

Capture the actual composed slide pixels after the corresponding paint. Do not
treat DOM attachment, a computed CSS property, a readiness attribute or successful
canvas allocation as evidence of visible rendering.

For each expected-visible element, evaluate its expected transformed region at
the sampled time. Exclude intentional occlusion and pixels outside its clip.
Use fixture-specific pixel references/landmarks to detect:

- loss of the element's visible contribution;
- replacement by background, solid fill, transparent/black canvas or stale output;
- disappearance of blur or another required effect;
- sudden changes in opacity, edges, clipping, z-order or position;
- a previous slide/output appearing after a new activation.

Use a detailed background with known edges to distinguish active blur from a
correctly assigned but ineffective backdrop-filter. Compare expected filtered
and unfiltered references, accounting for the intentional fade contribution.
Presence at zero opacity is exempt only where the schedule requires invisibility.

Do not compare consecutive whole-frame images with a generic difference limit:
normal movement, shader animation and video would create false positives. Compare
each sample with its expected time/state and inspect temporal continuity relative
to that expected progression. JS and shader fixture randomness must be seeded;
the video fixture should have known frame identities and intended cadence.

### Real-time flicker checks

Deterministic stepping is insufficient: async capture, decoding, GPU publication
and navigation can fail between samples during real playback. Add a separate
short real-time Electron capture run for the high-risk scenarios.

First qualify a capture mechanism against production-style presentation. Record
capture timestamps, presentation/frame identity where available and sampling gaps.
Do not assume screenshots, recordings or screencasts contain every presented frame.
An offscreen-only result is supplementary unless shown to reproduce the normal
window's behavior.

Validate the detector with deliberate fixture-only faults:

1. Hide a visible element for exactly one presented frame.
2. Remove its blur for exactly one presented frame.
3. Clear/replace a shader output for exactly one presented frame.
4. Introduce an unintended one-frame opacity jump.
5. Freeze an expected-changing output for a known interval.

Each injected fault must be reported at the correct region and time. Also verify
clean playback and intentional occlusion, video cadence, fades and presence gaps
do not produce false alarms. Never put injection hooks into normal product flows.

If a capture gap could conceal the injected one-frame fault, report incomplete
coverage and block a claim of one-frame flicker protection. Establish this capture
capability before depending on the real-time test as an acceptance gate.

Every detected visual fault fails the run; do not allow a percentage of bad frames
or add retries to erase intermittent failures. Save preceding/failing/following
frames, expected region, timeline state, capture coverage and a contact sheet.

## 3. Measure smoothness and latency without capture distortion

Run timing measurements separately from high-frequency image capture. Retain
lightweight timing in the visual run only to correlate failures; do not use its
capture-distorted timing as the performance verdict.

Measure frame interval distributions, missed refresh opportunities, longest
visible stall, main-thread long tasks, input-to-first-correct-visible-frame latency,
navigation readiness, media progression and retained resource counts. rAF timing
alone is not proof that a correct frame reached the display.

Initial proposed budgets on the designated reference machine at 60 Hz:

| Measure | Candidate acceptance target |
| --- | --- |
| Visual continuity | Zero detected unintended flashes, missing effects or dropouts |
| Frame intervals during steady representative playback | p95 <= 20 ms; p99 <= 33.4 ms |
| Unexpected steady-playback stall | No gap > 50 ms |
| Pause/seek/control response | p95 <= 100 ms to the correct visible state |
| Warm slide navigation | p95 <= 100 ms to the correct ready output |
| Repeated navigation and effect teardown | Existing bounded-residency contracts pass; no accumulating resources |

Confirm measurement resolution and baseline feasibility before adopting these as
hard gates. Adapt refresh-based budgets for other displays; do not compare unlike
machines/workloads or relax a budget silently when it fails. Record cold loading
separately from warm interaction. An expensive cold resource may delay activation;
it must not produce a blank, partially prepared or inconsistent visible slide.

## 4. Implement the smallest native alpha-routing change

First repair the representative fixture's malformed GLSL newline so it can test
its intended contract. Then make the single-card pixel reproduction fail on the
current renderer before changing alpha routing.

Implement and verify in this order:

1. Single backdrop-effect card: preserve outer transform transport and route alpha
   to the appropriate visual/effect node without changing paint order.
2. Independent cards: preserve each card's effect while sampling its own fade.
3. Nested/overlapping groups: evaluate a fixed per-visual fade approximation against
   a fully rendered, once-faded group reference. That reference is an offline test
   oracle, not a new runtime compositor.
4. CSS/JS/shader combinations: preserve scope, clocks, ownership, readiness and
   explicit SceneTexture boundaries.

Only enable an approximation for combinations covered by the visual contracts.
Evaluate it throughout the fade, especially near opacity 1, so the last frame does
not suddenly change blur, blending or overlap. Do not switch backends to conceal a
boundary defect. Do not freeze live video/shaders as an unannounced workaround.

Permit a reviewed transition-only color/alpha difference; reject missing blur,
text loss, visibility flashes, ordering changes and discontinuous jumps. Keep
resting states equivalent. Unsupported structural cases retain documented native
semantics until a better rule is demonstrated; do not claim universal parity.

Keep the last valid pixel output visible while its replacement is prepared where
that preserves the requested state. Guard async publication by activation/lifetime
so disposed or obsolete work cannot overwrite the current scene. Preparation must
remain bounded; indefinite stale output is also a failure.

## 5. Integrate focused coverage and evaluate the completed candidate

Add maintained named declarations at the lowest useful tier. Deterministic
alpha-routing decisions belong in domain tests; composed-pixel and temporal
contracts belong in focused effects/presenter browser or Electron tests. Register
new files in tests/registry.json, update lastReviewed, regenerate statistics and
run the audit. Do not add screenshots of arbitrary DOM structure as contracts.

Run the targeted continuity tests first, followed by relevant existing shader-input,
native Motion/Presence and audience-navigation coverage. Both declarations in
tests/feature/presenter/audience-navigation.spec.ts must execute and pass before
any rendering-affecting commit/integration into main, per AGENTS.md.

Measure performance once on the coherent candidate with matching-machine baseline
runs using the existing audience benchmark tooling. Store measurements with their
actual candidate state and summarize comparable runs in areweslowyet.md when
available. Do not infer performance improvement from a correctness pass.

Handoff must include exact commands/results, visual fault counts, capture coverage,
frame-time and response-latency results, before/after clips or contact sheets,
accepted visual differences, and combinations/platforms not yet validated.

## Completion criteria

- Both supplied decks play without the observed blur interruption.
- The maintained detector catches each deliberately injected single-frame fault.
- Clean representative runs produce no visual continuity failures.
- The completed candidate meets the agreed smoothness/latency budgets.
- Accepted opacity approximations remain bounded and continuous through endpoints.
- Native paths do not acquire ordinary scene-capture work; explicit SceneTexture
  effects remain correct without disrupting other layers.
- Existing audience navigation and residency contracts pass.

Passing selected screenshots or rAF measurements alone does not complete the work.
