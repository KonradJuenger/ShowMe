# Native presentation performance investigation

2026-10-23. Branch: `performance/native-presentation-workload`. Phase 1 only.
Baseline main was verified locally and remotely as `a699fbdd3af0e3ff8ab940db53379a8e4aeb1dfc` before changes; main did not move. No merge or push to main.

## Hypothesis and ownership

The audience competes with independent full-rate rendering in the editor canvas,
external presenter console and the editor's presenter dock. The dock was found
by per-window instrumentation; an initial candidate that missed it was revised
and its interrupted comparison discarded. The thumbnail output was already idle
in this workload. Audience rendering remains live and browser-native throughout.
No GPU-query, drawing-buffer, SceneTexture assembly or resolution optimization
from later phases is included.

## Retained implementation

- SlideRenderer has an explicit live/static visual workload policy. The editor
  canvas becomes static while an external presentation has an active slide;
  presenter current/next previews, including the editor dock, use static visuals.
- Non-audience Effect clock pumps and Motion playback stop; monitor visuals
  remain mounted. This suspends rendering work, not merely visibility.
- Static shaders publish a completed frame and release their SceneTexture capture
  provider, stopping its capture observers/polling. Accepted slide/deck changes,
  output density changes and font completion can refresh static output.
- Ending presentation resumes live editor rendering. Controls, notes, timers,
  readiness, Advance and document/collaboration ownership are unchanged. Preview
  animation is deliberately static; this is a monitor-cadence policy, not reduced
  audience quality. The presentation clock and persisted model are unchanged.
- Static output also requests a fresh draw on context restoration. This recovery
  adjustment followed hardware measurement; it changes only restoration handling,
  not the measured steady-state path. Its regression test passes.

React review: policy is explicit at rendering boundaries; hooks remain unconditional,
subscriptions clean up, and timers do not drive preview GPU work. No new authority,
presentation clock or general compositor was introduced.

## Method and provenance

Reference: saved `shader-text-shader.sme` (SHA-256 in evidence). Production Electron
44.4.1 on Radeon 880M / D3D11, Ryzen AI 9 365, Windows. Audience viewport 1596×998
CSS pixels, DPR 1.6042. Audience logical and output resolution unchanged.
The original user app remained running, limiting absolute headroom; no tests or
builds ran alongside recorded measurements.

Phase 0 first reproduced baseline with three alternating presenter-on/off pairs:
normal median 21.8 audience callbacks/sec, 10.8 glass publications/sec; presenter
off median 27.1 and 13.5 respectively. These confirm the supplied finding.

The final comparison used three serial interleaved rounds of baseline,
editor-only, presenter-only and both, ten seconds each. All checkouts were clean;
harness/deck digests, viewport, DPR and GPU matched. Presenter-only includes both
the external console and dock previews. Editor-only freezes the editing canvas.
This comparison keeps the presenter loaded, unlike the earlier about:blank test.

Measured combined revision: `0731fba1b12edbc634c29863e64bf7a881b0e76f`.
Baseline `a699fbd`; editor-only ablation `041f427`; presenter-only `caea325`.
These diagnostic commits are isolated worktrees, not integration candidates.
Raw local harness/results/screenshots remain in `.agenttmp` in those worktrees.
Raw summaries: [phase evidence](evidence/native-presentation-phase1-2026-10-23.json).

| Policy         | Audience FPS median [min, max] | Glass publications/sec | Frame p95 ms      |
| -------------- | ------------------------------ | ---------------------- | ----------------- |
| baseline       | 22.6 [21.3, 22.7]              | 11.3 [10.6, 11.3]      | 83.5 [83.4, 83.6] |
| editor-only    | 24.0 [23.3, 24.9]              | 12.0 [11.6, 12.5]      | 83.4 [83.3, 83.5] |
| presenter-only | 25.5 [22.6, 26.2]              | 12.7 [11.3, 13.1]      | 83.3 [83.0, 83.6] |
| both           | 29.1 [28.8, 30.0]              | 14.5 [14.4, 15.0]      | 66.7 [66.7, 66.8] |

Generated background publications track audience callbacks (combined median 29.1/sec).
All three combined runs improve over all baseline runs: roughly 29% higher audience
and glass throughput. Partial-policy medians improve less; presenter-only ranges
overlap baseline, so three samples do not establish a precise independent gain.

CDP editor task duration drops from median 10381 ms to 44 ms, and external console
from 10170 ms to 30 ms over approximately ten-second samples. These are main-thread
busy/blocking task durations, not pure CPU utilization or additive GPU budgets.
Independent production lifecycle validation keys counters by DOM instance index:
all editor/dock/console shader publications stop after settling; font completion
refreshes the editor, controls remain available, and End resumes live editor output.

The comparison's per-ID editor publication attribution is excluded because canvas
and dock reuse Effect IDs. It does not affect audience FPS, audience shader rates,
per-window task duration, or independently validated lifecycle counters.

## Correctness and commands

With SHOWME_TEST_FILES set to the relevant JSON file list:

- `npx vitest run`: 74 passed across execution-graph, renderer-architecture,
  render-sampling, composition-plan, native-opacity and time-control unit files.
