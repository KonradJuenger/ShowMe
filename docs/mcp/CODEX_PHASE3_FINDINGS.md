# Phase 3: production preview service

Investigation: 2026-10-17. Implementation outcome and verification follow below.

## Reusable path and differences

`DocumentRuntime.renderProjection()` supplies the accepted slide, deck and referenced
template. Electron `capturePreview()` already serializes bounded capture work through
one hidden slide-preview window. `SlidePreviewPage` mounts the production
`SlideRenderer`, waits for images/decoding/fonts/Effect surfaces, and Electron captures
and resizes the result to the requested PNG dimensions. Editor overlays live outside
this window. Effect Library thumbnails use a separate window and yield to slide work.

The editor supplies local interaction overlays, media flags and optional Motion
preview state. Audience output supplies presenter lifecycle, Motion and Effect clocks.
The isolated slide preview currently supplies neither Motion sample nor explicit
Effect clocks and uses static video/poster behavior. It is a base-state preview,
not a deterministic timestamp, selected editor view or audience-session screenshot.

The existing capture checks epoch/revision when queued work starts, but callers only
receive a data URL or null. An agent-facing read needs explicit IDs/epoch/revision,
size, structured failure/recovery information, post-capture freshness checks and
production diagnostics. It must not accept a client-supplied document body.

## Implementation scope

Add a strict application request/result contract and a small host service around the
existing renderer/capture queue. Reuse the same hidden capture surface for ordinary
thumbnails and agent previews; preserve the legacy `capturePreview` return contract.
Read diagnostic markers from the production capture surface before clearing it.
Keep warnings free of Effect source, exception text and filesystem paths.

The MCP setting is the master local-integration gate. Validate the active document,
document epoch and exact revision before preparing output and after capture. Reject
disabling/re-enabling MCP or replacing/closing the document during a request. Different
selection/slide navigation within the same document does not retarget an explicit
request. No document mutation, runtime/authority duplication, live-playhead mutation,
new network endpoint, transport SDK or persistence format change is needed.

Start with explicit width/height, bounded by the current 2048-per-axis capture limit.
Reject timeline/sample options until their production contract is implemented. Add
focused deterministic service tests and Electron pixel/metadata checks that prove
context -> inspection -> preview without MCP transport. Broader presenter sampling
and Effect validation remain later phases.

## Implemented outcome

Phase 3 is implemented. `AgentPreviewService` validates strict requests, uses the
accepted production projection and shared bounded capture queue, and checks access,
document identity, epoch and revision again before returning pixels. Disabling and
re-enabling MCP invalidates an in-flight request. Ordinary thumbnail capture retains
its existing contract and works with MCP disabled.

The result includes exact PNG dimensions and structured missing-media/Effect-fallback
warnings. Diagnostic messages exclude source code, exception text and filesystem
paths. The hidden production renderer now waits for Effect readiness within its
existing abort deadline, including readiness changes after native viewport resizing.
The editor selection, UI epoch, accepted document and live playhead are unchanged.

Native fixtures cover templates, nested groups, CSS and GLSL Effects, text, alpha
images, missing assets and shader failure. A held readiness marker verifies that
capture waits without restarting the request. Access and revision races discard
captured pixels. The saved settings screenshot and PNG were visually inspected.

## Verification

All commands below passed on the completed production implementation:

- `npm run build` (including typecheck and application bundles).
- With `SHOWME_TEST_FILES='["tests/feature/editor/agentPreview.test.ts"]'`,
  `npx vitest run`: 10 tests passed.
- With `SHOWME_TEST_FILES='["tests/extended/agent-preview.spec.ts"]'`,
  `npx playwright test --config playwright.electron.config.ts --output test-results-agent-preview`:
  2 tests passed. Temporary PNG artifacts were inspected during development; the final
  tests follow the repository policy of retaining screenshots only on failure.
- With `SHOWME_TEST_FILES='["tests/feature/media/preview-electron.spec.ts"]'`,
  `npx playwright test --config playwright.electron.config.ts --grep 'closing the editor|native rail composition'`:
  2 existing capture regression tests passed.
- Focused ESLint on the changed Phase 3 production and test files: no errors or warnings.
- `npm run test:stats` and `npm run test:audit`: 500 active declarations across 81 groups.
- `git diff --check`: no whitespace errors.

No full suite, release packaging, real LAN guest session or audience-navigation gate
was run. No commit or integration was requested. Deterministic timeline sampling and
the local read-only MCP transport remain later work; there is no MCP client connection
yet and no external MCP service integration.
