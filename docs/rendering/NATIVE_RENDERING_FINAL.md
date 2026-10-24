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

Static, effect-free inputs without video, slide Motion or arbitrary deck CSS can
retain a pixel-only snapshot after capture. The bounded eight-entry LRU releases
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

Validation and actual workload measurements are recorded below after execution.

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
