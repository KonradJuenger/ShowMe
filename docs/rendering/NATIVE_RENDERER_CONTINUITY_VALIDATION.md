# Native renderer continuity implementation and validation

Date: 2026-10-23. Branch: `experimental/browser-native-renderer`.
Validation candidate: changes based on `e0dbef6`, measured before publication.
The developer subsequently requested a PR; the evidence retains the original dirty
candidate identity. No integration into `main` has been authorized.

## Implemented behavior

`nativeOpacity.ts` derives visual alpha bindings from the accepted element tree.
Ordinary groups retain native group opacity. Supported scoped glass materials
keep transform ancestors opaque and receive alpha on the effect node. Plain groups
containing these materials pass their alpha through inherited CSS variables;
each consuming visual applies the product once. Motion binds those variables at
runtime creation and restores them on teardown, without per-frame descendant
queries, React rendering, scene planning or capture.

Effect ordering, document/protocol schemas, authority, persistence, clocks and
SceneTexture ownership are unchanged. Material alpha changes do not remount the
effect or switch a backend as the fade advances. Generated shaders remain
GPU-owned; rendered-scene inputs still use the existing exceptional boundary.

The routing is deliberately conservative. Arbitrary document stylesheets,
unrecognized CSS, authored opacity/filter/mask boundaries, shader-wrapped groups
and nested material boundaries retain authored native behavior. Such combinations
can still exhibit Chromium backdrop-root limitations. This is not universal
composition parity for arbitrary CSS/JS.

Group alpha distribution is an approximation, including when a supported group
has a non-unit base opacity. Overlaps can look different from fading one flattened
group. The overlap fixture bounds mean channel error to 24/255 at half opacity;
the observed value was 22.28/255. This is a fixture-specific reviewed test budget,
not a universal perceptual tolerance or a claim that every material meets it.

The representative mixed-renderer fixture's literal GLSL `\\n` was corrected to
an actual newline. Existing native Motion/Presence tests now inspect the material
alpha rather than requiring alpha on the transport ancestor.

## Explicit visual continuity checks

Four deterministic routing tests and seven Electron contracts were added and
registered. The Electron checks cover:

- image-backed glass at 17 ms intervals during entrance and exit;
- generated-shader background, a group of overlapping cards, backwards seeks and
  fade endpoints;
- expected single-sample disappearance and removal of blur;
- a presentation-acknowledged 110-state sequence with injected disappearance,
  missing blur, hidden shader output, alpha jump and stale output;
- native frame pacing measured without pixel capture, and captured seek response;
- natural-rate Presence playback with pixel verification of observed presentations;
- a moving, generated VP9 video and JS text inside animated native glass.

The pixel oracle uses a known checker background and the material's fully visible
native result, sampled through the canonical transport. Intermediate reference
pixels are computed from those endpoints. For the independent glass interior,
mean channel error must stay within 3/255. This detects loss of blur even though
computed CSS still contains backdrop-filter. Temporarily disabling alpha routing
caused the nested regression to fail at 100, 300, 599 and 1700 ms; re-enabling it
passed. No legacy assertions or pixel tolerances were relaxed to hide that failure.

The injection sequence detected exactly states 20, 40, 60, 80 and 100, with zero
unobserved fixture states. Reports and before/during/after pixel strips are saved
in `test-results-native-verified/`.

### Capture limitation

Electron's native presentation subscription downsamples high-refresh playback on
this machine. The natural-rate run emitted 609 marker states and captured 62,
leaving 547 unobserved. No visual faults were found in the captured samples.

That is **not proof of zero one-refresh flicker**. The injection test holds each
fixture state until its presentation is captured, so every deliberately faulty
state is verified. It proves the pixel detector and controlled presented sequence,
not capture of every frame at the display's natural refresh rate. Reports preserve
this distinction and do not turn capture gaps into a full-coverage pass.

Timing requires a visible native window: hidden windows throttled callbacks to
approximately one per second. The pacing/live tests briefly show a native window
without taking focus. The measurement does not use offscreen-only rendering.

## Measurements and remaining performance work

[Persistent candidate evidence](evidence/native-continuity-2026-10-23.json)
identifies the dirty source candidate separately from its parent commit.

Small native fixture: 3.4 ms rAF p95, 3.5 ms p99, maximum gap 8 ms; captured seek
response 87–100 ms. The focused budgets passed. Capture was disabled during pacing
collection; native-capture callback receipt is not physical-display latency.

