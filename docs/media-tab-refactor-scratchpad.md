# Media tab refactor scratchpad

Status: implementation complete; PR verification green
PR: #11
Branch: `chatgpt/media-library-folders-plan`
Rebased base: `c5240f0a39f9a79be34c88bc243f29142f615066`
Previous branch head retained in Git history reference: `f205c5f04a0938964077d013dfabf68f9954a390`

## Goal

Refine the Media panel into one calm, content-first Library surface while preserving the current ShowMe document, shared-root and media-preview architecture.

## Product decisions

- Rebuilt the PR on current `main`; the obsolete independent Media Library root setting was not restored.
- Kept the current `main` preview language for images and video: borderless content, no card chrome around every item.
- One Media panel now covers images, video, audio, fonts, effects and other files. One compact type selector replaces the previous Media/Effects tabs and category button rows. Search was removed.
- Management stays secondary. The default surface is content. Import, folder creation and Library reveal live in one overflow menu; item management appears only after requesting item actions.
- Effects use a checkerboard-backed rendered thumbnail so transparent/spatial shader and CSS/JS output remains legible.
- Image/video Library items can be dragged onto the canvas and are inserted at the drop position.
- Cleanup-managed files can be protected persistently from Library garbage collection through the managed filename `~p` marker. Folder protection is a bulk operation over current managed descendants, not inherited folder state.
- Protection is filesystem metadata carried by the managed filename, not presentation state or a central database. Protected filenames participate in the cleanup fingerprint to prevent races with a running scan.
- Effects are not marked for cleanup protection because the current media garbage collector does not collect live Effects. Effect deletion remains the existing recoverable Trash path.
- Existing applied effects remain document-owned. Editing or deleting a reusable Library copy does not mutate presentations.

## Implementation progress

- [x] Re-inspected PR #11 and current `main`.
- [x] Rebased the branch cleanly onto current `main`.
- [x] Preserved the newer `main` media-inventory verification behavior instead of blindly restoring the stale branch version.
- [x] Ported recursive native folders and duplicate-hash physical copies onto the shared ShowMe-root storage model.
- [x] Ported recoverable Effect trash and rendered effect thumbnails.
- [x] Replaced the Media/Effects split with a unified Media surface and compact type filter.
- [x] Preserved borderless previews and removed persistent management chrome.
- [x] Added checkerboard-backed effect previews.
- [x] Added drag-to-canvas for Library images/video with drop-position insertion.
- [x] Added sync-safe filename-encoded garbage-collection protection and folder bulk protection.
- [x] Added regression coverage for unified browsing, filename protection and collector-level protection.
- [x] Reviewed the final PR diff against current `main`.
- [x] Removed Search from the Media tab.
- [x] Effect thumbnails are queued instead of being dropped when preview work is busy; failed/empty renderer previews are not permanently cached.
- [x] Effects no longer expose the media-only Import action.
- [x] Malformed Effect files are skipped when checking restore identity collisions.
- [x] Native Library pagination now reuses one invalidated inventory snapshot instead of recursively rescanning for every page.

## Verification log

Final code head `d5457cb66ed2ea4f88b03455f7b4a7967933f7c6` passed the GitHub Development checks on 2026-10-15:

- `npm run typecheck`
- `npm run lint`
- `npm run test:audit`
- `npm test`

The test suite includes two new regression cases:
- unified native Library browsing reports inherited cleanup protection correctly;
- a protected folder keeps otherwise-unreferenced managed assets out of cleanup until protection is explicitly removed.

No merge into `main` has been performed.


## Follow-up review fixes

After the initial UX pass, review found four correctness/performance issues. They are addressed on the branch:

1. Effect thumbnails no longer return early at the shared preview limit. Effect work is serialized through the preview queue, while the UI only caches successful preview results.
2. The Effects filter no longer exposes the generic media importer.
3. Restoring a deleted Effect ignores unrelated malformed `.txt` Effect files while still rejecting a valid identity collision.
4. `NativeLibraryBrowser` is now persistent per active Library root and owns a cached recursive inventory snapshot. Pagination filters/slices that snapshot. Inventory/protection mutations and external Library inventory notifications invalidate it.
5. Effect restore and Effect Library save/move/delete/folder mutations now invalidate the native Library inventory synchronously. Correctness no longer depends on filesystem watcher timing.
6. Effect thumbnail rendering no longer shares the slide-preview queue. It uses a dedicated hidden compositor and a separate serialized queue with at most eight admitted requests. New Effect captures yield while slide-preview work is pending, so Library scrolling cannot put a long Effect backlog ahead of slide thumbnails.

