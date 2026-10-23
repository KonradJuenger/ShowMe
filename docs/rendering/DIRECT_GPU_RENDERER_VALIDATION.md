# Direct GPU renderer validation

Branch: `experimental/browser-native-renderer`. PR #18 remains unmerged.

## Current rendering ownership

```text
Ordinary content:        ShowMe DOM → Chromium
Motion:                  semantic values → bound native properties
Generated shader:        shared Offscreen WebGL → GPU ImageBitmap → visible canvas
Compatible shader stage: shared GPU texture → GLSL → texture / visible bitmap
Qualified image/video:   owned media → GPU texture → GLSL
Flattened scene input:   explicit SceneTexture → GPU texture → GLSL
```

All mounted shader chains in a renderer share one WebGL2 context. The visible
canvases use `bitmaprenderer`; synchronous `transferToImageBitmap()` and
`transferFromImageBitmap()` publish output during the existing Effect flush.
There is no terminal Canvas2D `drawImage` bridge and no additional presentation
clock, atlas, general compositor or document architecture.

Production uses `preserveDrawingBuffer: false`. Ordinary generated terminal
shaders draw into the shared default framebuffer without allocating output FBOs.
Intermediate shader stages keep GPU FBOs. Explicit downstream sampling promotes
an already visible output into a retained GPU texture once; subsequent draws of
that sampled output use an FBO and GPU blit before bitmap presentation. This
exceptional promotion does not re-run asynchronous capture or advance timing.

A previous per-chain context candidate hit Chromium's 16-context limit at 24/32
chains with either preservation flag. That dirty single-run diagnostic motivated
the bounded architecture; it is not paired performance evidence. The final
16/24/32-chain tests verify every visible output, one active context and released
chain ownership. The shared context remains resident with a 1×1 drawing buffer
when idle. Context loss invalidates all chains; restoration rebuilds programs,
buffers, FBOs and input uploads and schedules the existing redraw callbacks.

GPU bitmap transport and shared-buffer resizing have costs. Eliminating a
Canvas2D call is not proof of a speedup or zero driver copies. Capability failure
is diagnosed and leaves the original Element visible.

## Semantic updates and SceneTexture

Motion supplies logical transforms and output density; Effect targets are bound
once per mounted semantic tree. Media nodes are bound at mount/load. Ordinary
Motion does not discover Effect descendants or rebuild captures each frame.
Arbitrary document stylesheets retain conservative computed-dimension discovery.

Direct media qualification is narrow: an undecorated full-frame rectangular
image/video with unit content opacity and neutral media transform. Crops, custom
geometry, rounded decoration, children, intervening CSS and arbitrary document
stylesheets still require SceneTexture. Persisted `none | content | backdrop`
semantics, Effect ordering and document formats are unchanged.

Static, stylesheet-free, motion-free sources without video or contributing
Effects use an eight-idle-entry pixel cache. Successful capture copies its pixels
once into an immutable canvas and immediately disposes the old DOM capture,
mirrors, observers and listeners. Unfinished captures are not retained on unmount.
CPU pixels survive revisits; GPU uploads are owned per WebGL context and released
when the last consumer of that context leaves. Alternating consumers in two
contexts reuse their separate textures instead of deleting each other's uploads.

SceneTexture qualification, recursive semantic checks, backdrop prefixes and
serialized revision keys are cached against accepted slide/text-style/resource
references, stylesheet and font epoch. Repeated static acquires check these cheap
identities. Source changes and font completion invalidate retained pixels. Dynamic
sources keep conservative observation and are not promised zero-capture revisits.
The retained-pixel budget is entry-based, so very large static snapshots can still
consume substantial memory.

The unused compositor island was removed: `compositionSurface.ts`,
`compositionRuntime.ts`, `backdropRestoration.ts`, `cssBackdrop.ts`,
`cssBackdropOutput.ts` and `legacyCssBackdropValidation.ts`, along with tests
selecting those obsolete backends. Semantic paint planning remains;
`elementRaster.ts` and `domRaster.ts` are reachable only behind SceneTexture.

## Comparable measurement contract

