# Native rendering finalization

Chromium renders ShowMe presentations. GPU shaders are additional layers.
SceneTexture is used only when GLSL explicitly needs already-rendered Chromium
pixels. DocumentAuthority, document formats and canonical Motion/Presence remain
unchanged. This branch is based on main a699fbd; it does not integrate research.

## Ownership and input categories

| Input | Production owner | SceneTexture |
| --- | --- | --- |
| Text, images, SVG, video, groups, clips, transforms, opacity | Chromium DOM/CSS/media | Never for ordinary rendering |
| CSS filters, backdrop-filter, blending, masks, shadows, CSS animation, JS text | Chromium and existing Effect runtime | Never for CSS/JS execution |
| Generated GLSL (`input: none`) | Shared WebGL cohort, presented as a Chromium layer | Never |
| Direct neutral image/video or adjacent shader output | Media texture or retained shader texture | Never |
| Styled content or an authored backdrop paint prefix consumed by GLSL | Explicit SceneTexture capture provider | Yes |

A transformed/clipped/styled media source that cannot use the existing direct
media contract takes the explicit content-capture route. It does not capture the
whole slide merely because it contains media. Native surfaces beside shaders
remain native. No final-frame shader feature exists, so no offscreen/shared-texture
transport is added.

## SceneTexture

`sceneTexture.ts` is the public pixel boundary; `sceneTextureCapture.ts` owns its
Chromium snapshot implementation. Composition plans select the authored input
prefix; they do not repaint that prefix. The former primitive Canvas2D scene
painter is removed. No GPU reconstruction, qualification-based assembly, alternate
renderer mode, general GPU render graph or per-prefix BrowserWindow is introduced.

Providers and capture observers are lazy: only a shader requesting native pixels
creates them. Generated and direct-media chains never mount capture observers.
Each provider holds one source lease. The renderer permits one pending input
acquisition per surface; changes invalidate the next generation while completed
captures publish, avoiding starvation. Intermediate source invalidations coalesce;
there is no per-frame work queue. Completed pixels may be one capture behind a
changing scene; continuous native-prefix capture remains expensive.

Static, effect-free inputs without video, relevant Motion/Presence or arbitrary
deck CSS can retain a pixel-only snapshot after capture. Every sampled image/SVG
must resolve to a complete native image with nonzero intrinsic width; missing/loading media
never enters the retained LRU. The bounded eight-entry LRU releases
DOM mirrors, callbacks and observers belonging to cached sources. Semantic keys
include input identity, elements, typography, fonts, dimensions and backdrop
background. Revisits reuse pixels without capture. Font completion invalidates
keys even when no consumer is mounted.

Live inputs use mutation, Effect-output and media notifications. Prefix filtering
excludes later unrelated content; arbitrary stylesheet selectors conservatively
retain broader invalidation because siblings can influence native pixels. Native
animation/video polling runs while relevant pixels change, with a final settling
update. Shader time alone does not invalidate an unchanged native input. Existing
Motion/Presence writes and sampled Effect clocks drive invalidation; no second
animation state machine is added. Unsupported native HTML-in-Canvas capability
produces the existing diagnostic and preserves the original native element.

## GPU lifetime and presentation workloads

Each renderer owns at most two lazy shared WebGL contexts: generated chains and
pixel-input chains. Direct shader stages retain their chain's context. Owned
resources use context generations; linked uniform locations and VAOs are cached.
Loss invalidates ownership; restoration refreshes static consumers too. Programs,
textures, framebuffer outputs and visible bitmaps are released on surface/chain
teardown. Idle shared drawing buffers shrink to 1x1. This is bounded context
ownership, not one context per Effect.

During presentation, the editor canvas and current/next presenter previews consume
static sampled visuals. Controls, navigation, notes and timers stay active;
accepted edits, density/font changes and context restoration refresh output.
Ending presentation resumes editor playback. The audience remains live.

## Research audit and decisions

- Main / PR #18 (`c9580ee`, then `a699fbd`) already removed the general compositor,
  made CSS native, kept generated/direct inputs independent, retained static
  SceneTexture pixels, avoided generated Canvas2D presentation copies and fixed
  dynamic capture publication starvation. Preserve these contracts.
- `experimental/browser-native-renderer`: inspected both local `2886c4f` and
  remote `5bd33a9`; main contains the applicable native renderer work. No merge.
