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
- Folders and individual cleanup-managed assets can be protected persistently from Library garbage collection. Folder protection applies to descendants and follows rename/move operations.
- Protection is Library lifecycle metadata under the ShowMe Library, not presentation state. It participates in the cleanup fingerprint to prevent races with a running scan.
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
- [x] Added persistent item/folder garbage-collection protection.
- [x] Added regression coverage for unified browsing/inherited protection and collector-level protection.
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
- GC reads protection directly from the filename and treats protected asset hashes as live.
- Protected filenames are included in the cleanup scan fingerprint so a protection change during cleanup aborts the scan rather than racing collection.
- Filename transitions use non-overwriting hard-link publication. An existing destination is accepted only when its bytes match the encoded hash.
- The pre-release `.showme/protected.json` mechanism is no longer authoritative and stale copies are removed during Library initialization.
- Protection state therefore travels with the media through Syncthing, Finder/Explorer copies and folder moves without requiring a sidecar or central metadata file.

Verification additionally covers that a file arriving after a folder-protect operation remains unprotected and collectible until explicitly protected.
