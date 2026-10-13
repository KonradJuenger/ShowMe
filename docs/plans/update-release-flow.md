# Update detection and GitHub release plan

## Goal

Make releases require no manual downloading or re-uploading.

A version change in package.json on main should trigger the existing GitHub Actions binary build, create a GitHub Release only after every required build succeeds, and attach the generated binaries automatically.

ShowMe should compare its installed version with the latest GitHub Release. For the first implementation, Windows should offer a Download update action that opens the matching NSIS installer asset in the user's default browser. ShowMe itself does not download, install, execute, or replace application files.

macOS remains build-and-publish only. The current Mac builds are ad-hoc signed and there is no plan to add an Apple Developer ID.

## Product boundary

- GitHub Actions owns building and publishing release binaries.
- GitHub Releases is the public release source.
- ShowMe only checks release metadata and opens a browser URL.
- The Windows NSIS installer is the normal update target.
- The portable Windows EXE remains a release asset but is not offered as the in-app update.
- macOS in-app update/download behavior is out of scope for this first pass.
- No electron-updater, self-update logic, background installer download, restart/install flow, update channels, or mandatory updates.

## Release model

The version in package.json is the release version and single source of truth.

Normal commits do not publish a release. A change such as 0.1.0 -> 0.1.1 on main triggers the build. The workflow creates v0.1.1 only after all required binaries have built successfully.

Do not use a manually created tag as the release trigger. Creating the release/tag after successful builds avoids leaving a release-looking tag behind when packaging fails.

## Phase 1: evolve the existing build-binaries workflow

Modify .github/workflows/build-binaries.yml instead of duplicating packaging logic.

### Triggers

Keep workflow_dispatch for manual branch testing.

Add an automatic push trigger for main when package.json changes. The workflow must still inspect the version itself, so a package.json edit without a version change publishes nothing.

### Version gate

At workflow start:

1. Read the root package.json version.
2. Verify the root package-lock.json version matches.
3. On automatic push runs, verify the version differs from the previous main revision.
4. Define the release tag as v<version>.
5. Verify a completed release for that version does not already exist.
6. If the version did not change, finish successfully without publishing.

A rerun after a failed build must remain possible. Do not create the tag or Release until the final publish job.

### Build jobs

Keep the current native matrix and current artifact names:

- macOS x64: DMG + ZIP
- macOS arm64: DMG + ZIP
- Windows x64: NSIS installer + portable EXE

Keep the existing npm test, build and verify steps. Each matrix job uploads its files as temporary Actions artifacts for the final publish job.

### Publish job

Add one final job that depends on every matrix build. Only this job needs contents: write.

It should:

1. download all build artifacts;
2. verify every expected file exists;
3. create GitHub Release v<version> targeting the exact triggering main commit;
4. attach all binaries;
5. fail rather than publish a partial release if anything is missing.

Release title: ShowMe <version>.

No latest.yml or updater metadata is needed because the application will only link to browser downloads.

### Manual branch runs

A workflow_dispatch run from a feature branch is a build test only. It runs the same packaging and uploads temporary Actions artifacts, but creates no tag and no GitHub Release. This is the safe validation path before merge.

## Phase 2: Electron update service

Update checking belongs in the Electron main process, not directly in the renderer. Keep it isolated, for example in electron/updateService.ts, instead of growing electron/main.ts.

Use app.getVersion() as the installed version. Do not duplicate the app version in renderer constants.

Suggested state model:

- idle: currentVersion
- checking: currentVersion
- current: currentVersion + latestVersion
- available: currentVersion + latestVersion + downloadUrl + releaseUrl
- unavailable: currentVersion

Network failure must never become an editor failure or block startup.

## Phase 3: GitHub Release detection

For packaged Windows builds, request:

https://api.github.com/repos/KonradJuenger/ShowMe/releases/latest

Read tag_name, html_url and assets. Normalize v0.1.1 to 0.1.1 and compare with app.getVersion().

Keep version parsing strict and small. ShowMe controls both sides, so numeric major.minor.patch is enough for the first implementation.

### Windows asset selection

For Windows x64 select exactly:

ShowMe-<version>-windows-x64-setup.exe

Never substitute the portable EXE. If a newer release exists but the expected installer is missing, fall back to opening the release page rather than guessing another binary.

### Check frequency

- Check once per app launch, asynchronously after the editor is usable.
- Add a manual Check for updates action.
- Do not poll continuously.
- Fail silently when GitHub is unavailable.

## Phase 4: typed IPC boundary

Expose update behavior through the existing typed platform/IPC layer.

Renderer operations should be equivalent to:

- getUpdateStatus()
- checkForUpdates()
- openUpdateDownload()

Do not add a generic renderer-controlled shell.openExternal API.

openUpdateDownload() should use only the URL previously resolved by the update service. Before shell.openExternal, require HTTPS, the expected GitHub host, and the KonradJuenger/ShowMe release path.

The browser is the download boundary.

## Phase 5: minimal UI

Put update controls in the existing App Settings dialog, not the editor-specific snapping/view settings.

Normal state:

Updates
Version 0.1.0
Up to date
[Check for updates]

Available state:

Updates
Version 0.1.0
Version 0.1.1 is available
[Download update]

Download update calls openUpdateDownload(). The default browser opens the exact GitHub installer asset and handles the normal download.

Do not interrupt startup with a modal dialog. For the first implementation, availability can simply be visible when App Settings is opened. A more prominent notification can be added later if needed.

## Phase 6: README

Replace the current statement that binaries only live as 30-day Actions artifacts.

Document briefly that:

- a version change on main creates a GitHub Release automatically;
- GitHub Release assets are persistent downloads;
- manual branch workflow runs are test builds only;
- Windows builds are unsigned;
- Mac builds are ad-hoc signed and not notarized;
- Windows ShowMe can detect a newer release and open the installer download in the browser;
- installation remains manual.

## Tests

Keep tests deterministic. Do not depend on live GitHub network access.

Update service tests:

- same version -> current
- newer release -> available
- older release -> current
- malformed tag -> unavailable
- missing setup asset -> release-page fallback
- asset selection never chooses the portable EXE
- invalid/non-GitHub download URLs are rejected

IPC tests:

- renderer receives the typed update state
- renderer cannot supply an arbitrary external URL
- opening an update uses only a validated URL

Workflow validation before merge:

1. Run build-binaries.yml manually from this implementation branch.
2. Confirm all existing platform binaries build.
3. Confirm no tag or Release is created from the branch.
4. Confirm produced filenames match the update-service asset matcher.

## Rollout

1. Implement the workflow changes with manual branch mode.
2. Run the workflow from the branch and verify all artifacts.
3. Implement update detection and typed IPC.
4. Add the App Settings UI.
5. Run targeted tests and build verification.
6. Merge only after review.
7. Make one deliberate version bump on main to exercise the first real automatic Release.
8. Install that Windows build.
9. On a later version bump, verify the installed build detects the newer Release and opens the correct installer download.

## Acceptance criteria

- Changing the version on main is sufficient to publish a full GitHub Release.
- No human downloads or re-uploads binaries during release.
- A normal commit with no version change publishes nothing.
- A manual feature-branch build publishes no Release.
- A Release is created only after all required binaries succeed.
- Installed Windows ShowMe compares its own version with the latest GitHub Release.
- When a newer version exists, App Settings offers Download update.
- Download update opens the exact Windows x64 setup asset in the default browser.
- Update-network failure never blocks or breaks the editor.
- ShowMe never downloads, executes, replaces, or self-updates application files.