Native, generated input-none, retained SceneTexture and dense mixed workloads are
separate. CPU/style/layout measurements bracket the sampled region after fixture
construction and warmup. Actual computed-style reads, selectors, Canvas2D copies,
WebGL allocations and compilations are instrumented. Validation pixel readbacks
and GPU provenance probes occur after timing. Unavailable baseline diagnostics
are labeled rather than treated as measured zeros.

Mixed workload version 3 preserves all 30 slides, dimensioned gradient/checker
images, text, CSS/GLSL, live Motion, navigation and four-slide residency checks.
Fixture PNG construction finishes before mounting; timed navigation contains no
synchronous PNG generation. Older one-pixel or timed-PNG results are incomparable.

The paired runner requires clean checkouts and matching harness hashes,
CPU/platform/browser/viewport/DPR; it alternates main+common-harness and candidate
serially. Raw local history is under `.benchmark-data/renderer/final-paired`.
Headless results are separate from visible hardware Electron observations and do
not measure physical-display latency or prove absence of a one-refresh flash.

## Paired clean-commit results — 2026-10-23

Candidate: `a8596f2903c41fb980425e9fff6f2cab7b31a27f`. Main production:
`1778927f699dd932e2ac627ecd749772060fef2d`; common-harness baseline commit
`706ee07bb97224c527c28731190394db91afc472` changes no production files.
Both clean checkouts used harness SHA-256
`a4ba190e5c6c88abd9c1b7d1de81cddf1c6a66b635fd754ec18ab88eadff8dee`.
Windows x64, Ryzen AI 9 365, 20 logical CPUs; headless Chromium
153.0.8010.12, ANGLE/Vulkan **SwiftShader**, DPR 1. Isolated workloads use
1280×720; mixed uses 1920×1080. Three serial alternating pairs, no concurrent
verification jobs. Values are medians of three per-run measurements with min/max,
not pooled frame percentiles or confidence intervals.

Command:

`node scripts/benchmark-renderer-paired.mjs D:/local_programming/showme/ShowMe-renderer-baseline .benchmark-data/renderer/final-paired 3`

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

Native workload (60 sampled updates): computed-style reads **3924 → 0**, selector
queries **1303 → 0**, captures **60 → 0**, clones **1 → 0**, style recalculations
**451–453 → 59**, layouts **170 → 1**. Native and generated frame p95 stayed
about 16.7 ms, so their lower CPU is not a demonstrated refresh-rate increase.
Generated output made **240 → 0** Canvas2D copies across four chains and 60
updates; candidate steady capture, compilation and output-FBO allocation counts
were zero. One GPU context serves all four chains.

SceneTexture first preparation still captures once; first-capture computed-style
reads increased **6 → 9**. Static revisit captures fell **1 → 0**, with one retained
reuse. This small fixture does not establish preparation cost for arbitrary CSS,
video or dynamic scenes. Separate unit coverage alternates two GPU contexts for
20 frames without repeated uploads; pixel-retention coverage disposes capture
machinery, releases GPU ownership on unmount and invalidates on font completion.

The mixed workload retains 30 slides, 12 images / 39 texts / 36 shapes / 3 shaders /
6 CSS Effects / 24 Motion tracks per slide, 96 distinct image assets and bounded
four-slide residency. All six dense correctness runs passed. Navigation remains
expensive and its 50 ms candidate frame p95 remains far from smooth 60 Hz.
These results establish an improvement for these matched headless workloads,
not a hardware-GPU speedup or universal document performance claim.

Persistent summary: [paired evidence](evidence/renderer-paired-2026-10-23.json).
The baseline checkout is detached and local; it can be recreated from main by
copying the hashed common benchmark/fixture files from the measured candidate.

## Context capacity and preservation study

`node scripts/benchmark-shader-contexts.mjs .benchmark-data/renderer/bounded-context-study.json`
ran each count with preservation false/true in serial alternating order, three
repetitions, on clean `a8596f2` in the same headless browser. Each sample advances
60 frames. The actual WebGL attribute was checked, not just the requested flag.