The existing dense headless audience workload passed correctness in three runs,
but measured 100 ms median per-run p95 frame interval, 435.3 ms first-entry p95 and
410.8 ms revisit p95. It remains above the native fixture's smoothness budgets.
Some local verification overlapped these exploratory runs; there is no paired
clean baseline or claimed speedup. Details are retained in local audience history
and summarized in `areweslowyet.md`.

The subsequent standalone stress rerun measured 83.4 ms frame-interval p95,
370.2 ms first-entry p95 and 349.7 ms revisit p95. Attribution profiling then
confirmed SwiftShader in headless Chromium versus Radeon/D3D11 in visible Electron.
Steady playback rAF p95 was 33.4 ms headless versus 6.7 ms in Electron; the
aggregate stress timing includes navigation. Electron navigation still took
159–378 ms, including fixture image generation. See `areweslowyet.md` and
[attribution evidence](evidence/native-slow-attribution-2026-10-23.json).

A matching-machine paired baseline and full-refresh visual coverage remain open.
Do not weaken the workload's images, text, effects, live motion or residency
assertions to obtain a faster score.

The first slide of each supplied Ideas in motion deck was re-probed locally at
the entrance sample, with the original photo asset for the image-backed deck.
The glass remained blurred with non-unit material alpha. Files were not changed.
This was not a full manual presentation/MCP walkthrough.

## Verification commands and results

Passed: `npm run build`, `npm run verify:build`, `npm run typecheck`,
`npm run test:stats`, `npm run test:audit`, focused ESLint and `git diff --check`.
Registry: 666 active declarations in 94 groups.

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/effects/native-opacity.test.ts","tests/feature/effects/renderer-architecture.test.ts","tests/feature/effects/composition-plan.test.ts"]'
npx vitest run
# 23 passed

$env:SHOWME_TEST_FILES='["tests/feature/effects/native-continuity.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --output test-results-native-verified
# 7 passed; added overlap bound subsequently passed with --grep 'nested overlapping'

$env:SHOWME_TEST_FILES='["tests/feature/effects/native-composition.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --output test-results-native-existing-fixed --grep 'browser-native CSS glass|Move Scale Rotate and Fade|Presence enter and exit|later foreground content|generated shader layers'
# 5 passed

$env:SHOWME_TEST_PORT='5197'
$env:SHOWME_TEST_FILES='["tests/feature/effects/css-backdrop-opacity.spec.ts","tests/feature/effects/mixed-compositing.spec.ts","tests/feature/effects/render-sampling.spec.ts"]'
npx playwright test --config playwright.config.ts --output test-results-native-mixed
# 24 mixed/sampling checks passed; the CSS transport-opacity assertion was updated
# for the intentional alpha placement, then all 7 CSS checks passed below.

$env:SHOWME_TEST_FILES='["tests/feature/effects/css-backdrop-opacity.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]'
npx playwright test --config playwright.config.ts --grep 'CSS glass|parent-group|nested group|production Move In|external stylesheet|source transforms|overlapping glass|a late slide' --output test-results-native-browser-final
# 8 passed: 7 CSS contracts plus late-image audience navigation

npm run benchmark:audience -- --runs 3 --output test-results-native-audience
# Dense audience declaration passed all 3 runs; measured performance remains slow.
```

Both audience-navigation declarations executed and passed on this source candidate:
the dense stress contract through the benchmark command, and late-image navigation
through the focused browser invocation. No main commit/integration was performed.

Focused ESLint covered `nativeOpacity.ts`, `SlideRenderer.tsx`, `EffectSurface.tsx`,
`motionRuntime.ts`, both new test helpers, both new test files, and the existing
native-composition/css-backdrop tests. React review covered stable hooks, memo
dependencies, effect lifecycle, scoped style binding and preserved DOM identity.

Not run: full/deprecated/release suites, installer packaging, cross-platform tests,
4K physical-display capture, full manual/MCP deck walkthrough and export-specific
visual continuity. The existing 4K shader-sampling regression did execute and pass.

# Direct GPU follow-up

The following continuity evidence predates the bounded GPU bitmap-presentation follow-up.
See [current architecture, measurements and verification](DIRECT_GPU_RENDERER_VALIDATION.md)
for its source revisions and retained limitations.
