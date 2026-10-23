# Native presentation performance

2026-10-23. Branch: `performance/native-presentation-workload`.
Base: main `a699fbd`. No main integration is included.

## Current architecture

Ordinary slides remain native DOM/CSS. The document authority, persistence,
presentation clock, audience resolution and shader definitions are unchanged.

- During presentation, the editor canvas and presenter current/next previews
  render static visual snapshots. Controls, notes, timers and navigation remain
  active. Accepted edits, density changes, font completion and context recovery
  refresh static output; ending presentation resumes live editor rendering.
- GPU resources use context generations rather than per-draw validity probes.
  Linked uniforms, attributes and VAOs are cached and rebuilt after context loss.
- Each renderer uses at most two shared shader contexts: generated-input and
  pixel-input chains. Direct shader stages stay together. This reduces drawing
  buffer resizing for the reference deck without creating a context per chain.
- A qualified SceneTexture path assembles one flat generated background and
  static native text/shapes in an FBO before the backdrop shader draws. Native
  foreground pixels and a coverage mask are captured once and retained as pixels;
  their DOM capture machinery is disposed. The mask preserves fractional clipping
  and bitmap filtering, including out-of-slide edges.
- The background's presented canvas is imported across the bounded contexts.
  No animated DOM capture or CPU pixel readback is requested by this path.
  Browser/driver transfer internals are not established as zero-copy.
- Qualification excludes custom stylesheets, scene motion, video, nested groups,
  transformed backgrounds/targets and additional effects. Unsupported scenes
  retain native capture. Accepted scene replacement conservatively falls back
  until the provider is rebuilt. There is no general compositor.

SceneTexture remains the sole doorway into legacy capture. Its boundary injects
capture factories into the GPU implementation; the GPU implementation consumes
composition plans rather than importing primitive raster or legacy capture APIs.
Context restoration rebuilds GPU state and refreshes static dependent cohorts.
Disposal releases assembly resources and capture leases.

## Hardware results

Reference: the saved `shader-text-shader.sme`; hashes are in the evidence.
Production Electron 44.4.1, Radeon 880M / D3D11, Ryzen AI 9 365, Windows.
Audience viewport 1596 x 998 CSS pixels, DPR 1.6042, original output resolution.
The original user app remained running. No verification jobs ran during timing.
Each comparison used three serial alternating/interleaved clean production runs,
ten seconds per configuration with matching harness/deck/GPU/viewport hashes.

| Comparison | Audience callbacks/sec, median | Glass publications/sec, median | Frame p95, ms |
| --- | --- | --- | --- |
| Phase 1: main -> static non-audience visuals | 22.6 -> 29.1 | 11.3 -> 14.5 | 83.5 -> 66.7 |
| Phase 2: GPU ownership/binding caches | 28.3 -> 29.4 | 14.1 -> 14.6 | 66.8 -> 66.8 |
| Phase 3: one -> two bounded contexts | 34.2 -> 49.7 | 17.0 -> 24.8 | 66.2 -> 33.5 |
| Phase 4: native capture -> qualified GPU assembly | 46.7 -> 60.0 | 23.3 -> 60.0 | 33.6 -> 17.2 |

These are separate within-phase comparisons, not one continuous main-to-candidate
measurement. Phase 2's small gain was inconsistent. Phase 3 changes context
contention and resizing together; it does not isolate resize timing.

The final paired comparison measured baseline `22836e6` against corrected
candidate `83ae593`. Audience/glass candidate ranges were 59.5-60.0/sec, compared
with 46.6-47.9 audience and 23.3-23.9 glass. This reaches approximately 60 updates
per second on this workload, not measured physical scanout or every deck/hardware.
The subsequent import-boundary fix does not change shader or capture behavior;
no new performance benchmark was run for that cleanup.

The two-context experiment added about 7.8 MiB of logical drawing-buffer storage.
GPU assembly also retains imported background, coverage and assembly textures.
Actual VRAM, peak GPU memory and driver transfer cost were not measured. These
memory costs and qualification limits remain review considerations.

Evidence includes measurements, revision/environment hashes and the available
harnesses: [Phase 1](evidence/native-presentation-phase1-2026-10-23.json),
[Phase 2](evidence/native-presentation-phase2-2026-10-23.json),
[Phase 3](evidence/native-presentation-phase3-2026-10-23.json),
[Phase 4](evidence/native-presentation-phase4-2026-10-23.json).