| Chains | Preserve false CPU ms   | Preserve true CPU ms    | Active contexts / painted outputs |
| ------ | ----------------------- | ----------------------- | --------------------------------- |
| 16     | 607.8 [592.2, 641.4]    | 630.7 [607.5, 652.5]    | 1 / 16                            |
| 24     | 844.9 [826.1, 852.6]    | 838.1 [817.6, 843.9]    | 1 / 24                            |
| 32     | 1047.1 [1030.8, 1133.2] | 1162.6 [1137.2, 1178.3] | 1 / 32                            |

All **18 runs** painted every output, reported no shader errors and released
active chain/context ownership after disposal. CPU ranges overlap at 16/24 chains;
this does not show preservation is uniformly slower. Production false avoids
requiring preserved default pixels: bitmap publication owns visible pixels, and
only explicitly sampled outputs retain FBOs. This study measures CPU/correctness,
not GPU memory bandwidth or physical presentation. See [context evidence](evidence/shader-contexts-2026-10-23.json).

## Verification of the measured renderer

PowerShell invocations (set `SHOWME_TEST_FILES` to the JSON list shown before
each test command):

- `["tests/feature/effects/execution-graph.test.ts","tests/feature/effects/renderer-architecture.test.ts","tests/feature/effects/render-sampling.test.ts","tests/feature/effects/composition-plan.test.ts","tests/feature/effects/native-opacity.test.ts","tests/feature/effects/time-control.test.ts"]` + `npx vitest run`: **74 passed**.
- `["tests/feature/effects/mixed-compositing.spec.ts","tests/feature/effects/render-sampling.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]` + `npx playwright test --config playwright.config.ts --output test-results-renderer-final-browser`: **28 passed**, including both audience-navigation declarations and 4K shader sampling. The original selector additionally named nonexistent `css-composition.spec.ts`; CSS was therefore verified separately with the correct file below.
- `["tests/feature/effects/css-backdrop-opacity.spec.ts"]` + `npx playwright test --config playwright.config.ts --output test-results-renderer-final-css`: **7 passed**.
- `["tests/feature/effects/native-composition.spec.ts","tests/feature/effects/native-continuity.spec.ts"]` + `npx playwright test --config playwright.electron.config.ts --output test-results-renderer-bounded-electron`: **11 passed, 1 failed**. The captured seek-response budget observed 102 ms against 100 ms. No assertion or budget was changed.
- `["tests/feature/effects/native-continuity.spec.ts"]` + `npx playwright test --config playwright.electron.config.ts --grep 'native playback meets frame pacing' --output test-results-renderer-final-pacing`: **1 passed** when run in isolation. Captured responses were 80/92/90/88/90 ms; rAF p95/p99/max were 3.6/3.9/4.9 ms. This does not erase the earlier miss or establish a dense-deck hardware speedup.
- `npm run typecheck`, `npm run build`, `npm run verify:build`: passed.
- `npx eslint src/components/domRaster.ts src/components/effectRuntime.ts src/components/effectSources.ts src/components/sceneTextureLegacy.ts src/components/shaderOutput.ts tests/feature/effects tests/helpers/renderingWorkloadHarness.tsx tests/helpers/webglPixels.ts tests/feature/presenter/audience-navigation.spec.ts`: passed.
- `npm run test:stats`, `npm run test:audit`: passed, **666 active declarations / 95 groups**.
- `git diff --check`: passed.

The build includes a full TypeScript check. No production changes followed these
checks; subsequent harness changes only record preservation attributes. The final
paired run also executes the generated/static-revisit invariants and 16/24/32
capacity assertions against the clean measured commit.

Not run: full/release suites, installer packaging, cross-platform validation,
physical 4K refresh capture, full manual deck walkthrough, export-specific
continuity or a paired hardware-GPU performance benchmark. The previous visible
Electron attribution data in the historical reports predates this architecture.

## Final production build check — 2026-10-23

`npm run build` and `npm run verify:build` passed again before handoff.
This builds the production web assets and Electron entry point and checks build
invariants; it does not run an installer or a visible hardware-GPU smoke test.
Superseded plans, handoffs, diagnostic scripts and experimental evidence were
removed from the working tree; their history remains in Git. The experiment-only
workflow, including its continue-on-error legacy diagnostic, was also removed.