- `npx playwright test --config playwright.config.ts --output test-results-phase1`:
  29 passed across mixed-compositing, render-sampling and audience-navigation;
  includes both dense-navigation and late-image declarations and 4K sampling.
- `npx playwright test --config playwright.config.ts --output test-results-phase1-dock-controls`:
  4 passed across presenter/displays.spec.ts and presenter/transitions.spec.ts.
- `npx playwright test --config playwright.config.ts --grep 'continuous invalidation' --output test-results-phase1-static-recovery`:
  targeted static freeze/resume and context-loss/restoration regression passed.
  GPU handoff/context restoration and font-invalidation focused selections also passed.
- `npx playwright test --config playwright.electron.config.ts --output test-results-phase1-desktop-root`:
  presenter/displays-electron.spec.ts passed with SHOWME_TESTING=1 and a disposable
  SHOWME_TEST_ROOT_SELECTION. Initial invocation stalled at the fresh-profile native
  root-selection dialog before creating a window; no product assertion was weakened.
- `npm run build`, `npm run verify:build`, `npm run typecheck`, focused ESLint,
  `npm run test:audit` (667 declarations / 95 groups), `git diff --check`: passed.
- Production lifecycle smoke: `node .agenttmp/phase1-lifecycle.mjs` passed with
  visible Electron, paused publication, font refresh, controls and editor resumption.

No full/release suite, installer packaging, cross-platform, physical-display FPS,
full-refresh continuity or exhaustive arbitrary-CSS static-preview audit was run.
No resolution reduction, shader simplification or per-chain context pool was shipped.

## Decision

Keep Phase 1: redundant rendering is substantially removed without changing audience
quality or browser-native ownership. It does not deliver 60 FPS. The 2:1 glass cadence
persists: about 29 audience callbacks versus 14.5 glass publications per second.
That is measured app cadence, not physical-display FPS.

The results support a separately measured Phase 2 resource-generation/query reduction
experiment. Earlier profile percentages are hypotheses, not predicted gains after
this policy change. Stop here as requested; no later phase or main integration.

## Phase 2 — owned GPU resources and linked bindings

Requested follow-up; Phase 3 was not implemented. Phase 1 baseline `c0b99a8`,
Phase 2 measured commit `ae445b3`. Same hardware/viewport/deck as Phase 1.
Three serial alternating ten-second pairs, clean production builds, identical
harness/deck/GPU/viewport/DPR. Both retain the static non-audience workload policy.

Hypothesis: synchronous object-validity probes and repeated program lookups add
main-thread/GPU synchronization overhead. Replace per-draw ownership probes with
a context-loss generation token. Cache active uniform locations, the position
attribute and a VAO once per linked program; release VAOs with programs. Context
loss invalidates old resource generations and restoration rebuilds them.

Removed steady isTexture/isFramebuffer queries from outputs, retained inputs and
owned media. Default drawing-buffer error/size validation now runs when resized,
not when its dimensions are unchanged. Compilation, linking, allocation, upload,
and restoration checks remain. No resolution, drawing-buffer pool, SceneTexture
assembly or scheduling change was made.

| Version | Audience FPS median [min, max] | Glass publications/sec | Frame p95 ms      | Maximum stall ms     |
| ------- | ------------------------------ | ---------------------- | ----------------- | -------------------- |
| phase1  | 28.3 [26.0, 28.6]              | 14.1 [13.0, 14.2]      | 66.8 [66.7, 83.1] | 133.7 [116.4, 150.1] |
| phase2  | 29.4 [28.6, 34.0]              | 14.6 [14.3, 16.9]      | 66.8 [66.3, 66.8] | 83.8 [82.8, 99.8]    |

Median audience rate increased about 4%; one pair was essentially flat. The ranges
overlap, so this is a small/inconsistent gain, not evidence of a major FPS win.
The 2:1 glass cadence remains. Lower maximum stalls in these short samples are
observations, not an established tail-latency guarantee.

Keep the ownership/cache refactor: it makes resource lifetime explicit, removes
measured hot API calls, and shows no observed performance penalty. Do not present
the earlier profiling percentages as recoverable FPS. Phase 3 (isolating drawing
buffer resizing) remains a separate hypothesis to test next. No 60 FPS claim.

Focused verification: execution-graph unit file **11 passed** (mock contexts now
model actual loss events and reject validity probes); mixed-compositing selection
`--grep 'GPU shader handoff|continuous invalidation|neutral live video'` **3 passed**,
including live video, alpha/pixels, static/live context restoration and a warm
shader loop asserting zero uniform/attribute lookups. Production build, typecheck
within build, build invariants, focused ESLint and diff checks passed. Broader
suites were not repeated for this focused iteration. Commands: `npx vitest run`
with execution-graph in SHOWME_TEST_FILES; `npx playwright test --config
playwright.config.ts --grep 'GPU shader handoff|continuous invalidation|neutral
live video' --output test-results-phase2`; `npm run build`;
`npm run verify:build`. Measurements ran via the same local fps-phase1.mjs
harness in alternating Phase 1/Phase 2 worktrees.

[Raw Phase 2 evidence](evidence/native-presentation-phase2-2026-10-23.json).