## Regression status

**Not fully green: 263 passed, 8 failed in the broad selection.** The existing
architecture assertion exposed a direct legacy import; the implementation was
fixed without relaxing that assertion. All 118 effects units now pass.

| Selection | Result |
| --- | --- |
| Core | 15 passed |
| Effects units | 118 passed |
| Presenter + Motion units | 59 passed |
| Effects browser | 48 passed, 7 failures reproduced identically on clean main |
| Presenter browser | 11 passed, including both audience-navigation gate declarations |
| Native Electron composition / continuity / display IPC | 12 passed, 1 capture timeout |

The seven baseline failures are in authoring.spec.ts (built-ins, Studio shader
preview, timing prompt, direct runtime clocks, template shader clock and future
stages) and typed-context.spec.ts (direct GLSL context). Four read visible shader
canvases as Canvas2D, two omit current shader-chain ownership, and one expects old
prompt wording. They were left unchanged rather than weakening unrelated tests.

The remaining failure is native-continuity's presentation-capture detector. Its
110-state acknowledgement loop timed out in the broad and an isolated candidate
run; the stalled screenshot showed marker 2. It passed on clean main in 14.9 s
and on the candidate with diagnostic attachments in 15.9 s. Cause is unresolved;
the isolated pass does not clear earlier failures. Failure attachments now record
captured IDs and requested/acknowledged IDs. No timeout, assertion, skip or retry
policy was relaxed. Keep the PR draft until this is resolved.

Passing coverage includes pixel/alpha/gradient parity within one channel value,
fractional edges, capture progress, context recovery, static/live playback,
CSS/JS/video fallback, density sizing, dense animated audience navigation, late
image advance preparation, presentation resize/end, group alpha, Presence,
captured playback/seek budgets, moving video/text and desktop display setup.

## Verification commands

`npm run test:feature -- effects` builds/typechecks first, then executes the effects
units and browser selection. Browser failures stop automatic Electron execution;
the separate Electron command below supplied that coverage. Static checks and
registry audit pass. Local logs/traces remain under `.agenttmp` and
`test-results-regression-*` in the candidate and main baseline worktrees.

```powershell
npm test
npm run test:feature -- effects
$env:SHOWME_TEST_FILES = node -e "console.log(JSON.stringify(require('./tests/registry.json').filter(e=>e.status==='active'&&e.runtime==='unit'&&['presenter','motion'].includes(e.area)).map(e=>e.path)))"
npx vitest run
$env:SHOWME_TEST_FILES = node -e "console.log(JSON.stringify(require('./tests/registry.json').filter(e=>e.status==='active'&&e.area==='presenter'&&e.runtime==='browser').map(e=>e.path)))"
npx playwright test --output test-results-regression-presenter
# Includes audience-navigation.spec.ts: dense rendering and late-image contracts, 2/2 passed.
$env:SHOWME_TESTING='1'
$env:SHOWME_TEST_ROOT_SELECTION=(New-Item -ItemType Directory -Force .agenttmp/regression-root).FullName
$env:SHOWME_TEST_FILES='["tests/feature/effects/native-composition.spec.ts","tests/feature/effects/native-continuity.spec.ts","tests/feature/presenter/displays-electron.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --output test-results-regression-electron
$env:SHOWME_TEST_FILES='["tests/feature/effects/native-continuity.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --grep 'presentation capture detects each injected faulty state' --output test-results-regression-capture-diagnostic
npm run typecheck
npx eslint src/components/sceneTexture.ts src/components/sceneTextureGpu.ts tests/feature/effects/native-continuity.spec.ts
npm run verify:build
npm run test:audit
git diff --check
```

Baseline browser checks ran at main `a699fbd` with port 5174, authoring and typed
context selected, and grep `every built-in|new Shader has|Effect Timing exposes|all runtime surfaces|Presentation-start shader|Future Effect stages|GLSL and CSS receive`.
The same single-detector Electron command was also run on main. The qualified GPU
parity test was additionally exercised with a spatial gradient after the initial
five-test focused GPU selection passed.

Full/release suites, installers and cross-platform checks were not run. Automatic
CI remains paused under repository policy; local validation is authoritative.
