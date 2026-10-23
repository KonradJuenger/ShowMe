# Are we slow yet?

## Paired renderer follow-up — 2026-10-23

Three clean serial alternating main/candidate pairs now replace the earlier dirty
attribution as the current comparison. Main production `1778927`, common-harness
baseline `706ee07`, candidate `a8596f2`; identical harness SHA-256 and machine.
Windows x64 / Ryzen AI 9 365, headless Chromium 153 / SwiftShader, DPR 1; isolated
1280×720 and mixed 1920×1080. No concurrent verification jobs.

| Metric (ms unless stated)      | Main median [min, max]   | Candidate median [min, max] | Change |
| ------------------------------ | ------------------------ | --------------------------- | ------ |
| Native task CPU                | 534.8 [528.6, 538.8]     | 59.6 [56.4, 65.8]           | -88.9% |
| Generated task CPU             | 445.2 [440.3, 454.9]     | 247.1 [244.3, 247.5]        | -44.5% |
| SceneTexture task CPU          | 68.2 [67.1, 76.1]        | 59.0 [57.8, 60.6]           | -13.5% |
| SceneTexture revisit readiness | 40.1 [39.0, 40.9]        | 34.8 [31.2, 35.5]           | -13.2% |
| Mixed first navigation p95     | 366.2 [361.7, 486.4]     | 254.9 [253.3, 256.2]        | -30.4% |
| Mixed revisit navigation p95   | 375.9 [364.3, 512.9]     | 244.7 [243.3, 248.2]        | -34.9% |
| Mixed frame interval p95       | 83.4 [83.4, 100.0]       | 50.0 [50.0, 50.0]           | -40.0% |
| Mixed task CPU (s)             | 39.5 [39.5, 44.5]        | 30.9 [30.9, 31.3]           | -21.7% |
| Mixed long-task total          | 8337.0 [8225.0, 11181.0] | 175.0 [120.0, 227.0]        | -97.9% |
| Mixed JS heap (MB)             | 35.5 [35.4, 35.5]        | 35.3 [35.3, 35.3]           | -0.7%  |

Native computed-style reads were 3924 → 0; generated Canvas2D copies 240 → 0;
static SceneTexture revisit captures 1 → 0. First SceneTexture style reads rose
6 → 9. The shared GPU context painted 16/24/32 outputs with either preservation
setting across three repetitions each; production uses preservation false.

The mixed workload is still slow. These are headless software-GPU improvements,
not paired hardware-GPU or physical-display results. One visible Electron
seek-budget check missed at 102 ms (limit 100); isolated repeat passed at 80–92 ms.
Superseded experimental attribution remains available in Git history.

Exact commands, workload contract, ranges, limits and verification:
[current validation](docs/rendering/DIRECT_GPU_RENDERER_VALIDATION.md).
Persistent data: [paired](docs/rendering/evidence/renderer-paired-2026-10-23.json),
[context study](docs/rendering/evidence/shader-contexts-2026-10-23.json).

## Audience console ablation — 2026-10-23

Exploratory dirty production build including the capture-progress fix; hardware
Electron / Radeon 880M D3D11. Three serial alternating 10-second runs per mode,
1596×998 CSS viewport, DPR 1.6042. The original app remained running; no other
verification jobs ran. Presenter-disabled replaces its renderer with about:blank
before console load, retaining the audience session and editor.

| Metric | Normal median [min, max] | Presenter disabled median [min, max] |
| --- | --- | --- |
| Audience rAF FPS | 21.7 [20.9, 22.3] | 28.8 [26.6, 30.9] |
| Glass updates/sec | 10.7 [10.3, 11.1] | 14.4 [13.2, 15.4] |
| Frame interval p95, ms | 83.6 [83.5, 100.0] | 66.7 [51.5, 66.9] |

Disabling the presenter improved median audience FPS by 33%; still well below
60 FPS. Layout/style-recalculation duration was below 1% of elapsed window time.
Separate CPU profiling with presenter off attributed about 13.3% of audience and
18.1% of editor samples to WebGL error/object-validity probes. The shader draw
function accounted for 14.7% and 31.0% respectively. Unattributed native/program
samples were 57.5% and 36.2%; they cannot be labeled as precise GPU time.
Editor animation/capture continues during presentation. The glass publishes at
about half the audience frame cadence, consistent with its asynchronous capture
pipeline. These are diagnostic observations, not a shipped console-disable feature
or physical-display FPS. No current document or user preferences were changed.

[Raw comparison and profile shares](docs/rendering/evidence/audience-console-ablation-2026-10-23.json).
