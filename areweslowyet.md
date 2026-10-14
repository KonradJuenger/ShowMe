# Are we slow yet?

The dense audience workload currently takes **311 ms p95 for first-pass slide
entry**, **314 ms p95 on revisits**, and **66.7 ms p95 between animation frames**
on the reference machine. This is the first clean-commit baseline. Future
comparable measurements will show whether rendering improves or regresses.

## Commit history

Each row represents three fresh browser runs. Values are medians of the three
per-run statistics; navigation columns are per-run p95 values.

| Measured date | Commit | First entry p95 | Revisit p95 | Frame interval p95 | Renderer task CPU | Retained JS heap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 2026-10-14 | [a2fdd07](https://github.com/KonradJuenger/ShowMe/commit/a2fdd07b8a3779a874d14b4af82392a5781eecf5) | 310.7 ms | 314.3 ms | 66.7 ms | 35.02 s | 32.10 MB |

Add rows for future rendering-affecting commits measured with the same workload
and environment. Keep different environments in separate series. Leave unmeasured
commits as gaps; documentation-only commits do not need measurements. Dirty
working-tree results are exploratory and must not be attributed to their parent
commit.

## Variation across the three runs

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
