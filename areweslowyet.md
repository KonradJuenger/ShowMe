# Are we slow yet?

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