- `performance/native-presentation-workload` / PR #19: port the reviewed source
  improvements through `22836e6` (preview suspension, generation/binding caches,
  two bounded contexts) and their recovery tests. Exclude Phase 4, including
  `sceneTextureGpu.ts`, masks and GPU prefix reconstruction. Historical Phase 1–3
  callback measurements are evidence for the design, not new branch benchmarks.
- `research/native-gpu-shared-texture-boundary` (`d7fecf7`): completed webContents
  transport can serve a final-frame postprocess, not arbitrary prefixes. No
  existing product path justifies it. Reload/drain lifetime remains unresolved.
- `research/general-gpu-renderer` (`adbdb17`): useful performance evidence, but its
  native CSS/text/animation semantics and restoration gaps preclude production.
  No code ported. All research branches and their documentation remain intact.

Dynamic multi-backdrop GLSL, CSS-heavy prefixes, video/moving native content under
GLSL and high-resolution captures remain expensive. Prefer equivalent native CSS
when authoring; do not silently change shader semantics or reconstruct Chromium
paint to hide this cost. Callback/submission rates are not physical display FPS.

Validation and workload measurements are recorded below.

## Verification before measurements

- `npm run typecheck` and `npm run build`: passed.
- Selected active Effects, Motion/Presence, media and presenter units via
  `SHOWME_TEST_FILES`, then `npx vitest run`: 236 passed in 27 files.
- `SHOWME_TEST_FILES='["tests/feature/effects/mixed-compositing.spec.ts","tests/feature/effects/render-sampling.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]'`
  then `npx playwright test --output test-results-native-final-browser-complete`:
  32 passed. Both audience-navigation declarations executed and passed.
- `SHOWME_TEST_FILES='["tests/feature/effects/native-composition.spec.ts","tests/feature/effects/native-continuity.spec.ts","tests/feature/presenter/displays-electron.spec.ts"]'`
  then `npx playwright test --config playwright.electron.config.ts --output test-results-native-final-electron`:
  12 passed; native seek response measured 101 ms against the unchanged 100 ms
  budget. The same check passed individually on clean main a699fbd and on this
  candidate. This is an unresolved timing observation, not a demonstrated
  pre-existing main failure or a fully green broad Electron selection.
- Selected `sequence-inspectors.spec.ts` with `--grep 'Presence event tails'`:
  passed; the superseded primitive pixel assertion now checks native visibility,
  preserving the mounted-media/inert/lifecycle assertions.
- Changed-file ESLint, `npm run test:stats`, `npm run test:audit`, and
  `git diff --check`: passed. Registry describes the current native contracts.

No full/release suite, installer or cross-platform checks were run. General
Effects authoring UI checks were not rerun; this change targets renderer execution.
The React review covered hook dependencies, renderer remounts, frozen clocks,
scoped CSS suspension and listener cleanup. Test-only optimization reference
controls remain for parity comparisons; they do not select a second compositor.

## Measured workloads (2026-10-24)

[Raw observations and provenance](evidence/native-rendering-final-2026-10-24.json).
Measured clean main `a699fbd` against clean renderer commit `aa0dee9` on Windows,
Ryzen AI 9 365 / Radeon 880M, D3D11. No other verification jobs ran during timing.
The original user app remained open. A later focused video-polling fix affects
video-containing captures; the measured saved deck contains no video. Attribute
these measurements to `aa0dee9`, not video follow-up `a784536`.

### A/B/C/E: isolated native, generated and static capture

Existing `rendering-workloads.spec.ts`, three headed Chromium runs per checkout,
1280x720, DPR approximately 1. Actual GPU strings confirm Radeon 880M, rather
than SwiftShader. Main batch preceded candidate batch; these are architecture
measurements, not an interleaved causal comparison. Fixture and instrumentation
files match; the helper adds preview playback plumbing defaulting to live.

