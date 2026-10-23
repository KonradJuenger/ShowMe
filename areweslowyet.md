# Are we slow yet?

## Native continuity experiment — 2026-10-23

### Attribution follow-up

Diagnostic CPU sampling (`node test-results-slow-profile/profile.mjs` and
`node test-results-slow-profile/profile.mjs --electron`) showed that the headless
run uses **SwiftShader software WebGL**, whereas visible Electron 44 uses the
**Radeon 880M / D3D11**. At 1920×1080/DPR 1, steady playback measured rAF p95
33.4 ms headless and 6.7 ms in Electron. These short profiled runs are attribution
experiments, not matched benchmark replacements or physical-display measurements.

In headless steady playback, about 78% of CPU samples landed in `drawImage`
called by `effectRuntime.materialize`, which transfers shader output to the
visible 2D canvas. Both environments recorded zero new DOM captures/clones during
steady playback. Electron still performed 8,874 style reads over four seconds;
style collection and property access were its largest sampled hotspots.

Six profiled Electron navigation requests took 159–378 ms and produced 57 captures,
24 clones and 756 style reads. Navigation samples also exposed synchronous
`canvas.toDataURL()` in the **test image mock** (8.9% of samples), so these timings
include fixture generation as well as real renderer preparation. The earlier
83.4 ms aggregate includes repeated navigation and must not be described as
native steady-playback performance. Optimize source-style invalidation, preparation
and shader presentation separately; preserve the full correctness workload.
See [attribution evidence](docs/rendering/evidence/native-slow-attribution-2026-10-23.json).

### Requested standalone stress rerun

Command: `npm run benchmark:audience -- --runs 3 --output test-results-native-stress-requested`
with `SHOWME_TEST_PORT=5197`. All three dense stress correctness runs passed in
2.3 minutes, with no other verification jobs launched alongside them. The candidate
remained dirty on `experimental/browser-native-renderer`; no production code was
changed for this rerun and these results are not attributed to its parent commit.

Median per-run p95: **370.2 ms first entry**, **349.7 ms revisit**, and **83.4 ms
frame interval** (per-run frame p95 range 83.3–83.4 ms). Renderer task CPU was
38.78 s, long-task total 8.01 s and retained heap 34.92 MB. This is still slow;
the correctness pass is not a smoothness or full-frame flicker certification.
The run used headless Chromium 153 at 1920×1080/DPR 1, not a visible native
audience window. Do not infer a renderer speedup from the difference against the
earlier run with overlapping local verification. Raw results are in local audience
history and the [standalone stress evidence](docs/rendering/evidence/native-stress-requested-2026-10-23.json).

Dirty `experimental/browser-native-renderer` candidate based on `e0dbef6`; these
measurements are not attributed to that parent commit and do not establish an
improvement over a paired baseline. See the [candidate evidence](docs/rendering/evidence/native-continuity-2026-10-23.json)
and [validation](docs/rendering/NATIVE_RENDERER_CONTINUITY_VALIDATION.md).

The small visible Electron native-glass fixture measured rAF intervals of
**3.4 ms p95 / 3.5 ms p99**, an **8 ms maximum gap**, and **87–100 ms** from seek
request to receipt of a matching native presentation capture. Capture was disabled
during pacing measurement. These are browser observations, not physical-display
latency measurements or proof of smoothness for a dense deck.

Three exploratory runs of the existing dense headless audience workload measured
median per-run p95 values of **435.3 ms first entry**, **410.8 ms revisit**, and
**100 ms frame interval**. That workload remains slow; passing its correctness
assertions is not a performance pass. Some other local verification overlapped
these runs. They are retained in local benchmark history and are not comparable
with the old clean-commit series below or the small native-glass fixture.

Native presentation subscription observed 62 of 609 renderer marker states in a
natural-rate two-second run and found no faults in those samples. It cannot prove
the absence of a one-refresh flash. A separate presentation-acknowledged sequence
observed every test state and detected all five deliberately injected faults.

## Glass/Motion follow-up — 2026-10-21

The clean `f620e6a15c86e83b9b314e3e8ffa3f182b37e505` build still stutters on
slide 4 of `ShowMe — Ideas in motion.sme`. This is a different workload from the
audience image/navigation measurements below and must not be compared with them.

