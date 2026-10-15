# Collaboration-safe Library root

Status: implemented on `chatgpt/shared-library-root`; see PR #13. The requirements below remain the product contract.

## Problem

ShowMe's Managed Library can currently be configured independently from the presentations folder that cleanup scans.

That is safe for one user only when the configured presentations folder contains every `.sme` file that can reference the Library. It becomes unsafe with experimental collaboration:

- collaborators can point to the same synced Library;
- each collaborator can configure a different presentations folder;
- one machine can therefore scan an incomplete set of presentations;
- an asset that is still referenced by another collaborator's presentation can appear unused locally and be moved to Library Trash or eventually deleted.

The cleanup algorithm cannot solve this reliably while the Library and its authoritative presentation set are configured as independent roots. The storage model must make an incomplete reference scope impossible in normal use.

## Goal

Define one filesystem boundary for a Managed Library and every presentation that is allowed to depend on it.

Within that boundary:

- the asset Library remains a visible, user-accessible feature;
- users keep control over their own project folder structure;
- presentations can live anywhere below the selected root;
- managed cleanup has one complete, well-defined scope;
- collaborators can use different absolute paths on different computers as long as they sync the same root contents.

The model should stay simple because collaboration is still experimental. It should solve the destructive-cleanup failure mode without introducing a larger workspace, ownership, server, or cloud model.

## Product model

A user selects one **ShowMe root folder** for Managed Library use.

That root contains a normal visible `ShowMe Library/` folder and may otherwise contain any user-defined folder structure.

Example:

```text
Studio Shared/
├── ShowMe Library/
│   ├── Images/
│   ├── Video/
│   ├── Fonts/
│   └── Trash/
├── project-a/
│   └── deck.sme
├── project-b/
│   ├── pitch.sme
│   └── final/
│       └── final-deck.sme
└── overview.sme
```

There is deliberately no required `Presentations/` directory.

A presentation may live directly in the root or at any depth below it. The user's project structure remains the presentation structure.

The `ShowMe Library/` directory is not hidden internal storage. It is part of ShowMe's asset-library feature and should remain directly accessible to users through the filesystem and through ShowMe.

## Core invariant

A Managed Library may automatically classify an asset as unused only when the same selected root contains the complete set of presentations that are allowed to reference that Library.

In practical product terms:

> If a `.sme` presentation uses a Managed Library, that presentation must live somewhere inside the same ShowMe root as that Library.

The absolute root path does not need to match across collaborators.

For example, these may represent the same synced root:

```text
D:\Studio\Shared\
/Users/verena/Studio/Shared/
```

What matters is that both computers sync the same root contents, including the visible `ShowMe Library/` and all presentations that depend on it.

## Required behavior

### Root selection

Managed Library mode uses a single root selection.

The current independent concepts of:

- Media Library folder; and
- Presentations folder

are replaced by the single ShowMe root.

The root defines both:

- the location of the visible `ShowMe Library/`; and
- the complete presentation scope relevant to cleanup.

There must not be a normal configuration in which the Managed Library and cleanup's presentation scope can point at unrelated filesystem locations.

### Presentation placement

Any current-format `.sme` presentation below the selected root may reference that root's Managed Library.

No dedicated presentation directory or naming convention is required.

A presentation outside the selected root must not silently depend on that root's Managed Library while automatic cleanup treats the root as complete. ShowMe must prevent that state or make the presentation portable instead of allowing an unsafe Managed Library dependency.

Portable `.smp` files remain self-contained and are outside this Managed Library ownership rule.

### Library visibility

The Library remains a normal, visible folder under the selected root.

It must continue to be possible for users to:

- inspect Library files in Finder or Explorer;
- open the Library from ShowMe;
- understand that media is stored centrally and shared between presentations;
- review Library Trash.

Files copied into or removed from the Library outside ShowMe update the open Media panel. Startup reconciles the cached inventory with the filesystem so copies made while ShowMe was closed also appear.

The collaboration-safe model must not turn the Library into hidden application data.

### Cleanup scope

Managed cleanup treats the selected root as its complete authority boundary.

It must consider every eligible `.sme` presentation recursively anywhere below that root when determining whether Library assets are live.

Cleanup must not depend on each collaborator separately choosing a second presentations folder.

### Conservative deletion

Cleanup remains fail-safe.

If ShowMe cannot establish a complete view of the selected root, it must not classify unknown assets as unused.

Examples include:

- the root is unavailable;
- part of the tree cannot be read;
- a presentation cannot be parsed sufficiently to determine its asset references;
- the filesystem scan is otherwise incomplete or inconsistent.

An incomplete scan means no destructive cleanup for that scan. Cleanup revalidates the presentation tree immediately before moving assets or expiring Trash. If a later scan check fails, assets moved by that scan are restored without overwriting files that arrived in the meantime. If the filesystem prevents restoration, the payload remains in Library Trash and the error is reported.