Regression coverage also checks that requesting another page does not perform another recursive directory walk, that a malformed Effect cannot block restoring an unrelated Effect, and that a prewarmed cached Effect inventory sees a restored Effect immediately.

Follow-up code heads:
- `8c791ef5f5974ad06d8f39287aad1e8f32f1dcf9`: synchronous Effect inventory invalidation; Development checks green.
- `8666f3c9a60ca6b12d728a4627c3ab0e4e387288`: isolated bounded low-priority Effect preview queue; Development checks green.


## Multi-selection and folder organization

The Media Library now uses a conventional desktop selection model:

- single click selects an item and draws the existing blue selection outline;
- Shift-click selects a contiguous loaded range;
- Cmd/Ctrl-click toggles individual items;
- dragging on empty Library space creates a blue marquee and selects intersecting visible items;
- double-click opens a folder or inserts insertable media, so selection no longer conflicts with single-click insertion;
- selected items expose `Move to Folder…`;
- `New Folder…` remains a secondary Library action in the overflow menu;
- a selection exposes `New Folder with Selection…`, which creates the destination folder and moves the selected items into it in one workflow;
- batch moves default to the selected items' current parent folder and skip no-op same-folder moves;
- partial batch failures force a reload when earlier mutations already succeeded, so the UI cannot remain stale.

Physical Library folders remain scoped to one media category. Mixed-category items can still be selected together, but batch move/create-with-selection is only offered when the selection shares one category.

Implementation heads:
- `c4c1061509d3829b925df949b40ccd9907f2b072`: multi-selection, Shift selection, marquee selection and batch folder movement.
- `544b649d16c29dc00ea93a2361f8cb9956b80087` / `4fe769bdfad26532aa86eaa1dc951301c6d40b3b`: create-folder-with-selection workflow and marquee styling.
- `572c9d98dbfa163c3b5129c150b3cf74e3e10d1e`: batch moves default to the current parent folder.
- `9cbebc1596758c0aa31ed8de6a094d7e23d84017`: batch mutation consistency on partial failure.

Development checks are green at `9cbebc1596758c0aa31ed8de6a094d7e23d84017`:
- `npm run typecheck`
- `npm run lint`
- `npm run test:audit`
- `npm test`


## Filename-encoded cleanup protection

Cleanup protection is now filesystem-native and sync-safe. There is no persistent protection database.

- normal managed media: `photo__<sha256>.jpg`
- protected managed media: `photo__<sha256>~p.jpg`
- `~p` is metadata, not asset identity. Both forms resolve to the same SHA-256 asset ID.
- Existing managed filenames without `~p` remain valid and are simply unprotected. No document or Library schema/version bump is required.
- Protecting one file renames that physical managed file to/from the `~p` form.
- Protecting a folder recursively applies that rename to the managed files currently inside it. The folder itself stores no state and protection is not inherited by files added later.
- Folder UI protection is derived from its current descendants: fully protected or mixed.
- Rename and move operations preserve the protection marker.
- GC reads protection directly from each physical filename. Only that copy is protected; presentation/open-draft references remain hash-wide.
- Protected filenames are included in the cleanup scan fingerprint so a protection change during cleanup aborts the scan rather than racing collection.
- Filename transitions use non-overwriting hard-link publication. An existing destination is accepted only when its bytes match the encoded hash.
- The pre-release `.showme/protected.json` mechanism is no longer authoritative and stale copies are removed during Library initialization.
- Protection state therefore travels with the media through Syncthing, Finder/Explorer copies and folder moves without requiring a sidecar or central metadata file.

Verification additionally covers that a file arriving after a folder-protect operation remains unprotected and collectible until explicitly protected.


## Final package and Trash review

Two final integration issues were fixed without changing the package schema or the collaboration-safe cleanup-protection model.

### Portable packages

Library folders are organization only and are deliberately absent from `.smp` packages.

- Package creation no longer infers media type from the immediate parent directory of a physical Library file.
- The existing semantic `asset.mediaType` determines the package's top-level media directory.
- Nested Library paths such as `images/project-a/reference/photo__<hash>.jpg` are flattened to `images/photo__<hash>.jpg`.
- Protected Library names such as `photo__<hash>~p.jpg` are normalized to the ordinary managed filename inside the package. Cleanup protection belongs to the shared Library and does not travel into `.smp`.
- Package bytes are not rewritten; SHA-256 asset identity remains unchanged.
- No new package schema/version was introduced.