| Lifecycle mode | Entrance frame gap p95 | Entrance maximum | Gaps over 33.34 ms | Steady p95 |
| --- | ---: | ---: | ---: | ---: |
| Cold entry | 133.3 ms | 183.4 ms | 12 | 16.8 ms |
| Warm replay | 83.4 ms | 100.0 ms | 12 | 16.8 ms |
| New audience navigation | 83.4 ms | 149.9 ms | 16 | 16.8 ms |

One run per lifecycle mode; Windows x64, Ryzen AI 9 365 / Radeon 880M,
Electron 44.4.1. Audience viewport 1596 × 998 DIP at DPR 1.6041666269302368.
The Presence entrance lasts 1440 ms; each observation lasts six seconds and keeps
the normal console/preview renderers. There were no missing assets or effect
errors. Frame gaps are audience rAF observations, not a physical display or GPU
occupancy measurement.

Exploratory dirty builds did not establish a smooth replacement. They are not
attributed to `f620e6a` and were excluded from the PR. The clean baseline and raw
explorations are retained in local benchmark history. See the
[measurement record](docs/rendering/evidence/backdrop-motion-performance-2026-10-21.json)
and [architecture follow-up](docs/rendering/COMPOSITING_ARCHITECTURE.md#real-deck-performance-follow-up-2026-10-21)
for provenance, reproduction and limits. This follow-up changes documentation and
measurement data only; it is exempt from the rendering commit/integration gate.

The latest clean audience workload measures **507.5 ms p95
for first-pass slide entry**, **487.9 ms p95 on revisits**,
and **116.6 ms p95 between animation frames** on the reference
machine. Sharing audience image variants with the editor stayed within the 20%
regression threshold for every metric against this session's paired baseline.

## Commit history

Each row represents three fresh browser runs. Values are medians of the three
per-run statistics; navigation columns are per-run p95 values.

| Measured date | Commit | First entry p95 | Revisit p95 | Frame interval p95 | Renderer task CPU | Retained JS heap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 2026-10-14 | [a2fdd07](https://github.com/KonradJuenger/ShowMe/commit/a2fdd07b8a3779a874d14b4af82392a5781eecf5) | 310.7 ms | 314.3 ms | 66.7 ms | 35.02 s | 32.10 MB |
| 2026-10-14 | [f9e1e05](https://github.com/KonradJuenger/ShowMe/commit/f9e1e05a7b2f63e3d9bebbe99aba297d687b5fcd) | 544.0 ms | 486.9 ms | 116.7 ms | 51.36 s | 32.24 MB |
| 2026-10-14 | [b18f33b](https://github.com/KonradJuenger/ShowMe/commit/b18f33bdc599da393b4963bb599435165bde7028) | 507.5 ms | 487.9 ms | 116.6 ms | 50.41 s | 32.23 MB |

Add rows for future rendering-affecting commits measured with the same workload
and environment. Keep different environments in separate series. Leave unmeasured
commits as gaps; documentation-only commits do not need measurements. Dirty
working-tree results are exploratory and must not be attributed to their parent
commit.

## Variation across the initial a2fdd07 runs

| Metric | Median | Minimum–maximum across runs |
| --- | ---: | ---: |
| First-entry p95 | 310.7 ms | 307.9–352.7 ms |
| Revisit p95 | 314.3 ms | 283.7–372.4 ms |
| Frame-interval p95 | 66.7 ms | 66.6–66.7 ms |
| Renderer task CPU | 35.02 s | 34.54–37.62 s |
| Long-task total | 934 ms | 698–2,226 ms |
| Retained JS heap after GC | 32.10 MB | 32.10–32.14 MB |

Memory uses decimal MB. The measured checkout was clean. All three stress runs
passed the rendering checks, including shader text pixels and all 96 image
variants; resident slide count peaked at four.

## What the benchmark renders

- 30 synthetic slides, 87 elements per slide: 12 images, 39 wrapped text blocks
  and 36 shapes.
- 96 distinct patterned image assets across the deck.
- Three animated GLSL text panels per slide, each 580 × 280 pixels with 16
  texture samples per pixel; six CSS effects and 24 live motion tracks per slide.
- Two sequential passes, 58 measured slide entries per run, with animation dwell.
- Canonical audience rendering, image decode, fonts and effect preparation.

Workload version: **2**. Reference environment: **Windows x64, AMD Ryzen AI 9 365,
20 logical CPUs, approximately 32 GB RAM, headless Chromium 153, 1920 × 1080,
DPR 1, Vite development server**.

Navigation timing includes readiness and two animation frames. Frame intervals
include scheduling and rendering stalls. CPU is summed renderer task time over
the entire measured pass. Heap is retained JavaScript memory after explicit GC;
image/GPU/process memory needs separate measurement. Image IO uses generated
cached rasters. Native original resizing and Lanczos quality have separate tests.
These results describe this demanding browser workload; native release and
physical display performance require their own comparable measurements.

## Measure the next commit

Run the required correctness gate for changes that can affect rendering, then
record a repeated benchmark of the clean task-branch commit:

```powershell
npm run test:feature -- presenter
npm run benchmark:audience -- --output test-results-audience-current
```

Each benchmark appends to `.benchmark-data/audience/history.jsonl` and updates
the interactive `.benchmark-data/audience/history.html`. The chart shows commit
hashes, metrics, percentage changes and run ranges. The persistent directory
survives report cleanup and branch switches; back it up when moving checkouts.

To compare with a saved reference and fail on costs more than 20% higher:

```powershell
npm run benchmark:audience -- --baseline test-results-audience-commit-reference/report.json --output test-results-audience-current
```

The reference for this row was produced with
`npm run benchmark:audience -- --runs 3 --output test-results-audience-commit-reference`.
Re-run apparent regressions under matched conditions and consider the repeated-run
range. See [benchmark methodology and limitations](docs/audience-rendering-benchmark.md).

## Shared editor and audience variants: 2026-10-14

The paired clean measurements compare upstream `f9e1e05` with implementation
`b18f33b`. Both use three fresh Chromium runs, workload version 2 and the same
recorded Windows/CPU/browser/viewport/DPR environment described above.

| Metric | Before (f9e1e05) | Shared variants (b18f33b) | Change | Current minimum–maximum |
| --- | ---: | ---: | ---: | ---: |
| First-entry p95 | 544.0 ms | 507.5 ms | -6.71% | 493.9–516.3 ms |
| Revisit p95 | 486.9 ms | 487.9 ms | +0.21% | 475.1–513.7 ms |
| Frame-interval p95 | 116.7 ms | 116.6 ms | -0.09% | 116.6–116.7 ms |
| Renderer task CPU | 51.36 s | 50.41 s | -1.83% | 50.36–51.60 s |
| Long-task total | 12831 ms | 12313 ms | -4.04% | 11640–12923 ms |
| Retained JS heap after GC | 32.24 MB | 32.23 MB | -0.05% | 32.15–32.25 MB |

Every cost remained within the configured 20% regression limit. All three runs
passed the dense rendering checks, retained all 96 image variants and peaked at
four resident slides. The small differences are observations, not an established
speed improvement. This synthetic audience workload does not measure original
image resizing or editor first-load latency. Production browser checks separately
verify shared editor/audience variants, zero new variants on canvas zoom and
matching dimensions when the audience output changes; native capture verifies
that thumbnails generate no additional image variants.

The earlier `a2fdd07` run has the same recorded machine/workload configuration
but much lower timings (310.7 ms first-entry p95 and 66.7 ms frame-interval p95).
This session's baseline was already slower before the editor change. Background
load, power and GPU conditions were not controlled sufficiently to attribute
that historical difference to code; the paired before/after measurements are
the relevant comparison for this change.

Exact measurement commands, run from the isolated task worktree:

```powershell
npm run benchmark:audience -- --output test-results-audience-shared-baseline --history D:/local_programming/showme-release/.benchmark-data/audience
npm run benchmark:audience -- --baseline test-results-audience-shared-baseline/report.json --output test-results-audience-shared-current --history D:/local_programming/showme-release/.benchmark-data/audience
```

Both measurements were clean commits; the default run count was three. Reports
and per-run screenshots remain in the named output directories. The persistent
JSONL history and interactive HTML remain in the explicit history directory.

Verification of `b18f33b`:

- `npm run test:feature -- media`: 35 unit, 8 browser and 2 Electron tests passed.
- `npm run test:feature -- presenter`: 22 unit, 11 browser and 1 Electron tests
  passed. Both declarations in `audience-navigation.spec.ts` executed and passed,
  including the full dense stress workload.
- `npm test`: 15 core tests passed.
- `npm run typecheck`, `npm run lint`, `npm run test:stats` and
  `npm run test:audit` passed; the registry contains 403 active tests.
- `git diff --check` passed. The full, extended and release/package suites and
  macOS checks were not run; media and presenter include the relevant browser
  and native Electron boundaries.

The document authority, persistence and stored formats are unchanged. Gesture
deferral, original-image fallback, decoded URL ownership and audience readiness
remain covered. The follow-up commit only records these benchmark results in
this Markdown file and is exempt from rerunning the rendering gate because it
cannot affect rendering, capture, layout, sizing, visibility or performance.


## Native cold-open cache review correction — 2026-10-15

Three clean runs of `b217cb6b64e6c82729176f17e73ebdd1a68fcc4e` compared with
three clean runs of `047bc65d313ee2ae703a74c43b0f6e73f16a42dd`. The latter
separates presentation readiness from background precaching and reduces native
image admission to two jobs; browser CPU sizing remains unchanged. The earlier
`b18f33b` measurements above cover a different synthetic rendering workload.

Environment: AMD Ryzen AI 9 365 w/ Radeon 880M; 20 logical threads;
Windows, Electron 44.4.1, Node v26.3.0, libuv default (4).
Audience profile 2561 × 1601; editor 1429 × 886 DIP at DPR 1.6041666269302368.
The same compiled harness measured both freshly built revisions, with no other
verification running alongside either group. These were sequential baseline then
candidate groups, not interleaved trials.

Workload: 24 visible patterned 2048 × 1536 PNG sources and two 6000 × 4000
background-only sources (one hidden slide and one hidden layer), using real Sharp
processing and PNG cache encoding. Every run used a fresh app process, temporary
Library/user data and empty derived cache. Fixture generation was excluded; source
files were freshly written and could be warm in the OS file cache. All six runs
finished all 26 jobs. The baseline created seven workers each run; the candidate
created two each run.

Values are **median [minimum–maximum]** across three runs.

| Metric | b217cb6 | 047bc65 |
| --- | ---: | ---: |
| Editor available (ms) | 1115.9 [1006.2–1270.6] | 869.5 [829.7–1069.5] |
| Visible variants ready (s) | 3.605 [3.593–3.720] | 4.335 [4.330–4.907] |
| Present to visible active renderer (s) | 4.691 [1.696–8.506] | 1.851 [0.720–5.069] |
| Whole cache ready (s) | 8.850 [5.308–15.044] | 6.990 [6.255–14.374] |
| App CPU time (s) | 18.130 [17.123–18.566] | 16.889 [15.966–17.858] |
| Peak main RSS (MiB) | 529.4 [528.8–548.8] | 367.8 [359.9–393.5] |
| Peak summed process working sets (MiB) | 2278.4 [2133.0–2379.8] | 2026.2 [1927.0–2049.9] |
| Main IPC p95 (ms) | 25.1 [23.4–25.4] | 22.0 [19.4–25.1] |
| Main IPC max (ms) | 49.8 [31.6–61.7] | 32.9 [30.6–44.7] |
| Editor frame gap p95 (ms) | 16.9 [16.8–17.0] | 16.9 [16.9–16.9] |
| Editor frame gap max (ms) | 233.3 [106.3–299.6] | 216.5 [104.9–299.9] |
| Editor long-task count | 1.0 [1.0–1.0] | 1.0 [1.0–1.0] |
| Editor long-task total (ms) | 133.0 [127.0–136.0] | 112.0 [112.0–129.0] |

Median visible-cache preparation increased by 20.3%, a throughput cost of the
smaller native admission limit in this combined candidate. This comparison does
not isolate concurrency from readiness/priority changes. Median peak main RSS
fell by 30.5%; median app
CPU fell by 6.8%. CPU covers startup, rendering, IO and encoding across app
processes, not encoding alone. Frame-gap p95 stayed at 16.9 ms, but 105–300 ms
startup gaps and 112–129 ms long tasks remain in the candidate; this is not a
guarantee of stall-free editing. Main IPC p95 was 19–25 ms in candidate runs.

Present and total elapsed times varied widely in both groups. Their medians
fell, but these three-run, non-interleaved observations do not establish a
general speedup. In one candidate run the active audience appeared while
whole-deck status was still preparing; in the other two, hidden work had finished
by audience activation. All baseline runs reached whole-cache ready before
activation. Deterministic tests separately hold hidden work pending/failing and
verify that it cannot hold presentation readiness.

Present timing ends at a visible active audience renderer; it is not a pixel
readback or keyboard-latency measurement.

Memory is sampled at roughly 100 ms plus IPC latency after the first window
appears. Main RSS is
process resident memory; summed working sets may double-count shared pages and
exclude GPU allocations. Short peaks before/between samples can be missed.
Frame/long-task samples stop before Present so editor occlusion cannot inflate
those gaps. See `docs/audience-rendering-benchmark.md` for methodology.

Commands, for each clean revision after `npm run build`:

`node .agenttmp/image-cache-benchmark.cjs --runs 3 --output .benchmark-data/image-cache/<revision>`

The common harness was compiled from 047bc65. Raw reports remain in
`.benchmark-data/image-cache/b217cb6/report.json` and
`.benchmark-data/image-cache/047bc65/report.json`. New runs can use
`npm run benchmark:images -- --runs 3 --output <directory>`.

Verification for 047bc65: 26 focused unit tests, two native cold-open/display
tests and both mandatory audience-navigation declarations passed. Build,
typecheck, changed-file lint, stats and registry audit passed (414 active tests).
The full/release suites and macOS were not run. This follow-up commit only records
measurements in Markdown; its contents cannot affect rendering or cache behavior.

## Glass Presence entry synchronization — 2026-10-21

The real slide-4 flicker was confirmed before changing code: the native card
painted at opacity 1 while Motion alpha was 0.0109461 and its restoration bitmap
was empty. Subsequent restoration alpha and placement lagged the Motion sample.
The fix gates content visibility with the existing populated flag, synchronizes
placement/inverse alpha with Motion, and reveals both parts after publication.
DOM reads are batched before writes. The compositor remains
`native-backdrop-restore`; no alternate Motion state or timed delay was added.

Clean production observations on the same Windows / Electron 44.4.1 machine,
original `ShowMe — Ideas in motion.sme` slide 4, normal console/preview, isolated
library/user data, 1440 ms Presence entrance and six-second observation:

| Lifecycle | Before fix `fd0dafb` entrance p95 | Final `fe30101` entrance p95 | Final maximum entrance gap |
| --- | ---: | ---: | ---: |
| Cold entry | 50.1 ms | 66.5 ms | 99.9 ms |
| Warm replay | 33.4 ms | 17.0 ms | 33.5 ms |
| New audience navigation | 33.3 ms | 33.4 ms | 66.6 ms |

Final steady p95 was 16.8 ms in every mode, with occasional 33–117 ms gaps.
All entrances used three restoration overlays, zero CSS replay outputs and no
effect errors or missing assets. The warm audience entrance trace had 6.805 ms
of Paint and no `ReadbackImagePixels` / `WaitForGetOffset` events. Warm playback
retains good cadence, but cold entry and occasional stalls remain. One sequential
observation per mode/revision cannot establish uniform smoothness or a general
speedup. These are instrumented rAF gaps, not physical display delivery.

The unbatched readiness iteration (`b3bf87d`) increased style resolution work;
batching reduced warm entrance UpdateLayoutTree time from 54.938 to 36.687 ms.
These are trace observations, not an isolated causal performance experiment.
An initial final-candidate measurement lost its audience window after replay;
it is retained locally as incomplete and excluded from the table. The subsequent
complete run exited normally. Raw traces/samples remain under
`test-results-compositing-fe30101-complete`; append-only history is in
`.benchmark-data/animation/history.jsonl`. The
[compact record](docs/rendering/evidence/presence-restoration-performance-2026-10-21.json)
contains build/source digests, environment, all completed observations and trace
totals. The helper derives from Git blob
`1e0a8936ca1dcd3475be87cb220a94047ffbd090`, adding backend/alpha and process-exit
diagnostics. Command after `npm run build`:

```powershell
$env:SHOWME_BENCHMARK_OUTPUT='test-results-compositing-fe30101-complete'
node .agenttmp/benchmark-backdrop-observed.mjs '<path-to-original.sme>' 4
```

The entrance regression and all seven native-composition tests pass, including
filled/rounded Move In and cancellation. CSS backdrop/mixed composition and both
audience-navigation declarations pass (25 browser declarations; gate repeated
separately, two passed). Build including TypeScript, changed-file ESLint, registry
stats/audit (635 active tests) and whitespace checks pass. The real slide-4 entry
filmstrip was reviewed without the flash; 134 visible partial-alpha samples had
populated restoration and matching inverse alpha. Full/release, packaging,
macOS and explicit export visual checks were not run. No main integration.

## 2026-10-22: semantic coordination and cropped restoration

Clean renderer `506fd7c`, original slide 4, Windows/Electron 44.4.1, production
build, normal console/preview, isolated library/user data, 1440 ms entrance and
six-second observation. One sequential observation per mode, without concurrent
tests/builds:

| Lifecycle | Entrance p95 gap | Maximum entrance gap | Steady p95 gap |
| --- | ---: | ---: | ---: |
| Cold entry | 33.3 ms | 50.7 ms | 16.8 ms |
| Warm replay | 16.8 ms | 16.9 ms | 16.8 ms |
| New audience navigation | 16.8 ms | 33.3 ms | 16.8 ms |

Cold entrance retained three gaps over 33.34 ms; warm/new-audience entrance and
all steady intervals had none. All modes used three `native-backdrop-restore`
outputs, zero CSS replay outputs and no effect errors or missing assets. The user
also reported good deck performance. These rAF observations do not establish
physical display delivery, uniform smoothness or a controlled speedup.

The refactor shares semantic Motion samples, prepares cropped restoration before
entry and centralizes backend policy. An intermediate `cba8c57` cold trace showed
editor GPU allocation waits while the audience main-thread maximum task was
6.1 ms. The final renderer reuses the shader presentation buffer across smaller
outputs; multi-scale pixel/alpha/orientation, context-loss and idle-release tests
pass. Final timing does not establish elimination of every cold stall.

After `npm run build`:

```powershell
$env:SHOWME_BENCHMARK_OUTPUT='test-results-compositing-final-coordination'
node .agenttmp/benchmark-clean-composition.mjs '<path-to-original.sme>' 4
```

The helper derives from Git blob `1e0a8936ca1dcd3475be87cb220a94047ffbd090`,
observing restoration alpha without the removed hidden DOM proxy. Electron exited
normally with code 0. Raw traces remain in the output directory and append-only
history in `.benchmark-data/animation/history.jsonl`.
[Compact evidence](docs/rendering/evidence/composition-coordination-2026-10-22.json)
records clean revision, source/build/helper digests, environment, all timing
summaries, regression results and the final real-deck entrance probe.

## 2026-10-22: static image background follow-up

Clean production renderer `229bffc`, supplied
`ShowMe — Ideas in motion-imagebg.sme` slide 4, normal console/preview, isolated
library/user data, 1440 ms Presence entrance and six-second observation. The helper
also copies template assets into the isolated library. No tests/build ran alongside
the measurement. Electron exited with code 0.

| Lifecycle | Entrance p95 gap | Maximum entrance gap | Steady p95 gap |
| --- | ---: | ---: | ---: |
| Cold entry | 16.5 ms | 110.0 ms | 12.7 ms |
| Warm replay | 18.2 ms | 22.8 ms | 9.7 ms |
| New audience navigation | 17.4 ms | 33.2 ms | 11.5 ms |

Cold entry had one gap over 33.34 ms; the other entrance and steady intervals had
none. All modes used three restoration outputs, zero CSS replay outputs, no
missing assets and no effect errors. Static images do not need continuous shader
publication. This is a different workload from the procedural-background deck;
the observations are not a controlled speedup comparison or a claim of physical
display delivery. A long cold gap remains.

After `npm run build`:

```powershell
$env:SHOWME_BENCHMARK_OUTPUT='test-results-imagebg-restoration'
node .agenttmp/benchmark-imagebg.mjs '<path-to-image-background.sme>' 4
```

[Compact evidence](docs/rendering/evidence/image-background-restoration-2026-10-22.json)
contains clean revision, environment, source/build/helper digests, timings and the
real-deck finish probe. The native glass selection passed 11 declarations, CSS/
mixed composition and both audience-navigation tests passed 26, effects/Motion
units passed 138, and build/static/registry checks passed (642 active tests).
Full/release, packaging, macOS and explicit export visual checks were not run.