| Workload | Main | Candidate |
| --- | --- | --- |
| Native text/image/CSS/Motion/Presence SceneTexture captures | 0 / 0 / 0 | 0 / 0 / 0 |
| Native frame-callback interval p95 median | 3.4 ms | 3.4 ms |
| Native task CPU median | 43.5 ms | 45.5 ms |
| Generated GLSL SceneTexture captures | 0 / 0 / 0 | 0 / 0 / 0 |
| Generated frame-callback interval p95 median | 3.4 ms | 3.4 ms |
| Generated task CPU median | 146.9 ms | 55.2 ms |
| Static SceneTexture initial capture | 1 / 1 / 1 | 1 / 1 / 1 |
| Static SceneTexture revisit capture | 0 / 0 / 0 | 0 / 0 / 0 |
| Static revisit readiness median | 9.7 ms | 11.2 ms |

Native computed-style reads, generated Canvas2D presentation copies and steady
shader compilations/texture allocations were zero. Native CSS glass remains inside the native
workload; it does not create capture machinery. The existing direct-video shader
check also passed with zero SceneTexture captures. Generated 16/24/32-output
stress checks passed three repetitions each and released active ownership.
There is no claim that ordinary native presentation became faster. These short
callback-based fixtures do not measure physical refresh/scanout or establish a
universal performance target.

### D: saved real-deck dynamic GLSL backdrop

Existing local production-Electron saved-deck harness, instrumented to count
`drawElementImage` calls. Three serial alternating main/candidate pairs, ten
seconds each, identical harness/document/GPU/viewport/DPR hashes. Audience viewport
1596x998 CSS pixels, DPR 1.6042 (approximately 2561x1601 output).

| Metric | Main median [min, max] | Candidate median [min, max] |
| --- | --- | --- |
| Audience callbacks/sec | 34.5 [34.2, 34.8] | 85.7 [80.5, 86.6] |
| Backdrop publications/sec | 17.2 [17.1, 17.3] | 42.8 [40.2, 43.3] |
| Callback interval p95 | 57.6 [56.2, 61.1] ms | 22.5 [21.5, 23.7] ms |
| Captures in ten seconds, each run | 172 / 174 / 171 | 403 / 428 / 433 |
| Shared audience shader contexts | 1 | 2 |
| Logical shared drawing-buffer bytes | 14,761,604 | 22,923,212 |
| Active audience capture mirrors | 1 | 1 |

More captures here mean more useful dynamic publications, not capture elimination.
Dynamic native capture remains approximately half audience callback cadence.
Logical buffer bytes are not measured VRAM; the second cohort adds about 7.8 MiB.
Rates above 60 are callback/submission rates and must not be called display FPS.
This comparison supports the coherent native-first change, not attribution to one
individual optimization.

Presenter publications were zero during candidate measurement. The older harness
matches editor counters by Effect ID, which is ambiguous across duplicate current/
next instances; its negative editor deltas are invalid diagnostics and excluded
from conclusions. An independent index-based lifecycle check passed: all editor
and presenter counters froze, font completion refreshed output, controls remained
available, and ending presentation resumed live editor output.

A deterministic dependency workload recorded exactly: initial capture 1, unrelated
later native changes 0, eight relevant changes 8, settled captures 0. Teardown
returned provider and capture-source deltas to 0. Retention checks also captured
once for each changed background/target geometry and zero on unchanged revisit.

### Exact measurement commands

In each checkout, with `SHOWME_TEST_FILES` selecting
`tests/feature/effects/rendering-workloads.spec.ts`:

```powershell
$env:SHOWME_RENDERER_BENCHMARK='1'
$env:SHOWME_RENDERER_BENCHMARK_OUTPUT='<separate absolute output directory>'
npx playwright test --headed --repeat-each 3 --output <separate test output>
```

The saved-deck harness and alternating runner remain locally in
`.agenttmp/native-final-hardware.mjs` and `.agenttmp/run-native-final-hardware.mjs`:
`node .agenttmp/run-native-final-hardware.mjs`. The harness hash and all six raw
observations are in the evidence. Lifecycle verification used
`node .agenttmp/phase1-lifecycle.mjs`; its index-based observations are also saved.

The later video fix passed typecheck, changed-file ESLint and the exact focused
browser selection `--grep 'stable native styles|excluded animations|SceneTexture ignores|animated shader and text'`
with `mixed-compositing.spec.ts` selected: four passed. Its stable-style test verifies
video capture progresses, native playback events wake observation, and pause
settles capture without changing ordinary/direct-media rendering.

Reproducible unit selection used:

```powershell
$env:SHOWME_TEST_FILES = node -e "console.log(JSON.stringify(require('./tests/registry.json').filter(e=>e.status==='active'&&e.runtime==='unit'&&['effects','motion','media','presenter'].includes(e.area)).map(e=>e.path)))"
npx vitest run
```

