# ShowMe development rules

## Execution profile

Workflow profiles describe the working environment, not the model name.

- `local-codex`: Codex app, CLI or IDE working alongside the developer in their local checkout.
- `chatgpt-remote`: ChatGPT browser sessions implementing changes in a separate checkout or remote environment.
- Select the profile from an explicit user, host or session declaration, including `Execution profile: local-codex` in machine-level instructions. An explicit user selection takes precedence within these project rules.
- Without a declaration, use unambiguous host/session context. Do not infer the profile from the model calling itself ChatGPT or Codex, available shell tools, an operating-system path, or the current branch alone. If the environment is ambiguous, ask once before Git mutations.
- Apply only the selected profile's Git workflow. Local Codex must not inherit the remote ChatGPT branch/PR workflow.
- Architecture, compatibility, product behavior and testing principles apply to both profiles. A user request may narrow or expand the workflow for the current task.

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

The repository is public. Remote work normally stays isolated from `main`; local Codex preserves the developer's fast, shared-checkout workflow.

### Local Codex (`local-codex`)

- Work directly on the currently checked-out branch, including `main`, unless the developer requests another branch.
- Do not automatically create branches, worktrees or PRs. Use isolation when requested or when its need has been established with the developer; an unfinished merge is not permission to start an alternative workflow.
- Commits on the current branch, including `main`, are allowed at useful, coherent milestones. Do not create a commit merely because one chat request has been implemented or a completion report mentions a SHA.
- Treat follow-up changes as ongoing development. Batch related edits and verification rather than automatically finalizing, benchmarking or packaging after every message.
- If an unfinished Git operation or conflicting edits prevent safe progress, preserve the checkout and report the limitation. Do not conclude, abort or reset that operation without authorization.
- Do not push or create a PR unless requested. Before a rendering-affecting commit on `main`, satisfy the audience-navigation gate below.

### Remote ChatGPT (`chatgpt-remote`)

These rules apply to the remote profile, regardless of the underlying model:

- Normally implement changes on a dedicated task branch, not directly on `main`.
- Before editing, inspect the current `main` HEAD and create or reuse a dedicated branch named `chatgpt/<task>` from the current `main`.
- Make implementation commits on that branch. Commit frequently at coherent checkpoints; intermediate commits are working history.
- Pushing the ChatGPT task branch is allowed when needed for the workflow.
- Create or update a PR when the work is reviewable; use a draft PR while work is ongoing. Continue related follow-up work on the same task branch and PR.
- When the requested work is ready for handoff, run verification appropriate to its scope and risk, report the result, branch commit and PR, then stop. A follow-up edit does not automatically require another full verification cycle.
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

### Human contributors

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

Choose verification using judgment, not a fixed checklist:

- Assess the size of the change, the behavior it can affect and the cost of a regression. A small diff in shared runtime code may need broader checks than a larger isolated UI change.
- Documentation-only changes normally need a diff review, not product tests. Localized cosmetic changes need only a relevant browser/component check when useful.
- For localized behavior changes, prefer a focused existing test or deterministic domain test. Do not automatically run an entire feature area when one file adequately protects the changed contract.
- Use `npm run test:feature -- <area>` when several behaviors in an area change or the risk warrants it. Use `npm test` when core contracts change or its broad sanity check adds meaningful confidence; neither command is mandatory after every edit.
- Run typecheck, lint or build when relevant to the change. Do not automatically run all three, or repeat a build already performed by the selected test command.
- Broaden verification when shared behavior, a changed runtime boundary, failures or an explicit user request justify it. Run the relevant browser/Electron paths when that boundary changes.
- During ongoing iteration, batch related changes and reuse passing results for unaffected code. Repeat checks after relevant changes, failures or unresolved concerns; do not restart the verification cycle merely because another message arrived.
- A request to implement a change is not automatically a request to commit, open a PR, benchmark or prepare a release. Apply the selected Git workflow and keep progressing on the user's current work.

