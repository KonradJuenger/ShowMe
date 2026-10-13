# ShowMe development rules

## Architecture

ShowMe has one current document architecture. Persistent editor changes flow through:

`Editor -> EditorSession -> DocumentOperation[] -> DocumentTransaction -> DocumentAuthority -> durable recovery -> accepted revision`

- Keep one document owner and one persistence path.
- Solo editing and collaboration must use the same `DocumentAuthority` model.
- Renderer-local drafts and interaction previews stay local until they become semantic document operations.
- Save, Save As, recovery, package/export, slide transfer, presenter/export rendering, and browser storage must use the current document model.
- Do not introduce parallel document schemas, editor runtimes, authorities, or persistence paths.

## Compatibility policy

Public version 1 is the document and protocol compatibility baseline.

- Support the current document, `.sme`, `.smp`, asset, recovery, slide-transfer, and collaboration formats.
- Do not add readers, aliases, migrations, fallback schemas, or adapters for historical development formats unless explicitly requested.
- If a current persisted format changes, version the change and update writers, readers, tests, fixtures, and any required migration from the immediately supported format together.
- Runtime fallbacks for current behavior are valid, for example missing assets, unavailable fonts, interrupted recovery writes, or unavailable optional platform capabilities.

## Product behavior

Preserve established UI behavior during unrelated refactors. In particular, do not casually change:

- selection, multi-selection, move, resize, rotate, duplicate, delete, and grouping
- text editing, IME behavior, history grouping, undo/redo, and clipboard behavior
- media/frame editing, Fit/Fill/Free behavior, video controls, and asset handling
- snapping, guides, rulers, Layers, hierarchy, and scope navigation
- slide navigation, sections, reorder/transfer, notes, presenter mode, and keyboard shortcuts
- collaboration presence, leases, remote previews, reconnect, and actor-scoped undo/redo
- save/open/recovery/package/export behavior

UI redesign and architecture cleanup are separate tasks unless the request explicitly combines them.

## Git workflow

The repository is public. Keep experimental agent work isolated from `main`, while preserving the developer's fast local Codex workflow.

Every contributor and agent must satisfy the required audience-navigation gate below
before any commit or integration into `main`, including direct Codex commits.

### ChatGPT

These rules apply to ChatGPT sessions that implement changes in this repository:

- Never implement changes directly on `main`.
- Before editing, inspect the current `main` HEAD and create or reuse a dedicated branch named `chatgpt/<task>` from the current `main`.
- Make all implementation commits on that branch. Intermediate commits may be frequent; they are working history.
- Pushing the ChatGPT task branch is allowed when needed for the workflow.
- When the requested work is complete, run the relevant verification, report the result and final branch commit, then stop.
- Do not merge, squash, cherry-pick, rebase into, push to, reset, or otherwise modify `main` unless the developer explicitly authorizes integration after reviewing or testing the change.
- Explicit integration authorization includes instructions such as `merge it`, `pull it in`, `put it on main`, `ship it`, `looks good, merge`, `ok pull`, or equivalent unambiguous wording.
- After authorization, integrate the approved work into the latest `main`, run the relevant tests, and prefer one clean squash commit on `main` unless the developer requests otherwise.
- If integration exposes non-trivial conflicts, unexpected behavior, or new test failures, stop before modifying `main` and report the problem.
- Only after the change is successfully integrated into `main`, the relevant tests pass, and the resulting `main` has been pushed successfully, delete the temporary ChatGPT branch locally and remotely.
- If branch deletion is unavailable or fails after a successful integration, add that branch to the cleanup queue below.
- On every explicitly authorized integration/pull into `main`, first retry deletion of every branch in the cleanup queue, remove entries that were deleted successfully or no longer exist, and keep only branches that still need deletion.
- After integrating the current task, update the cleanup queue again before finishing.

#### Branch cleanup queue

Branches listed here have already been integrated into `main` and are safe to delete:

None.

Keep this list accurate. Do not delete a branch merely because it appears stale; only branches known to be successfully integrated into `main` belong here.

### Codex and developer working tree

- Codex may work directly on the currently checked-out branch, including `main`, unless the developer instructs it to use a branch.
- Do not force the ChatGPT branch workflow onto Codex sessions running in the developer's working tree.
- Human contributors follow the branch or contribution workflow they explicitly choose.

## Implementation discipline