Final video source follow-up: `a784536`. Its build, typecheck, changed-file ESLint,
four focused browser contracts and updated registry audit passed. No document,
asset, persistence, collaboration or animation formats changed. Research refs and
main remain unchanged; no integration into main is included.

## Retention review follow-up

- P1: missing/loading image or SVG dependencies disqualify retained static pixels.
  This avoids caching a placeholder while a shared/LAN asset is absent, so arrival
  while all providers are unmounted cannot reuse that placeholder on reopening.
  Image load/error and source/readiness mutations requalify mounted providers.
  Completion rechecks readiness and only detaches a stable capture generation.
  No global asset observer, second cache schema or persistence path is added.
- P2: retention checks the sampled element prefix/subtree plus the shader target
  and its ancestors against canonical Motion tracks and Presence/Effect bindings.
  Later unrelated animation no longer disables static reuse. Relevant source,
  target and ancestor animation remains conservative. No animation clock is added.
- Presenter/editor previews retain the reviewed static-playback product behavior.

The new `scene-texture-retention.spec.ts` reproduces both original failures. It
checks a missing asset arriving while every provider is unmounted, unchanged
document data, fresh content/backdrop pixels after reopening, and cache reuse for
unrelated Motion/Presence versus rejection for source/target/ancestor animation.
These are correctness/cache-lifetime changes; no new FPS benchmark is claimed.

Follow-up verification:

- `npm run typecheck`, `npm run build`, and changed-file ESLint: passed.
- With `SHOWME_TEST_FILES` selecting `renderer-architecture.test.ts`,
  `execution-graph.test.ts`, `render-sampling.test.ts`, and
  `motion/presence.test.ts`: `npx vitest run`, 47 passed.
- `SHOWME_TEST_FILES='["tests/feature/effects/scene-texture-retention.spec.ts","tests/feature/effects/mixed-compositing.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]'
  then `npx playwright test --output test-results-scene-texture-review-regression`:
  29 passed, including both audience-navigation declarations.
- `npm run test:stats`, `npm run test:audit`, and `git diff --check`: passed.
- Earlier Electron results and their recorded timing limitation remain as above;
  no full/release or additional performance runs were required for this follow-up.

## Deck viewport identity and shipping-platform smoke checks

Retained keys and mounted qualification identity include `deck.width` and
`deck.height`, independently of the shader target's sampling dimensions. The
regression changes width, then height while every provider is unmounted, checks
fresh backdrop pixels after each change, and checks zero captures on an unchanged
revisit. It failed before the fix with capture counts 1/0/0/0 and passes with
1/1/1/0; shader backing-store dimensions remain 300x500 throughout.

`tests/feature/effects/native-capture-electron.spec.ts` launches the built ShowMe
Electron entrypoint, using the production startup feature switches. The test does
not enable `CanvasDrawElement` itself. Its two explicit contracts verify
`drawElementImage`/`requestPaint` availability, successful SceneTexture capture,
and native styled pixels reaching content and backdrop GLSL output. Each test
writes a JSON report with platform, architecture, Electron/Chromium versions,
capabilities, capture count and pixel/error results.

Local checks for this follow-up: `npm run build` (including typecheck), changed-file
ESLint, all three retention browser tests, both shipping-Electron smoke tests,
`npm run test:stats`, `npm run test:audit`, and `git diff --check` passed. Windows
x64 reports Electron 44.4.1 / Chromium 152.0.7977.78, both APIs present, one capture
per smoke case and no Effect errors.

Automatic CI remains paused under repository policy. The existing manual
`Desktop verification` workflow now accepts `suite: native-capture`, which runs
only these two smoke tests after building on the shipping Windows x64, macOS x64
and macOS arm64 runners. The default `release` selection retains the existing full
verification behavior. Per-platform JSON evidence is uploaded for passing and
failing runs. Dispatch against the PR branch with:

```powershell
gh workflow run release-verification.yml --ref codex/native-rendering-finalization -f suite=native-capture
```

These are native Electron smoke checks, not a full cross-platform release suite
or a performance benchmark. The workflow/check results on the tested PR head are
the authoritative remote outcome; local Windows success does not stand in for
macOS validation.