Unused assets should continue to enter Library Trash before permanent deletion, preserving the existing retention model rather than deleting files immediately.

### Collaboration

Collaboration does not create a second asset-storage model.

For the experimental collaboration workflow, users are expected to share or sync the same ShowMe root using their existing filesystem-sync solution.

A collaborator can map that shared root to a different absolute path on their own machine. ShowMe must reason about the selected local root boundary, not require identical machine paths.

The important requirement is that the Library and every `.sme` file that can reference it are part of the same synced root.

## Transition from the current storage model

This change intentionally uses a clean cutover rather than a compatibility migration.

The existing user base is small enough that preserving the old independent Library and Presentations settings would add more long-term complexity and risk than value.

### New app release

The new storage model ships as a normal new ShowMe app version.

It does **not** require:

- a new `.sme` document version;
- a new `.smp` package version solely for this change; or
- a new Library asset format.

The change is to ShowMe's application storage configuration and cleanup authority, not to presentation content.

### Forced root setup

After updating, an installation that does not yet have the new ShowMe root configured must not silently infer one from the old settings.

Before normal Managed Library use, ShowMe presents a blocking setup step asking the user to choose the new ShowMe root.

Conceptually:

```text
ShowMe now uses one root folder for presentations and the Media Library.

Choose the folder that contains, or should contain, your Library and all
presentations that use it.

[Choose ShowMe Root…]
```

There is no "continue with old folders" option.

### No automatic filesystem migration

ShowMe must not automatically:

- move presentations;
- move or merge the existing Library;
- choose a common parent directory;
- infer the root from the old Library path;
- infer the root from the old Presentations path; or
- keep using the old paths as fallback locations.

Existing files remain untouched.

If the user's current Library and presentations are already below one common directory, the user selects that directory as the new root.

Example:

```text
Before update:

D:/Studio/
├── ShowMe Library/
└── Presentations/
    ├── project-a.sme
    └── project-b.sme

After update:

Choose ShowMe Root → D:/Studio/
```

No files need to move.

If the existing Library and presentations live in unrelated locations, the user reorganizes them into one root before Managed Library operation can resume.

### No legacy storage mode

The old independent folder configuration is not a supported legacy mode.

Once this change is implemented:

- the product model contains one ShowMe root;
- old independent ShowMe Library/Presentations settings are obsolete;
- old values are not consulted during ordinary operation;
- no adapter is retained to make the previous two-root model behave like the new one.

The old settings may exist in an older settings file, but their presence must not restore the old behavior.

### Cleanup during cutover

Automatic cleanup is disabled until all of the following are true:

1. the user has selected the new ShowMe root;
2. the required visible `ShowMe Library/` exists within that root;
3. ShowMe can perform a complete recursive presentation scan of the root.

If setup is incomplete or the first scan fails, no assets are moved to Library Trash and no old trash is permanently deleted as part of that cleanup attempt.

The transition must prefer retaining unused files over risking removal of referenced files.

## What this should prevent

The model must make the following failure impossible during normal Managed Library use:

1. Konrad and Verena share the same Library.
2. Konrad's ShowMe scans one presentations folder.
3. Verena's ShowMe scans a different presentations folder.
4. Verena has a presentation referencing asset X that Konrad cannot see.
5. Konrad's cleanup concludes asset X is unused and removes it.

With one shared root, asset X can only be eligible for cleanup after a complete scan of the same root that contains the presentation referencing it.

The cutover also prevents an updated installation from accidentally continuing to use the unsafe two-root model simply because old settings remain on disk.

## What this is not

This specification does not introduce:

- separate private and shared Libraries;
- a cloud asset service;
- a database of cross-user asset ownership;
- distributed reference counting;
- mandatory project folders;
- a mandatory `Presentations/` directory;
- a hidden ShowMe workspace containing user media;
- a new collaboration transport;
- an automatic migration system for the old two-folder settings;
- long-term compatibility with the old storage configuration.

Those may be reconsidered if collaboration becomes a larger product area. They are not needed to remove the current cleanup hazard.

## Success criteria

The product model is successful when:

1. A user can choose a project root once and use its visible Library across many presentations.
2. Presentations may be organized freely anywhere below that root.
3. Two collaborators cannot accidentally give cleanup different authoritative presentation scopes while sharing the same Managed Library.
4. Automatic cleanup never deletes or trashes an asset based on a known-incomplete root scan.
5. Existing Library benefits remain intact: centralized assets, deduplication, direct filesystem access, Trash review, and delayed permanent deletion.
6. Portable presentations remain available for cases that should not depend on a Managed Library.
7. An existing installation cannot continue into Managed Library operation after the update without explicitly selecting the new root.
8. Existing presentation and asset files are not modified merely because the app storage model changed.
9. The implementation does not retain the old independent ShowMe Library/Presentations model as a compatibility path.
