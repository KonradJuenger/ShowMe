# Phase 4 implementation and read-only evaluation

Date: 2026-10-17. Environment: local-codex, Windows x64, current shared checkout.
Technical read loop implemented. Three-host model evaluation remains pending;
this document does not claim that SDK tests are model/client targeting experiments.

## Implemented result

The standalone `mcp/stdio.ts` helper uses locked SDK v2.3.1 packages and exposes only
`showme.context`, `showme.inspect`, `showme.preview`. It discovers authenticated live
instances per call using an explicit user-data directory. Multiple live instances
are ambiguous unless explicitly selected; stale files/PIDs cannot select an app.
Stdout belongs to SDK framing and diagnostics are redacted stderr.

`electron/agentInspection.ts` reuses the Phase 1 projection with exact document,
epoch/revision and selection-UI-epoch checks before/after reads. The master setting
gates the private three-command bridge; disable closes sockets and invalidates pending
delivery before asynchronous cleanup. Start/stop is serialized. Tokens/instance IDs
rotate, descriptors publish atomically and only the owning instance removes its file.
Native work retains admission slots until it finishes, even after socket revocation.

The bridge rejects unauthenticated, non-loopback, unexpected Host/Origin/fetch,
unsupported route/method/command and oversize requests. Limits are 64 KiB input,
2 MiB JSON output, 32 MiB preview output, eight admitted reads and 32 connections.
Read/preview delivery deadlines are 15/30 seconds; native cleanup remains owned by
the existing capture service. Errors carry recovery guidance and never raw stacks.
Windows startup restricts the descriptor directory with the current user's SID;
an effective-file-ACL assertion passed. POSIX modes are enforced but were not tested
on a POSIX host in this session.

Settings preserves its existing layout and adds status, Node runtime guidance and a
token-free Copy client configuration action. Its rendered result was visually
inspected. Build wiring emits a standalone CJS helper, copied outside ASAR in desktop
packages. No run-as-Node mode, client-config writes, app autolaunch, document-owner,
renderer/persistence schema, authority/history or actor changes were added.

## Automated traces and observations

The real SDK stdio client launched the built helper from an unrelated working directory:

1. Listed exactly three read-only tools with declared input/output schemas.
2. Received APP_UNAVAILABLE while disabled, then used the actual copied Settings config.
3. Read context, inspected a slide and current selection at explicit freshness handles.
4. Received scoped title text while fixture speaker notes remained absent.
5. Received an MCP PNG image at exactly 320×180 plus metadata without duplicate image
   bytes. Accepted projection, selection and UI epoch stayed unchanged.
6. Held the actual native composer, disabled MCP, and received an error without pixels.
   Re-enabling restored access; prior credentials failed.
7. Exited the helper on client close; no framing errors or token logging occurred.
8. Crashed/restarted ShowMe while retaining the helper; discovery recovered and an old
   epoch failed. Switching documents rejected the old document ID. Normal application
   close through `requestClose` removed only the current descriptor.

The same two tests passed against the Windows directory package and its external helper.
The tests measure protocol/state contracts; they do not establish model understanding,
subjective visual alignment, target-recognition accuracy or token/latency benchmarks.

## Verification commands

Passed:

- `npm run build` (typecheck, Vite and bundled Electron/helper output).
- With `SHOWME_TEST_FILES='["tests/feature/editor/agentInspection.test.ts","tests/feature/editor/agentBridge.test.ts"]'`,
  `npx vitest run`: 13 declarations passed, including effective Windows ACL and retained
  admission across access revocation.
- With `SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts"]'`,
  `npx playwright test --config playwright.electron.config.ts --output test-results-agent-mcp`:
  two native SDK tests passed.
- `npx electron-builder --dir --win --x64 --config.directories.output=test-results-mcp-package --publish never`:
  passed; unsigned local directory package, no installer/publish.
- With the same test selection, `SHOWME_MCP_PACKAGED_EXE='test-results-mcp-package/win-unpacked/ShowMe.exe'`
  and `SHOWME_MCP_HELPER='test-results-mcp-package/win-unpacked/resources/showme-mcp.cjs'`,
  `npx playwright test --config playwright.electron.config.ts --output test-results-agent-mcp-packaged`:
  both tests passed against the actual packaged app/helper.
- Existing context/preview regression selection: `SHOWME_TEST_FILES='["tests/extended/agent-context.spec.ts","tests/extended/agent-preview.spec.ts","tests/feature/media/preview-electron.spec.ts"]'`,
  `npx playwright test --config playwright.electron.config.ts --output test-results-agent-mcp-regression --grep 'MCP setting gates|private context|context inspection|native preview waits|closing the editor'`:
  three context/preview declarations passed. The thumbnail teardown declaration initially
  failed at its queued-Effect-start marker, before shutdown. A focused rerun using
  `SHOWME_TEST_FILES='["tests/feature/media/preview-electron.spec.ts"]'` and
  `npx playwright test --config playwright.electron.config.ts --output test-results-agent-mcp-close --grep 'closing the editor'`
  passed. No test source/timeout/retry setting was changed to mask that observation.
- Targeted ESLint on the Phase 4 source/test files and main/preload/platform boundary;
  `npm run test:stats`; `npm run test:audit`; `git diff --check`.

No full suite, signed installer/release suite, audience-navigation commit gate,
macOS package, real LAN guest session or real model-host comparison ran. No commit,
push or PR was requested. The docs/settings work does not affect slide rendering;
no main integration was performed.

## Model-host evaluation gate still open

Local-development update, 2026-10-18: the developer explicitly authorized editing
behind its local opt-in while this evaluation remains pending. See
`CODEX_PHASE5_6_FINDINGS.md`. The following records the broader evaluation work still
to do; it does not block that authorized local testing.

Available executables inspected locally include Codex and VS Code; this is not
evidence of three configured model hosts.
No host configuration was changed and no model transcript was fabricated. The SDK
client and packaged run are two execution environments of the same automated client.

Before writes, run the phased-plan corpus in at least three available MCP hosts and
record each host/model/version, task, exact tool sequence, payload bytes, target IDs,
image usage, failures and latency. Compare structure-only, image-only and combined
reads for selection, slide description, text targeting, alignment, overlap and Effect
identification. Click-2 visual reasoning must acknowledge unsupported deterministic
sampling; phrase search requires explicit slide reads. Report unavailable cases.

Advance only after actual targeting results support safe ordinary edits. The next
implementation phase is the application semantic mutation adapter, not exposing raw
transactions or granting writes merely because this transport smoke passed.
