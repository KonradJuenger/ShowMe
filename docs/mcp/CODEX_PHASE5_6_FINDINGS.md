# Phases 5–6 implementation findings

Date: 2026-10-18. Execution: local-codex, existing shared branch/check-out.

## Scope and local authorization

The developer authorized explicit local editing opt-in while keeping cross-host model
evaluation pending, and clarified that the feature has no MCP users yet. This work is
local development, with no rollout/migration program. The original Phase 4 three-host
evaluation remains unfinished; it is not represented as an automated-test result.

Implemented the seven ordinary semantic operations, a one-slide atomic application
adapter, `showme.apply`, Settings editing opt-in and separate user agent history controls.
Writes require the master MCP switch and editing switch; host-side checks are authoritative.
Guest writes, templates, Motion/Presence/Effect authoring, file operations and broad
document management remain unsupported.

## Architecture and behavior

`src/core/agentMutation.ts` validates strict bounded requests and stages native command
results against an accepted projection. It validates ownership/editability and scopes
before using commands, obtains generated insertion IDs internally, measures auto-sized
text and reports created/changed/removed IDs including removal descendants. Invalid
later steps produce no accepted changes. No-op staging creates no transaction/history.

`electron/agentEditing.ts` serializes agent requests per epoch, binds an ordinary
`EditorSession` transport to actor `mcp-local`, and uses existing runtime/authority
commit/lease/history endpoints. It checks access/identity/revision around async staging
and in the authority queue. Host-only optional admission callbacks were added without
changing persisted transaction/document schemas or native guarded-stale behavior.
The session exposes its known accepted receipt so post-acceptance refresh failure does
not become a rejection. Notifications cannot erase an accepted result.

The replay registry retains fingerprints, promises/receipts and a compact derived UI
summary per live epoch, bounded by identity count and receipt bytes. It is not a document
copy or durable protocol session. Identical retries share work; payload reuse differs
explicitly. Disable/reconnect/undo do not forget an accepted identity. Closing invalidates
the original runtime, while reopened epochs must be inspected. Durable work finishes
truthfully after admission even if HTTP delivery is aborted; the receipt remains recoverable.

Text measurement uses `measureText` and the managed-font loader in the existing isolated
production renderer, serialized with capture work. It does not flush the live editor or
move selection/playhead. Normal production font fallback remains normal fallback;
unavailable/hung measurement rejects before commit. A 10-second isolated measurement
deadline releases a hung native surface. Actual custom/missing-font scenarios were not
exhaustively exercised in this session.

Frame updates reuse the text/Free-media preservation responsibility extracted from
native `resizeElements`. A deterministic matrix test verifies Free media remains at
the same world placement through a changed viewport under a rotated/scaled parent.
Native text sizing behavior is preserved. The model-facing contract keeps parent-local
frame fields and requires explicit movement scopes.

The host build exposed obsolete `core/media.ts` pass-throughs that dynamically imported
renderer metadata enrichment, pulling browser/platform initialization into CJS. Removed
those wrappers and pointed the two renderer callers directly at their existing
`components/mediaEnrichment.ts` owner. No enrichment/decoder implementation changed.

Agent undo/redo uses authority guards and leases, not a second stack. Human Ctrl+Z remains
actor-local. A native test initially tried to undo an earlier insertion after human
structural undo/redo changed the common parent's order; the authority correctly refused.
The final test asserts successful recovery on an unchanged scope and safe refusal after
a later structural conflict. No authority guards or tests/timeouts were weakened.

The Settings checkbox was corrected to update optimistically while its preference saves,
then roll back on failure. Compact Agent history controls use the existing toolbar/icon
patterns; Settings and a 1024-pixel editor view were visually inspected. Final tests
retain normal failure-only screenshot/trace behavior.

## Verification

Passed on this implementation:

- `npm run build`: TypeScript verification/typecheck, Vite and Electron/helper bundles.
- With `SHOWME_TEST_FILES='["tests/feature/editor/agentEditing.test.ts","tests/feature/editor/agentBridge.test.ts","tests/core/document.test.ts","tests/feature/editor/session-failure.test.ts","tests/feature/editor/operation-work.test.ts","tests/feature/editor/text-style-authority.test.ts","tests/feature/media/frame-rules.test.ts"]'`,
  `npx vitest run`: 56 tests across seven files. Includes 17 editing declarations,
  actual HTTP response loss while durability is held, canonical concurrent retry,
  exact queued revision admission, human/LAN actor leases, capacity bounds, revocation,
  close/reopen, durable failure and acceptance despite refresh failure.
- With `SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts","tests/extended/agent-preview.spec.ts","tests/extended/agent-context.spec.ts"]'`,
  `npx playwright test --config playwright.electron.config.ts --output test-results-agent-editing`:
  seven native tests passed (both existing context declarations, both production
  preview declarations, read-only MCP loop/restart and the new editing/agent-history loop).
- `npx electron-builder --dir --win --x64 --config.directories.output=test-results-mcp-package --publish never`:
  unsigned local directory package passed; no installer or publishing.
- With `SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts"]'`,
  `SHOWME_MCP_PACKAGED_EXE='test-results-mcp-package/win-unpacked/ShowMe.exe'` and
  `SHOWME_MCP_HELPER='test-results-mcp-package/win-unpacked/resources/showme-mcp.cjs'`,
  `npx playwright test --config playwright.electron.config.ts --output test-results-agent-editing-packaged`:
  all three MCP tests passed, including actual packaged editing/text measurement/user history.
- Targeted ESLint covering new/changed core, host, MCP, platform, renderer and test files:
  no errors or warnings. React hooks/accessibility review and visual inspection performed.
- `npm run test:stats`, `npm run test:audit`: 534 active declarations in 85 groups.
- `git diff --check`: no whitespace errors.

No full/release suite, signed installer, audience-navigation commit gate, macOS package,
real LAN guest/host session, exhaustive managed-font matrix, or three-host/model editing
evaluation ran. Actor-level LAN conflicts are deterministic authority tests, not a real
LAN run. The audience-navigation gate remains required
before a rendering-affecting main commit or integration.

## Remaining evaluation

The SDK/client/package tests verify actual tools, pixels, state and history, but their
requests are test-authored. They do not establish a model's target-selection accuracy
or visual judgment. Continue the model-host corpus from the plan and record real tool
sequences, target IDs, accepted final state, unrelated mutation counts and undo outcomes.
This evaluation does not block the developer's explicitly authorized local experiments.
