# Public release readiness

Assessment date: 2026-10-25. Cleanup branch: `release/public-cleanup`.
The branch retains the save/replacement work from `55ea598` and is reviewed in
PR #24 against `chatgpt/save-replacement-guard`.

## Decision

The code and verification blockers identified during cleanup are resolved. All 709
active declarations passed on Windows across the full development suite and release
checks. The source PR is ready for review; cross-platform binary certification is
separate from source merge readiness.

## Scope

Reviewed tracked files, dependency/build configuration, manual GitHub workflows,
public documentation, Electron permissions, document authority entry points and
active test coverage. This is an engineering readiness assessment, not an exhaustive
security audit. No document format, persistence path, editor UI or runtime architecture
was replaced. Public version 1 remains the compatibility baseline.

## Cleanup and resolved blockers

- Updated compatible dependencies, then migrated the remaining Zod dependency to
  4.6.7. `npm audit` and `npm audit --omit=dev` now report zero vulnerabilities.
  The migration adds the explicit presenter record key schema and replaces a
  synthetic Zod refinement context with supported validation. MCP discovery now
  reflects Zod's discriminated-union `oneOf` schema output.
- Required image-worker and MCP bundles and their maps in build verification.
  Missing-bundle checks were exercised separately and correctly rejected each case.
- Removed an unused import, five superseded planning/scratch documents and two unused
  screenshots (1,273 lines removed). Current architecture, setup, implementation
  findings, benchmark evidence and license notices remain. Removed plans are in Git history.
- Added repository/issue metadata, contributor instructions, security reporting
  guidance and a documentation index. `private: true` prevents accidental npm publication.
- Updated shader tests to sample current GPU framebuffers or presented bitmaps.
  Bypassed Effects retain hidden bitmaps: coverage verifies hidden output, restored
  source visibility, preceding shader pixels and the unchanged active-stage pixels.
  Direct surface tests now provide their owned GPU chains. Renderer-only harnesses
  use the static harness page instead of racing the editor's asynchronous startup.
- Updated clipboard failure injection to the clipboard API actually used by the UI,
  and aligned timing-copy expectations with current Effect timing behavior.
- Native fixtures select an isolated ShowMe root and use its shared Library. Restart
  testing takes an accepted discard before relaunch rather than creating an unintended
  recovery dialog. MCP fixture shutdown now follows graceful app close and waits for
  the process to exit before deleting its Windows files. No test retries were added.
- Capped Vitest at eight concurrent workers to avoid saturating the shared host disk
  with dozens of native/storage test processes. The 128 MiB archive integrity test
  has an explicit I/O timeout; archive size, byte-integrity and corruption checks remain.
- Fixed text-worker watchdog accounting: dispatch is separately bounded, the
  worker acknowledges execution start, and both a renderer watchdog and worker-side
  elapsed-time check retain the 500 ms code-execution limit. Original failures stay
  actionable instead of becoming a generic unavailable error. A deterministic test
  verifies delayed dispatch, execution termination and duplicate acknowledgments.
- Electron groups now run once each in separate Playwright processes, with distinct
  artifact directories. This removes the demonstrated cross-file automation/compiler
  interference that stalled capture checks in combined runs. The original native
  capture fixtures, samples, tolerances and timeouts are retained.
- The release watcher test waits for SVG preview decoding before external deletion,
  avoiding a Windows unlink racing the active thumbnail read.

## Verification

- `npm run test:full`: passed, 706 declarations: 525 unit, 138 browser and 43
  Electron tests. Includes the production build and both audience-navigation
  declarations (dense rendering stress and late-image navigation).
- `npx playwright test --config playwright.electron.config.ts`: passed, both
  release-tier desktop IPC/startup declarations.
- `npx electron-builder --win nsis portable --x64 --publish never`: passed with
  `CSC_IDENTITY_AUTO_DISCOVERY=false`; generated the Windows installer and portable app.
- `npx playwright test --config playwright.packaged.config.ts`: passed, one
  packaged production-renderer/preload startup declaration.
- `npm run typecheck`, `npm run lint`, `npm run verify:build`,
  `npm run test:stats`, `npm run test:audit`, `git diff --check` and release
  documentation link validation passed. Registry: 709 declarations / 105 groups.
- `npm audit` and `npm audit --omit=dev`: zero vulnerabilities.

There are no skips, quarantines, deprecated groups or test retries. Earlier diagnostic
runs exposed the issues above; the final full run passed after the fixes. Workload
assertions are correctness checks, not comparable performance measurements.

## Distribution and administration

Source review and merge readiness do not certify a signed public binary release.
macOS builds, installation and notarization need verification on macOS. Windows
builds are unsigned; the configured macOS builds use ad-hoc signing. No release,
tag, installer publication or integration into `main` is performed by this cleanup.
Automatic CI remains paused; local verification is authoritative.

GitHub private vulnerability reporting was checked and is currently disabled.
`SECURITY.md` describes the available fallback without promising a private channel
or response time. Enabling a dedicated private intake remains repository administration.

Electron windows retain sandboxing, context isolation, disabled Node integration,
blocked renderer navigation and denied new windows. Experimental LAN collaboration
remains trusted-local and unencrypted; local MCP and agent editing remain opt-in.
A limited tracked-text scan found no common private-key/token markers or home paths;
Git history and external secret scanning were not audited.

Any later rendering-affecting integration into `main` must satisfy the audience
navigation gate against the exact integration candidate based on the latest `main`.
