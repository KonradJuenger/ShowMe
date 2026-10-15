# Media tab refactor scratchpad

Status: active implementation
PR: #11
Branch: `chatgpt/media-library-folders-plan`
Rebased base: `c5240f0a39f9a79be34c88bc243f29142f615066`
Previous branch head retained in Git history: `f205c5f04a0938964077d013dfabf68f9954a390`

## Goal

Refine the Media panel into one calm, content-first library surface while preserving the current ShowMe document and storage architecture.

## Fixed product decisions

- Rebuild this branch on the current `main`; do not restore the obsolete independent Media Library folder setting.
- Keep the current `main` preview language for images and video: borderless content, no card chrome around every item.
- Use one Media panel. Images, video, audio, fonts, effects and other files are filters, not separate top-level tabs.
- Keep management secondary. The default surface is navigation, search/filter and content. Rename, move, reveal, delete and protection live behind item/folder actions.
- Effects use a checkerboard preview background so transparent or spatial effects are legible.
- Insertable media can be dragged from the library to the canvas.
- Folders and individual files can be protected from managed Library garbage collection.
- Folder structure stays native filesystem structure. Protection is Library lifecycle metadata, not presentation/document state.
- Existing applied effects remain document-owned. Editing or deleting the reusable Library copy must not mutate presentations.

## Progress

- [x] Re-inspected PR #11 and current `main`.
- [x] Confirmed the old branch diverged before the shared ShowMe root refactor.
- [x] Chose a clean rebase instead of preserving stale conflict structure.
- [x] Identified the old UI clutter source: category tabs plus always-visible folder/file management controls and bordered cards.
- [ ] Port recursive native folder browsing onto the current ShowMe-root storage model.
- [ ] Port effect thumbnail capture and recoverable effect deletion without changing slide rendering semantics.
- [ ] Replace Media/Effects split with a single filterable Media panel.
- [ ] Preserve borderless media previews and simplify folder/item actions.
- [ ] Add checkerboard effect previews.
- [ ] Verify drag-to-canvas for Library media.
- [ ] Add persistent folder/item GC protection and surface it through secondary actions.
- [ ] Add/update focused tests for nested folders, protection, drag payloads and effect previews.
- [ ] Run available focused verification and review the final PR diff against current `main`.

## Verification log

No verification has been claimed yet. This remote environment does not have a working local checkout, so executable tests will only be reported if an available repository/CI path actually runs them.