- Inspect the current branch and HEAD before editing. Preserve valid newer work.
- Prefer small, focused commits with one clear responsibility.
- Keep `Editor.tsx` focused on composition and orchestration. Retain adapters and view models when they have a clear current responsibility.
- Remove dead pass-through wrappers and duplicate APIs when their only purpose is obsolete architecture.
- Do not add speculative abstraction or compatibility code.
- Fix regressions at their source. Do not weaken tests to make a refactor pass.

## Testing philosophy

Local verification is authoritative. Run the smallest test set that provides meaningful confidence.
Do not run the complete ShowMe suite by default.

### Required audience-navigation gate for `main`

`tests/feature/presenter/audience-navigation.spec.ts` is the highest-priority
regression test and a required blocker for every commit to `main`.

- Before creating any commit on `main` or integrating work by merge, squash,
  cherry-pick, rebase or pull, run this test against the exact proposed result
  based on the latest `main`. Verify integration candidates on an isolated branch
  or worktree before modifying `main`.
- The requirement applies to every change, including unrelated features,
  documentation and urgent fixes. A passing result from an earlier revision is
  insufficient if the proposed result has changed.
- Run `npm run test:feature -- presenter` and confirm that the audience-navigation
  test actually executed and passed. A focused invocation selecting this file is
  also valid. A failing, missing, skipped or unexecuted test blocks the commit,
  integration and push to `main`.
- While this test is failing, continue investigation and working commits on a
  task branch. Do not integrate that branch into `main` until the gate passes.
- Preserve the contract: upcoming audience images must prepare and decode before
  navigation, so later slides introducing new assets do not stall on cold image
  work while early slides and warm revisits appear fast. Do not weaken, skip,
  quarantine, deprecate or delete this test to bypass the gate unless the
  developer explicitly changes this requirement.
- Report the exact verification command and result before proceeding into `main`.

For a normal task:

1. Determine which feature area changed.
2. Run `npm run test:feature -- <area>` (editor, media, motion, effects, persistence, presenter initially).
3. Run `npm test` for the tiny core suite after meaningful production changes.
4. Broaden only when scope requires it. Localized CSS needs only a relevant browser/component check, if one exists.

Do not investigate unrelated feature failures unless the change plausibly caused them.
Do not repair deprecated tests unless requested, resurrect coverage merely because it
existed, or add end-to-end tests where deterministic domain tests protect the same contract.
Do not assert temporary DOM nesting, classes, arbitrary pixels, animation frame counts,
menu layout or React internals unless they are product contracts.

Commands:

- `npm test` / `npm run test:core`: active core only, normally under 10 seconds.
- `npm run test:feature -- <area>`: that area's active feature tests; uncovered areas fail clearly.
- `npm run test:extended`: cross-subsystem integration including the small browser smoke.
- `npm run test:full`: active core, feature and extended groups across runtimes.
- `npm run test:release`: full + build verification + release Electron and packaged smoke; packages the current host (Windows/macOS).
- `npm run test:deprecated`: explicit retained deprecated executables only.
- `npm run test:stats`: regenerate committed composition statistics.
- `npm run test:audit`: validate metadata, managed files and stats without product tests.
- `npm run typecheck`, `npm run lint`: static verification when relevant.

Full verification is justified for release preparation, DocumentAuthority/shared architecture,
schema/storage/package changes, broad cross-cutting refactors, or an explicit user request.
Run relevant browser/Electron paths when the actual runtime boundary changes. Release-only
checks stay outside the development loop. Install Chromium before browser checks. The manual desktop
verification workflow covers Windows/macOS; ordinary CI stays small.

When adding or revising tests:

- Assign the product area and lowest sensible tier; keep core tiny.
- Register every test file in `tests/registry.json`, describe its contract, and update `lastReviewed`.
- Run `npm run test:stats` and `npm run test:audit` after composition changes; commit stats.
- Use explicit named declarations; avoid dynamic registration and skip/only/todo. See `tests/README.md`.
- Reassess whether the contract still matters and is tested at the right abstraction/tier.
- When behavior intentionally changes, update its test; deprecate/delete obsolete contracts.
- Deprecation requires tier/status `deprecated`, a reason and `removeAfter` (normally 30 days).
  Source may be deleted immediately; remove the metadata record at the cleanup date.
- Temporary quarantine requires a reason and `reviewBy`; investigate, restore or delete by that date.
  Deprecated/quarantined groups never run implicitly. Never mask flakiness with retries.

Useful confidence per unit of maintenance/runtime matters more than increasing test count.
Do not change production behavior merely to satisfy obsolete assertions.

At task completion report changes, boundaries retained, exact verification commands and
results, checks not run, and final commit SHA. Never claim a check ran when it did not.