Regression coverage imports an image and video into different nested Library folders, protects the image, packages the presentation, verifies top-level `images/` and `video/` entries and metadata, confirms no nested Library path or `~p` marker is present, verifies the packaged bytes by SHA-256, and reopens the package successfully.

### Trash organization

Folder organization now has one domain-level eligibility rule: a selection is organizationally movable only when every selected entry is a non-Trash entry in the same Library category.

Therefore any selection containing Trash:

- does not expose `Move to Folder…`;
- does not expose `New Folder with Selection…`;
- cannot derive a folder-creation category from Trash metadata;
- keeps the existing single-item Restore and Show in Folder actions.

A deterministic domain regression covers normal, Trash-only and mixed normal/Trash selections.

### Partial protection failures

Bulk folder protection remains a best-effort sequence of safe filename transitions. If an external sync conflict causes a later descendant rename to fail after earlier descendants were already protected:

- successful earlier renames are not rolled back;
- `NativeLibraryBrowser` invalidates its cached inventory and refreshes before rethrowing the error;
- the next Library read immediately reflects the real mixed filesystem state.

Regression coverage prewarms the browser inventory, induces a conflicting `~p` destination after one successful rename, and verifies the immediate mixed folder/file state.

### Final verification

The product/test candidate at `6dbb1f5731b83ee65fef83157aadad3d526d1b2c` was verified through the PR runner. The temporary verification-only workflow commits changed only `.github/workflows/ci.yml`; the product and test tree was unchanged.

Passed:

- `npm run typecheck`
- `npm run lint`
- `npm run test:audit`
- focused `tests/feature/media/library-work.test.ts`
- focused `tests/feature/persistence/package-options.test.ts`
- `npm test`
- mandatory audience-navigation gate with Chromium:
  - `audience stress benchmark renders dense animated slides and reports comparable performance`
  - `a late slide with a new image is prepared during the preceding slide instead of blocking audience navigation`

Both audience-navigation declarations executed and passed. The temporary CI instrumentation was then removed and the repository's standard Development workflow restored.


## Visible Media surface excludes fonts

Fonts remain an internal managed Library resource because ShowMe still needs them for font resolution, portability checks and package/font workflows. They are no longer presented as Media Library items.

- The visible Media type selector no longer contains a Fonts option.
- The unified All view excludes the internal `fonts` category and its folders.
- Font preview/loading UI was removed from the Media Library component.
- The internal `fonts` Library category and storage/indexing contracts remain available to font-specific infrastructure.
- No font storage or package schema was changed.

Regression coverage verifies that an internally managed font is absent from the unified visible Library while a direct internal `fonts` inventory request still sees it.

## Final verification after package, Trash, protection and font-surface fixes

Product/test candidate `ca94c48cb0df48b0940a39777d481e0d594f0bc0` was checked by the PR runner using an explicit checkout of that SHA.

Passed:

- `npm run typecheck`
- `npm run lint`
- `npm run test:stats`
- `git diff --exit-code tests/stats.json`
- `npm run test:audit`
- focused `tests/feature/media/library-work.test.ts`: 14 passed
- focused `tests/feature/persistence/package-options.test.ts`: 4 passed
- `npm test`: 15 passed across 2 core files
- mandatory audience-navigation gate:
  - `audience stress benchmark renders dense animated slides and reports comparable performance`
  - `a late slide with a new image is prepared during the preceding slide instead of blocking audience navigation`

Both audience declarations executed and passed: 2 passed, 0 skipped.

The temporary verification workflow checked out the candidate SHA explicitly and was then restored to the repository's standard Development checks.

## Local UX follow-up — 2026-10-16

These decisions supersede the earlier All-view and desktop multiselection descriptions above:

