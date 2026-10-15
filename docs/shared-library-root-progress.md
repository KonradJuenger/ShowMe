# Shared Library root progress

Task scratchpad for `chatgpt/shared-library-root`.

## Fixed decisions
- One explicit ShowMe root.
- Visible assets live in `<root>/Library/`.
- Every managed `.sme` that may reference that Library must be recursively below the same root.
- No old two-folder compatibility path or automatic filesystem migration.
- Portable `.smp` remains self-contained.
- Cleanup stays fail-closed and must not run until the new root is configured and valid.

## Progress
- Read `AGENTS.md` and `docs/collaboration-safe-library-root.md`.
- Mapped old two-folder assumptions across settings, Electron lifecycle/bootstrap, IPC/preload/platform API, storage UI, displaced-document handling and persistence tests.
- Confirmed existing Library cleanup already protects drafts/imports, rechecks presentation fingerprints, serializes collectors, restores referenced Trash assets and aborts on scan errors.
- Next: replace settings/bootstrap with explicit `showMeRootPath`, move managed asset root to `<root>/Library`, collapse lifecycle scan scope to the ShowMe root, then remove obsolete APIs/UI/tests.
