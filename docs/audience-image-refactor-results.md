# Audience image refactor implementation

Implemented on `chatgpt/audience-loading-reproduction`; `main` remains unchanged.

## Runtime behavior

- Encoded preparation covers the complete visible presentation sequence and
  deduplicates shared asset/dimension requirements. Navigation changes priority
  without rebuilding the plan. Readiness reads no longer reprioritize work.
- The audience negotiates its actual integer physical viewport before mounting
  image views. Presenter, preparation and audience use that same profile.
- Slide rendering resolves one bulk image plan. Browser popups request derived
  preparation from the existing editor owner, with scoped native IPC equivalents.
- Current, next and outgoing compositions remain mounted. Optional previous and
  further lookahead are admitted against a 256 MiB unique planned raster budget.
  Required compositions may exceed that target to permit forward progress. This
  estimates decoded image bytes, rather than guaranteeing Chromium GPU memory.
- Preparation, probe decode, displayed decode, fonts and effect flush still gate
  audience readiness. Outgoing pixels remain visible while an incoming target
  prepares. The next slide can finish both decodes before activation.
- Native in-flight work deduplicates after source-size clamping. Browser cache
  hits bypass resize admission and a persistent two-worker pool handles misses.
  Original-to-target Lanczos3, orientation, alpha and color handling remain intact.
- Editor canvas, rail fallback rendering and native thumbnail capture use the
  shared audience profile. Canvas zoom changes display scale without creating
  separate image variants; audience output and accepted image geometry still
  determine the exact required pixels. Editor sampling tiers and their prefetch
  queue have been removed.
- A visible editor slide can prepare or reuse its audience variants while
  unrelated deck images are still preparing. Gesture deferral, decoded URL
  ownership, original-image fallback and audience readiness remain intact.

There is still one document authority and persistence path. No document/package
format changes, historical readers or flattened slide rendering were introduced.
Motion, effects, video, transitions, editing and export use the canonical renderer.
Arbitrary jumps can require decode of a cached PNG; the whole deck is not held as
decoded/GPU-resident images. Initial cold preparation moves work to startup.

## Sidebar flicker

First successful verification of an unchanged live Library source previously
published an asset-change event. Preparing all deck images amplified those events
and repeatedly invalidated every thumbnail. Verification now establishes trust
without publishing a pixel change; corruption and inventory/availability changes
still notify consumers. Newly verified Trash sources still notify restoration.

Thumbnails retain their last capture while a replacement prepares, then decode
the replacement before swapping it in. Tests cover the false verification event
and retaining a native sidebar thumbnail during document resource invalidation.

## Windows real-deck verification

An isolated copy of `google-upgraded.sme` used separate user data and an empty
derived cache. The original deck and asset bytes were not edited.

- 30 visible slides, 52 encoded requirements: 52 completed, no failures or
  original fallbacks.
- Actual audience: 1596 × 998 DIP at DPR 1.6041666269302368; canonical profile
  2561 × 1601 physical pixels. The profile did not change on audience entry.
- Measured ready times for navigation to slides 24–28: 37, 24, 62, 47 and 22 ms.
  All five navigations started zero additional resize/PNG jobs. These are local
  observations, not portable timing thresholds.
- A resource invalidation left the captured sidebar image mounted and visible.

## Verification

- `npm run test:full`: 300 unit, 93 browser and 4 Electron tests passed.
- `npm run test:feature -- presenter`: 19 unit, 9 browser and 1 Electron passed.
- `npm run test:feature -- media`: 35 unit passed; initially caught the incomplete
  import-plan regression. The corrected production browser contract subsequently
  passed in the full suite and the focused rerun below.
- `npm test`: 15 core tests passed.
- `$env:SHOWME_TEST_FILES='["tests/feature/media/prepared-image.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]'; npx playwright test --config playwright.config.ts`:
  7 passed after strengthening the required gate to assert no decode on activation.
- `$env:SHOWME_TEST_FILES='["tests/feature/media/preview-electron.spec.ts","tests/feature/presenter/displays-electron.spec.ts"]'; npx playwright test --config playwright.electron.config.ts`:
  3 passed, including retained thumbnails, measured physical profile and rejecting
  audience preparation from the editor role.
- `npm run typecheck`, `npm run lint`, `npm run test:stats`,
  `npm run test:audit`, `npm run build`, `npm run verify:build`: passed.

Existing sampling tests cover native Lanczos output and browser fine detail,
orientation and alpha; canonical native preview/PDF pixel checks also passed.
The mandatory synthetic audience gate is required for changes that can affect rendering.
macOS, packaged/release verification and physical multi-monitor testing were not
run. No integration into main is authorized by these results.

## PR review corrections

Audience startup now tolerates every settled cache-preparation failure, while
preserving `failed` status and failure details. Strict readiness callers still
reject. Failed instances resolve to `null`, including individually requested
profiles, so healthy variants and original/missing fallback remain usable.
A deliberately throwing preparation job tests both the diagnostics and fallback.

Browser presentation shutdown clears the negotiated audience profile for local
and broadcast state changes. Background preparation only uses the override while
a presentation exists. A real audience popup at 1111 × 777 tests that ending the
session restores the editor's preparation profile.

Verification after these corrections: `npm run test:feature -- presenter` passed
20 unit, 10 browser and 1 Electron tests; `npm run test:feature -- media` passed
35 unit, 9 browser and 2 Electron tests; `npm test` passed 15 core tests.
`npm run typecheck`, `npm run lint`, `npm run test:stats` and
`npm run test:audit` passed. Both feature commands rebuilt successfully.
The full suite and release/platform checks were not rerun for this focused fix.
Application versions and document formats remain unchanged.
