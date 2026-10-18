# Deck building and preview refinements

Date: 2026-10-18. Local development; follows the first local MCP implementation.

## Gaps found during actual use

The first deck request could only fill an existing slide. It could not add slides,
name the deck, change a slide background, or control typography. Inspection confirmed
accepted content, but a live preview returned the empty app background. An SDK client
test that merely asserted an image existed did not protect that visual contract.

`showme.apply` now supports `slide.create`, `slide.update`, `deck.rename` and
`text.style`, plus typography/auto-size at text insertion. Creation is one isolated
operation with an explicit existing slide context and insertion anchor. It creates
an independent blank slide, returns `createdSlideIds`, and leaves human navigation
and selection alone. Inspect the new ID before adding content. Receipts also expose
`updatedSlideIds` and `deckChanged`; metadata-only edits are real commits even when
no element IDs changed. No-ops still avoid history/revision changes.

These operations use native commands and the same actor-scoped EditorSession,
authority admission, leases, durability, replay registry and guarded undo/redo as
other agent edits. There is no document-format change or alternate writer. Typography
uses native style overrides and font measurement. Template-owned backgrounds are
rejected rather than silently changing or detaching the template.

## Native capture

The new SDK test reproduced the blank PNG after changing preview size and minimizing
the editor. A hidden compositor could retain its cleared backing image even though
the DOM described the correct slide. A repaint request or an arbitrary frame count
did not establish freshness.

The bounded capture window is now created at its final requested dimensions when
size changes. It uses [GPU-capable offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)
with one output pixel per CSS
pixel. After image/font/Effect readiness, the renderer paints a per-request binary
acknowledgement in a strip below the slide. Native capture accepts a completed paint
carrying that acknowledgement, then crops the strip and OS viewport padding out.
The PNG retains exactly the requested dimensions. Empty slides remain valid; no
heuristic infers failure from slide colors. Pending paints coalesce into one latest
frame while decoding, and the five-second paint deadline removes listeners on
completion, process loss or teardown.

The preview entry point also registers text measurement before its lazy renderer
module loads. All capture entry points share one installation promise. The first
text edit no longer depends on an earlier thumbnail having initialized that module.

## Verification

- `npm run build` passed, including typecheck and all bundles.
- With `SHOWME_TEST_FILES` selecting the six agent unit files plus document,
  session-failure, operation-work, text-style-authority and media/frame-rules,
  `npx vitest run` passed 100 tests across 11 files. New contracts cover native
  typography overrides, measurement/fixed frames, stable slide IDs, insertion order,
  replay after undo, exact revision admission, atomic rejection and metadata no-ops.
- With `SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts","tests/extended/agent-preview.spec.ts","tests/extended/agent-context.spec.ts","tests/feature/media/preview-electron.spec.ts"]'`,
  `npx playwright test --config playwright.electron.config.ts --grep 'MCP|stdio|context inspection|native preview waits|context IPC|native rail composition' --output test-results-mcp-readiness-ack`
  passed nine native tests. Coverage includes real SDK deck building and text
  measurement, PNG pixels at several sizes and while minimized, ordinary thumbnail
  CSS pixels, existing image/alpha/text/template/GLSL diagnostics, revocation and
  independent human/agent history. Pixel assertions were retained; the viewport
  assertion now permits native padding while checking a bounded capture surface.
- Targeted ESLint passed for all changed production and test files.
- Test registry/stats: 539 active declarations in 85 groups.
- `npx electron-builder --dir --win --x64 --config.directories.output=test-results-mcp-refine-package --publish never`
  passed. With `SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts"]'`,
  `SHOWME_MCP_PACKAGED_EXE='test-results-mcp-refine-package/win-unpacked/ShowMe.exe'`
  and `SHOWME_MCP_HELPER='test-results-mcp-refine-package/win-unpacked/resources/showme-mcp.cjs'`,
  `npx playwright test --config playwright.electron.config.ts --output test-results-mcp-refine-packaged`
  passed all four MCP tests against the unsigned Windows directory package.
- `npm run test:stats`, `npm run test:audit` and `git diff --check` passed.

An exploratory broader media run did not pass: the effect-thumbnail queued-start
check failed, and three fixtures timed out before `firstWindow`. They did not verify
the changed slide capture path. Those tests were not modified, skipped or weakened;
the relevant ordinary rail-capture contract passed in the focused run above.

macOS packaging, exhaustive managed-font coverage, real LAN sessions and the formal
three-host/model corpus remain pending. The audience-navigation gate must pass
before integration into main. Saving/exporting files, slide deletion/reordering,
template authoring, media insertion and Motion/Effect authoring remain outside the
current MCP operation set. Rebuild/restart ShowMe and reconnect the MCP host to use
the refined schemas and host implementation together.

## MCP authoring and latency refinement, 2026-10-18

External MCP use confirmed that integrated Presence transitions and the strict
`showme.apply` receipt schema were already present before this refinement. They
were preserved rather than replaced.

This pass changed the model-facing and hot-path behavior:

- Presence and Motion now share the same named easing vocabulary at the MCP layer.
- Layout authoring explicitly teaches Frame/group composition and parent-level
  Presence animation.
- `showme.apply` is bounded at 128 operations instead of 32.
- The stdio helper caches a verified bridge descriptor and uses HTTP keep-alive.
  Discovery/context probing is no longer on the ordinary request hot path.
- Text measurement and Effect validation moved off the PNG preview queue onto a
  separate persistent Agent Runtime Chromium surface with one recreation retry.
- `showme.measure_text` measures up to 64 text items per call using managed fonts
  and ShowMe's production DOM measurement.
- Full PNG preview remains on the production capture path and retains its existing
  correctness guarantees.

Focused regression coverage was added for named Presence easing on a grouped parent,
50-operation atomic commits, late-batch atomic failure, the 128-operation bound,
exact-scope text measurement, and text measurement completing while a production
PNG preview is deliberately blocked.

Transport, mutation, renderer-service and preview before/after timing numbers are
intentionally not recorded from this remote pass. Those measurements require the
real local Electron process and machine and should be filled in from the focused
local benchmark rather than fabricated from CI timing.
