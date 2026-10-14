# Audience rendering regression benchmark

The mandatory `tests/feature/presenter/audience-navigation.spec.ts` now contains
the deterministic late-image gate and a real-clock rendering stress test. Both
run with `npm run test:feature -- presenter` and protect the audience renderer.

The stress test uses a fixed 30-slide synthetic scene. Each slide has 12 images,
39 wrapped text blocks, 36 shapes, three continuously animated GLSL effects,
six CSS effects and 24 real motion tracks. The deck uses 96 patterned image
assets; each shader composites a 580 × 280 panel of wrapped text with 16 texture
samples per pixel. Two sequential passes measure 58
entries at 1920 × 1080, with animation dwell between entries. It verifies live
motion and shader clocks, opaque shader pixel output, no runtime/effect errors,
bounded resident slide count and no new prepared variants on revisits.

Each run writes and attaches `audience-stress.json` plus a screenshot in the
Playwright output directory. The report includes individual navigation samples,
p50/p95/max latency, frame intervals, long tasks, renderer task CPU time, end-of-run
JS heap and DOM node counts after explicit garbage collection, image
requests/decodes and preparation timing spans. GC runs outside timed sampling.
The pixel check requires captured text in each shader panel, not just a ready
canvas. It caught inherited audience-wrapper visibility blanking shader inputs;
inactive compositions now use opacity and disable pointer events instead.
Navigation latency ends after readiness and two animation frames; it is not
a measurement of monitor scanout or a guarantee of GPU completion. Frame intervals
include rendering, navigation and scheduling stalls. JS heap is not total process,
decoded image or GPU memory. First/revisit labels describe compositions: the test
IO provider generates cached synthetic rasters, rather than resizing real originals.
Native cache, Lanczos and fallback behavior remain covered by their existing tests.
This benchmark uses the Vite development server and headless Chromium. Its
relative results are useful within that runtime; they are not native Electron
release performance numbers.

## Native cold-open image cache measurements

The native image benchmark uses the built Electron app and real Sharp work:

```powershell
npm run build
npm run benchmark:images -- --runs 3 --output .benchmark-data/image-cache/current
```

Each run creates a separate temporary Library, user-data directory and empty
derived cache. The workload is 24 visible 2048 × 1536 patterned PNG sources,
one hidden-slide 6000 × 4000 source and another 6000 × 4000 source in a hidden
layer. Fixture generation is excluded from timings. Source file data may already
be in the OS file cache; this measures a cold derived cache, not a cold disk.

The report records the source revision and dirty state, machine/runtime/output
geometry, editor startup, all-visible-variants completion, Present startup while
background work remains, and whole-deck completion. It samples Electron process
CPU counters, main-process RSS, the sum of process working sets, main IPC response
latency, and editor rAF gaps/long tasks before pressing Present. Summed working
sets can count shared pages more than once; they are not unique physical memory
or GPU memory. Sampling starts when the first window is available and can miss
short peaks. GUI/window startup is included in app CPU and elapsed timings.

Compare repeated runs from matching clean builds on the same machine and display
setup. The runner compiles to `.agenttmp/image-cache-benchmark.cjs`; that same
compiled measurement harness can measure an older build lacking this command.
Keep raw JSON locally and summarize medians and ranges in `areweslowyet.md`.
Native measurements and the synthetic audience renderer benchmark are separate
workloads; neither establishes the other's performance.

Capture a local baseline with three fresh browser runs:

```powershell
npm run benchmark:audience -- --output test-results-audience-baseline
```

After a change, compare against it:

```powershell
npm run benchmark:audience -- --baseline test-results-audience-baseline/report.json --output test-results-audience-current
```

The command emits per-run JSON, `report.json` with medians across runs, and
`comparison.json` when comparing. Positive percentage changes mean higher costs;
negative changes mean lower costs. A cost increase beyond 20% returns a failing
exit code. Choose a different explicit tolerance with `--max-regression-percent`;
choose repeated runs with `--runs` (default 3). Zero-valued baseline metrics are
reported without a percentage comparison. Reports are generated outputs and are
not committed as portable golden performance numbers.

Use `--compare-only` to compare an existing output directory's `report.json`
against a baseline without running Chromium again. This retains the original
report's revision and environment. It also makes saved reports useful for review.

Comparison requires matching workload version, machine/CPU, Chromium version,
viewport, DPR and run count. Use the same power/GPU settings and minimize other
work; those conditions cannot all be detected automatically. Re-run an apparent
regression to distinguish repeatable cost from system noise. A changed workload
or environment needs a new baseline. Revision and dirty state are recorded.

Every new benchmark measurement also appends to
`.benchmark-data/audience/history.jsonl` and rebuilds `history.html` there. This
directory is ignored by Git, survives `npm run clean:reports`, and persists across
branch switches. Keep or back up it when moving the checkout. `--history <dir>`
selects another persistent store. `--history-only` rebuilds the view without
measuring again; comparisons alone do not append duplicate observations.

Open `.benchmark-data/audience/history.html` to select a comparable series and a
metric. The chart and table show measured commit hashes, branches, timestamps,
percentage changes and min/max repeated-run ranges around each median. Separate
series isolate machine identity, workload, runtime/output environment and run
count. The default view shows clean commit measurements; dirty runs can be shown
as clearly labeled exploratory points. Unmeasured commits are gaps, not invented
performance values. Use the same test machine and workload over time and record a
clean measurement of each rendering-affecting revision after committing it on
the task branch. A baseline comparison explains one change; history explains the
longer trend. Do not infer a trend from one point or a noisy single run.

Ordinary feature verification retains deterministic correctness gates and reports
timing without an arbitrary universal speed threshold. The explicit benchmark
comparison is the performance gate for a controlled machine baseline. Use it
before integrating rendering/performance changes; the existing mandatory audience
test remains required for changes that can affect rendering. Documentation-only
changes and cosmetic CSS unrelated to rendering/capture/layout/performance are
exempt. Render-affecting CSS still requires the test. No version or document format change
is involved.

Verification: `npm run test:feature -- presenter` passed 21 unit, 11 browser
and 1 Electron tests; `npm run benchmark:audience -- --runs 3 --output
test-results-audience-reference-visible-text` passed three stress runs with shader
text pixels verified. History unit coverage checks persisted commit samples and
separation of incompatible environments. `npm test` passed
15 core tests. Typecheck, lint, stats and registry audit passed. Comparison checks
accepted identical reports, rejected deliberately doubled costs and rejected an
environment mismatch. The full suite, macOS and release/package checks were not
rerun for this test/tooling change.
