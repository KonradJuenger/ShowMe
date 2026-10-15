# Collaboration-safe Library root

Status: product specification, no implementation plan yet.

## Problem

ShowMe's Managed Library can currently be configured independently from the presentations folder that cleanup scans.

That is safe for one user only when the configured presentations folder contains every `.sme` file that can reference the Library. It becomes unsafe with experimental collaboration:

- collaborators can point to the same synced Library;
- each collaborator can configure a different presentations folder;
- one machine can therefore scan an incomplete set of presentations;
- an asset that is still referenced by another collaborator's presentation can appear unused locally and be moved to Library Trash or eventually deleted.

The cleanup algorithm cannot solve this reliably while the Library and its authoritative presentation set are configured as independent roots. The storage model must make an incomplete reference scope impossible in normal use.

## Goal

Define one shared filesystem boundary for a Managed Library and every presentation that is allowed to depend on it.

Within that boundary:

- the asset Library remains a visible, user-accessible feature;
- users keep control over their own project folder structure;
- presentations can live anywhere below the selected root;
- managed cleanup has one complete, well-defined scope;
- collaborators can use different absolute paths on different computers as long as they sync the same root contents.

The model should stay simple because collaboration is still experimental. It should solve the destructive-cleanup failure mode without introducing a larger workspace, ownership, server, or cloud model.

## Product model

A user selects one **ShowMe root folder** for Managed Library use.

That root contains a normal visible `Library/` folder and may otherwise contain any user-defined folder structure.

Example:

```text
Studio Shared/
├── Library/
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

The `Library/` directory is not hidden internal storage. It is part of ShowMe's asset-library feature and should remain directly accessible to users through the filesystem and through ShowMe.

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

What matters is that both computers sync the same root contents, including the visible `Library/` and all presentations that depend on it.

## Required behavior

### Root selection

Managed Library mode uses a single root selection rather than independently selecting:

- a Media Library folder; and
- a Presentations folder.

The root defines both the Library location and the presentation scope relevant to cleanup.

### Presentation placement

Any current-format `.sme` presentation below the selected root may reference that root's Managed Library.

No dedicated presentation directory or naming convention is required.

A presentation outside the selected root must not silently depend on that root's Managed Library while still participating in automatic cleanup. ShowMe must make that state impossible or explicitly unsafe rather than allowing cleanup to proceed as if the reference scope were complete.

Portable `.smp` files remain self-contained and are outside this Managed Library ownership rule.

### Library visibility

The Library remains a normal, visible folder under the selected root.

It must continue to be possible for users to:

- inspect Library files in Finder or Explorer;
- open the Library from ShowMe;
- understand that media is stored centrally and shared between presentations;
- review Library Trash.

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

An incomplete scan means no destructive cleanup for that scan.

Unused assets should continue to enter Library Trash before permanent deletion, preserving the existing retention model rather than deleting files immediately.

### Collaboration

Collaboration does not create a second asset-storage model.

For the experimental collaboration workflow, users are expected to share/sync the same ShowMe root using their existing filesystem-sync solution.

A collaborator can map that shared root to a different absolute path on their own machine. ShowMe must reason about the selected local root boundary, not require identical machine paths.

The important requirement is that the Library and every `.sme` file that can reference it are part of the same synced root.

## What this should prevent

The model must make the following failure impossible during normal Managed Library use:

1. Konrad and Verena share the same Library.
2. Konrad's ShowMe scans one presentations folder.
3. Verena's ShowMe scans a different presentations folder.
4. Verena has a presentation referencing asset X that Konrad cannot see.
5. Konrad's cleanup concludes asset X is unused and removes it.

With one shared root, asset X can only be eligible for cleanup after a complete scan of the same root that contains the presentation referencing it.

## What this is not

This specification does not introduce:

- separate private and shared Libraries;
- a cloud asset service;
- a database of cross-user asset ownership;
- distributed reference counting;
- mandatory project folders;
- a mandatory `Presentations/` directory;
- a hidden ShowMe workspace containing user media;
- a new collaboration transport.

Those may be reconsidered if collaboration becomes a larger product area. They are not needed to remove the current cleanup hazard.

## Success criteria

The product model is successful when:

1. A user can choose a shared project root once and use its visible Library across many presentations.
2. Presentations may be organized freely anywhere below that root.
3. Two collaborators cannot accidentally give cleanup different authoritative presentation scopes while sharing the same Managed Library.
4. Automatic cleanup never deletes or trashes an asset based on a known-incomplete root scan.
5. Existing Library benefits remain intact: centralized assets, deduplication, direct filesystem access, Trash review, and delayed permanent deletion.
6. Portable presentations remain available for cases that should not depend on a Managed Library.