### Audience-navigation gate for commits and integration into `main`

This is a commit/integration gate, not a requirement to run the presenter suite after every rendering edit.

- Before a rendering-affecting commit on `main`, or integration by merge, squash, cherry-pick, rebase or pull, run `tests/feature/presenter/audience-navigation.spec.ts` against the exact proposed result based on the latest `main`. Verify integration candidates on an isolated branch or worktree before modifying `main`.
- Rendering impact includes renderer, media/cache, effects/shaders, text/font/layout, animation, audience/presenter lifecycle, output sizing and shared model/runtime changes that may alter rendered output or its preparation. When impact is uncertain, run the gate before committing or integrating.
- A focused invocation of this file is sufficient; `npm run test:feature -- presenter` is also valid when broader presenter checks are warranted. Both declarations must execute and pass: the late-image navigation contract and the dense rendering stress test. A missing, skipped, unexecuted or failing declaration blocks the commit, integration and push to `main`.
- Preserve advance image preparation and decoding, the stress workload's images, text, GLSL/CSS effects, live motion and bounded-residency checks. Do not weaken, skip, quarantine, deprecate or delete the gate to bypass a failure unless the developer explicitly changes this requirement.
- Documentation-only changes and cosmetic CSS that cannot affect slide rendering, sizing, visibility, capture or performance are exempt. State the exemption when reporting verification.
- Report the exact gate command and result before proceeding with the commit or integration into `main`.

### Performance measurements

- Repeated benchmarks are not a routine requirement for every rendering edit or chat turn. Run them when requested, when a coherent change materially targets audience performance, or when evidence suggests a performance regression worth investigating.
- When warranted, measure the completed coherent candidate rather than repeatedly benchmarking intermediate edits. Prefer comparable clean-commit measurements and compare with matching-machine/workload runs.
- Keep benchmark observations in persistent history and summarize comparable measurements in `areweslowyet.md` when that tooling is available. Dirty runs are exploratory; do not attribute them to their parent commit or claim improvement from a binary test pass or mismatched environments.
- The audience-navigation correctness gate remains mandatory before rendering-affecting commits or integration into `main`, whether or not additional repeated benchmarks are warranted.

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

Full verification may be justified for release preparation, DocumentAuthority/shared architecture,
schema/storage/package changes, broad cross-cutting refactors, or an explicit user request;
choose it based on the actual reach and risk rather than a keyword alone. Release-only
checks stay outside the development loop. Install Chromium before browser checks. The manual desktop
verification workflow covers Windows/macOS; ordinary CI stays small.

When adding or revising tests:

- Assign the product area and lowest sensible tier; keep core tiny.
- Register every test file in `tests/registry.json`, describe its contract, and update `lastReviewed`.
- Run `npm run test:stats` and `npm run test:audit` after composition changes; include updated stats in the eventual implementation commit, without creating a separate commit merely for this step.
- Use explicit named declarations; avoid dynamic registration and skip/only/todo. See `tests/README.md`.
- Reassess whether the contract still matters and is tested at the right abstraction/tier.
- When behavior intentionally changes, update its test; deprecate/delete obsolete contracts.
- Deprecation requires tier/status `deprecated`, a reason and `removeAfter` (normally 30 days).
  Source may be deleted immediately; remove the metadata record at the cleanup date.
- Temporary quarantine requires a reason and `reviewBy`; investigate, restore or delete by that date.
  Deprecated/quarantined groups never run implicitly. Never mask flakiness with retries.

Useful confidence per unit of maintenance/runtime matters more than increasing test count.
Do not change production behavior merely to satisfy obsolete assertions.

At handoff, briefly report changes, important boundaries retained, exact verification commands
and results, and material checks not run. Include a commit SHA and PR only if created; do not
create them just to complete the report. For ongoing iteration, keep the update proportional
to the work instead of producing a release report after every edit. Never claim a check ran
when it did not.