- Media opens on Images. The type selector offers Images, Video, Audio, Effects, Other and Trash; All has been removed from the UI. Internal inventory APIs remain unchanged.
- The native grid container uses flex layout so the contained virtual list receives a nonzero height. Native tiles override inspector button padding, borders and tinted backgrounds so previews fill each tile.
- Select enters a phone-style selection mode: taps toggle circular checkmarks and update a selected count. Done, Escape or changing category/folder clears the selection. Marquee and modifier-based range selection have been removed.
- Selection mode disables dragging and double-click insertion/folder navigation. Ordinary browsing retains dragging, double-click insertion and folder navigation.
- Move to Folder and New Folder with Selection retain the existing same-category, non-Trash eligibility rule. Rename and item-level Show in Folder have been removed; the Library-level Show Library Folder action remains.
- Managed video tiles capture the first frame through the existing video-poster path with at most two concurrent library captures, instead of depending on a previously stored poster.
- Native effect thumbnails, including content/backdrop samples, are square at 280 × 280. Their derived cache key has changed so rectangular cached thumbnails are not reused. The Effect Editor's existing sample dimensions remain the default.
- No document, package, asset-identity or persistence format was changed. Startup/cache contention was diagnosed separately and is not fixed by these UX changes.

Local verification of the follow-up:

- `$env:SHOWME_TEST_FILES = '["tests/feature/media/library-work.test.ts"]'; npx vitest run tests/feature/media/library-work.test.ts`: 14 passed.
- `npm run typecheck` and `npm run build`: passed.
- Focused ESLint on the three edited TSX components and `electron/main.ts`: no errors; one existing unused `compositionWindow` warning in `electron/main.ts`.
- Temporary Chromium component checks: grid height/scrolling, borderless full-width tiles, keyboard focus, tap toggling, selection count, batch move payloads, Done/Escape, insertion safety and navigation reset passed.
- Temporary isolated Electron checks: Images is the default, All is absent, a generated red video displays a decoded red first frame, and source/content/backdrop shader thumbnails are 280 × 280.
- The audience-navigation gate was not rerun for this local follow-up. This is a task-branch update, not a commit or integration into main; the earlier gate result above applies only to its stated candidate.

## Filesystem authority and concurrent reconciliation — 2026-10-16

The durable Library contract is the physical directory tree, managed SHA-256 filenames, and physical `~p` markers. `LibraryIndex` is a disposable machine-local metadata cache; `NativeLibraryBrowser` is a disposable process-local inventory. Neither cache defines asset identity, document locations, or a compatibility format. Missing, malformed, or replaced caches reconstruct from the filesystem. A startup observation that fails can be attempted again.

### Observation and mutations

- Index and browser builds discard incomplete observations and retry up to three times for disappearing entries (`ENOENT`) or changed generations/directory fingerprints. Directory identity and modification signatures are checked before publication, including moves after a file was statted and before watcher delivery. Known nested-directory disappearance is retried rather than silently publishing an incomplete category.
- Permissions, unsafe symlinks, wrong directory/file structure, and other filesystem failures remain errors. Malformed effect JSON remains visible; its filesystem read failures are distinguished from JSON/schema validation failures.
- A successful physical mutation stays successful if reconciliation fails. Transient exhaustion requests a deferred reconciliation; a nontransient refresh failure is returned as a separate `reconciliationError` and stays visible in the panel. Deferred scans have bounded attempts and do not schedule themselves forever; later watcher/UI/poll hints can retry.
- Browser inventories invalidate after successful and partially failed move, restore, protection and import operations. A failed unlink can leave two physical copies; both appear on the next read. No successful filesystem publication is rolled back by these mutation handlers. Existing GC rollback/fingerprint safety remains intact.
- Single and batch UI actions reload in `finally`, including a first operation with partial physical success. Refresh warnings do not stop subsequent moves. Errors from outdated page requests cannot replace the current generation's state; mutation errors survive successful reloads.

### Protection, names, and immutable media

- Confirmed and removed the GC bug that added protected hashes to the global live set. A `~p` filename now protects just that physical copy. An unprotected duplicate remains collectible; document/open-presentation/draft references still protect every copy by hash. Filename-protection changes still participate in the complete cleanup fingerprint and abort unsafe collection.
- Folder protection remains a bulk rename over current descendants. Later arrivals remain unprotected, moves preserve the marker, partial conflicts expose mixed state, and no shared sidecar or inherited folder policy is introduced.
- Mutation destinations use existing Windows-safe path validation (empty/dot components, separators, illegal/control characters, reserved device names, trailing spaces/periods), including superscript device-number aliases. Creation, rename and move reject sibling spellings that collide after NFC normalization and case folding. Imports apply the same check to organizational folders. Exact existing spellings remain usable; paths are not stored as asset identity.
- Inventory metadata remains deliberately unverified and inexpensive. Managed-looking filenames, renamed/conflicted copies and partial sync payloads never establish trustworthy bytes: insertion/presentation consumption verifies SHA-256 against a physical signature. Malformed/conflicted files remain browsable, and completing a partial payload makes the matching hash available after reconciliation.
- Document `filename` remains display/fallback metadata. Moving into nested folders and changing `~p` preserve the SHA-256 reference. No document, package or synced metadata schema changes. `.smp` still flattens organizational folders into top-level media directories, strips `~p`, and preserves bytes/hashes.

