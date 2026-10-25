# Public release readiness

Assessment date: 2026-10-25. Starting revision: `55ea598`.
Cleanup branch: `release/public-cleanup`, based on the checked-out
`chatgpt/save-replacement-guard` branch to retain its save/replacement fixes.

## Decision

The source cleanup is suitable for review, but this candidate is **not yet a
verified public binary release**. The remaining dependency advisory and failing
verification below need resolution before making that claim.

## Scope and findings

Reviewed the tracked source inventory, package/build configuration, GitHub workflows,
public documentation, Electron window permissions, document authority entry points,
and current test registry. This is an engineering readiness assessment, not a
complete security audit or review of every code path.

- The application has an established document authority and semantic operation
  model. Cleanup preserves version 1 storage/protocols and the current persistence
  path; no runtime, schema or UI redesign is included.
- Electron windows enable sandboxing and context isolation, disable Node integration,
  deny new windows and prevent renderer navigation. MCP and collaboration retain
  their documented opt-in/trusted-local boundaries.
- Generated builds, dependencies, reports, environment files and user presentations
  are already ignored. The tracked-file inventory contains no generated distribution
  or dependency trees. A limited text scan found no common private-key/token markers
  or user-home paths; Git history and external secret scanning were not audited.
- `electron/main.ts`, `src/core/agentMutation.ts` and editor components carry substantial
  orchestration complexity. Future extraction should follow actual responsibility
  boundaries and focused tests. File size alone does not justify a release refactor.
- Engineering handoffs and evaluation records remain useful history. A documentation
  index now distinguishes them from maintained user/contributor entry points.
- Automatic CI remains paused as required by project policy. Manual build and desktop
  verification workflows exist; local results remain authoritative.

## Cleanup implemented

- Updated compatible locked dependencies, including Electron 44.9.3, Vite 8.3.5
  and Vitest 5.0.5; raised their manifest minimums. The dependency audit decreased
  from seven affected packages to one without forcing a major-version migration.
- Added repository/homepage/issue metadata while retaining `private: true` to prevent
  accidental npm publication of the desktop application.
- Extended build verification to require the image worker and local MCP bundles
  and their source maps. Both are shipping entry points that were previously omitted.
- Removed an unused test import; lint now reports no warnings.
- Added contribution instructions, security reporting guidance and documentation navigation.
- Removed five superseded, unreferenced planning/scratch documents and the unused
  `docs/images/assets.png` and `docs/images/effects.png` screenshots. Current setup,
  architecture, implementation findings and benchmark evidence remain available;
  deleted development plans remain recoverable through Git history.

## Release blockers and follow-up

1. **Zod advisory:** both `npm audit` and `npm audit --omit=dev` still report one high
   severity advisory in Zod 3.25.76:
   [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
   The reported patched line starts at 4.6.6. ShowMe uses Zod throughout document,
   operation, IPC and MCP admission schemas. A migration must preserve accepted
   version 1 values, defaults, optional fields and rejection behavior. Follow the
   [upstream migration guide](https://zod.dev/v4/changelog) and verify the storage,
   collaboration and MCP boundaries; do not use `npm audit fix --force` as a substitute.
2. **Verification failures:** the broad test run is not green. See results below.
   Failures are recorded rather than hidden with retries, weakened assertions or
   removed registrations. Baseline attribution has not been established.
3. **Distribution verification:** Windows installer/portable smoke and macOS native
   builds, signing/notarization and installation checks remain outstanding. Current
   workflows intentionally produce unsigned Windows and ad-hoc-signed macOS builds.
   No release, tag, binary publication or push was performed by this cleanup.
4. **Security intake:** repository administrators should enable private vulnerability
   reporting before advertising it as available. The security policy describes the
   fallback and makes no unverified claim about repository settings.

## Local verification

- `npm run typecheck`: passed before dependency updates; `npm run build` passed
  afterward and includes the same compiler check.
- `npm run lint`: passed without warnings after cleanup.
- `npm run build`: passed for renderer, standalone HTML runtime and Electron entries.
- `npm run verify:build`: passed. A temporary local removal of each new required
  bundle separately confirmed verification rejects it; files were restored and
  verification passed again.
- `npm run test:audit`: passed, 708 active declarations in 105 groups. No test
  declarations or registry composition were changed.
- `npm test`: passed, 15 tests.
- `npm run test:full`: failed in the unit phase: 523/524 passed across 65 groups.
  `library-work.test.ts` expected no extra directory reads between cached list pages
  but observed 40 reads versus 24. An isolated invocation with
  `SHOWME_TEST_FILES=["tests/feature/media/library-work.test.ts"] npx vitest run`
  passed all 15 tests. This does not establish the broad-run failure as resolved.
- `npx playwright test --config playwright.config.ts`, with the registry-selected
  browser files: 130/138 passed. Eight failures: clipboard failure feedback in
  `editor/errors.spec.ts`; six declarations in `effects/authoring.spec.ts` (five
  canvas sampling failures and outdated timing guidance); and an unavailable
  `setTiming` test hook in `effects/typed-context.spec.ts`. Failed artifacts remain
  under ignored `test-results-browser/` for diagnosis.
- Both declarations in `tests/feature/presenter/audience-navigation.spec.ts` passed
  in that browser run: the dense rendering stress contract and late-image navigation.
  This was a correctness run with other runtime work in parallel, not a comparable
  performance benchmark.
- `npx playwright test --config playwright.electron.config.ts`, with the
  registry-selected Electron files: 35/43 passed. Eight failures: an `EBUSY`
  temporary Session Storage cleanup in `extended/agent-mcp.spec.ts`; an unavailable
  text effect in `effects/native-continuity.spec.ts`; three first-window timeouts
  and a missing preview-window reference in `media/preview-electron.spec.ts`;
  and first-window timeouts in `persistence/pdf-rendering.spec.ts` and
  `presenter/displays-electron.spec.ts`. Startup timeouts did not exercise the
  subsequent rendering assertions. Artifacts remain in ignored `test-results-electron/`.
- `git diff --check` and relative-link validation for the release documentation passed.

The full command stops at the first failing runtime. To evaluate the remaining
groups, select active core/feature/extended entries from `tests/registry.json` by
runtime, set `SHOWME_TEST_FILES` to their JSON path array, and run
`npx playwright test --config playwright.config.ts` for browser or
`npx playwright test --config playwright.electron.config.ts` for Electron.

Release-only packaging checks (`npm run test:release`) and macOS verification were
not run. This branch does not integrate into or commit on `main`; the audience gate
is still required before any later rendering-affecting integration into `main`.