### Regression coverage and follow-ups

`tests/feature/media/library-reconciliation.test.ts` deterministically covers disappearing files during index/browser scans, a two-move batch overlapping an older scan, post-stat relocation before watcher delivery, bounded retries, startup recovery, separate refresh errors, partial move visibility, portable naming/collisions, sync-byte rejection, and reconstruction with malformed/deleted caches. Lifecycle coverage adds duplicate-copy protection versus document references and protection changes at the final cleanup gate. Existing partial-folder-protection and flattened-package tests remain active.

Intentionally deferred: a dedicated sync-conflict inspection/repair UI and remediation for externally created nonportable or normalization-colliding trees. Current boundary errors remain visible; ShowMe does not rewrite external bytes or invent conflict identities. No startup performance project, benchmarks, cache format commitment, or historical-format readers are included.

Final local verification of the complete hardening candidate (no subsequent product/test changes):

- `npm run typecheck`: passed.
- `npm run lint`: passed with zero errors and two pre-existing unused-variable warnings (`compositionWindow` and the unused `setLibraryProtection` import in `library-work.test.ts`).
- `npm run test:stats`: passed; committed composition statistics updated.
- `npm run test:audit`: passed, 443 active declarations in 73 groups.
- `$env:SHOWME_TEST_FILES = '["tests/feature/media/library-reconciliation.test.ts","tests/feature/media/library-work.test.ts","tests/feature/persistence/library-lifecycle.test.ts","tests/feature/persistence/package-options.test.ts"]'; npx vitest run`: 49 passed across four files.
- `npm test`: 15 passed across two core files.
- `npx playwright install chromium`: completed successfully.
- `$env:SHOWME_TEST_FILES = '["tests/feature/presenter/audience-navigation.spec.ts"]'; npx playwright test tests/feature/presenter/audience-navigation.spec.ts`: 2 passed, 0 skipped (55.6s). Both the dense animated rendering stress declaration and late-image advance-preparation declaration executed and passed against the final product/test candidate.
- `git diff --check`: passed.

No full/release suite, build/package, manual Windows/macOS sync exercise, or separate performance benchmark was run for this pass. Presenter gate timings are correctness evidence, not a comparable performance claim. The work stays on PR #11's existing branch; main is not modified or merged.

## Media scrolling follow-up — 2026-10-16

Inventory refresh previously set `total` to zero, unmounting the virtual list and losing its scroll position. The browser now retains the previous scroll extent until the refreshed count arrives; category/folder navigation explicitly remounts the list to start at the top. Page responses merge within the current generation, so a delayed first-page response cannot discard a visible page fetched while the refresh was pending. Selection resets and mutation/error reconciliation keep their existing behavior.

The deterministic browser regression first reproduced the unmounted-list failure, then exposed the page-response ordering race. It now passes while checking scrolling beyond the first page, a pending inventory refresh, visible-page retention after the first page completes, and category navigation resetting to the top.

Verification: `$env:SHOWME_TEST_FILES = '["tests/feature/media/library-scrolling.spec.ts"]'; npx playwright test tests/feature/media/library-scrolling.spec.ts` (1 passed), `npm run typecheck`, focused `npx eslint src/components/NativeMediaLibrary.tsx tests/helpers/nativeMediaLibraryHarness.tsx tests/feature/media/library-scrolling.spec.ts`, and test stats/audit.

Before updating PR #11, the exact final product/test candidate also passed `$env:SHOWME_TEST_FILES = '["tests/feature/media/library-scrolling.spec.ts","tests/feature/presenter/audience-navigation.spec.ts"]'; npx playwright test tests/feature/media/library-scrolling.spec.ts tests/feature/presenter/audience-navigation.spec.ts`: 3 passed, 0 skipped (53.9s), including both mandatory audience declarations. Earlier typecheck, focused lint and stats/audit results apply unchanged. Full/release suites and build/package were not repeated for this localized panel fix.
