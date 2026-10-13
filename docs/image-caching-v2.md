# Image caching V2

## Goal

Keep the existing image-cache architecture and make its target resolution explicit and predictable for presentation use.

This is deliberately a small change. V2 should not redesign the cache format, storage model, renderer, or image-processing pipeline.

The user workflow to optimize for is:

1. Open ShowMe.
2. Open a presentation.
3. Attach or assign a projector.
4. Press Present.
5. If the configured cache target does not match the projector, ShowMe explains that clearly.
6. If required images are still being prepared, ShowMe waits briefly and shows progress.
7. The user can always choose **Continue anyway** and accept the possibility of a decode/raster hitch during the presentation.

## Preserve the current implementation

The existing implementation already does the important work correctly:

- `planPresentationImages()` calculates required sampling from deck geometry, crop, nested scale and Motion scale.
- Prepared images are generated once at the requested sampling size.
- The audience renderer can fall back to the original asset when a prepared image is unavailable.
- Presenter previews reuse audience preparation instead of generating a second presenter-resolution cache.
- The image coordinator already exposes progress and prioritizes relevant slides.
- The desktop cache is PNG-only and has a complete recipe, validation, retained-cache and cleanup path.
- The processor already handles alpha, colour conversion and high-bit-depth PNG correctly.

V2 should build on this rather than generalizing it.

## Cache target setting

Add one setting:

**Image cache target**

- **Screen**
- **1080p**
- **4K**

The setting controls the output profile passed into the existing image planner.

### Screen

Use the assigned audience display's physical pixel size:

`bounds × scaleFactor`

This is the existing exact-screen behavior.

If the audience display changes, the target changes with it and ShowMe prepares the newly required variants.

### 1080p

Use Full-HD-equivalent density while preserving deck aspect ratio.

Examples:

- 16:9 deck: approximately 1920 × 1080
- 4:3 deck: approximately 1440 × 1080
- 9:16 deck: approximately 1080 × 1920

### 4K

Use UHD-equivalent density while preserving deck aspect ratio.

For a 16:9 deck this is approximately 3840 × 2160.

The target is a deck output profile, not a fixed image size. The existing planner still calculates the actual required dimensions for every image instance.

## Preparation while editing

The selected cache target should be prepared in the background using the existing image-preparation coordinator.

Keep the current bounded worker model.

Priority should remain simple:

1. current slide,
2. next slide,
3. previous slide,
4. remaining visible slides.

Do not add multiple deliberately maintained resolution tiers.

If the target changes, previously generated cache files can remain on disk according to the existing cache lifecycle, but V2 does not need new logic to search across old targets or manage them as fallback tiers.

## Projector mismatch

When the user presses Present, compare the assigned audience display with the configured cache target.

### Screen selected

There is no conceptual mismatch. The screen is the target.

If the projector was attached recently and preparation for that screen is incomplete, go directly to the preparation dialog described below.

### 1080p or 4K selected

If the assigned audience display materially differs from the configured target, show a modal before starting the presentation.

Example:

> **Projector resolution differs**
>
> Projector: 3840 × 2160
>
> Image cache target: 1920 × 1080
>
> Preparing images for the projector resolution may reduce the chance of stutter.

Actions:

- **Use projector resolution**
- **Keep 1080p**

If the user chooses **Use projector resolution**:

- change the cache target to **Screen**,
- remember the setting,
- start/reprioritize preparation for the assigned audience display,
- show the preparation dialog until ready or the user chooses **Continue anyway**.

If the user chooses **Keep 1080p**:

- keep the configured target,
- use the existing 1080p preparation,
- continue to the normal presentation-start readiness check.

The same behavior applies in reverse, for example a 4K cache target with a 1080p projector.

Small platform rounding differences should not trigger the warning. Compare effective output density with a small tolerance rather than requiring exact integer equality.

## Presentation preparation dialog

It is acceptable to block presentation startup briefly while required target images are being prepared.

When Present is pressed and preparation is incomplete, show a modal progress dialog.

Example:

> **Preparing images**
>
> 14 of 18 ready for 3840 × 2160
>
> Preparing images reduces the chance of stutter during the presentation.

Primary behavior:

- preparation continues in the background,
- the progress indicator updates from the existing readiness state,
- when preparation reaches ready, start the presentation automatically.

The dialog must also provide:

**Continue anyway**

Choosing it starts the presentation immediately using the current renderer behavior. Any image without a prepared derivative can fall back to its original asset. This may cause a decode or raster hitch when that image first appears.

This gives the common case a clean preflight without trapping the user when they need to start immediately.

There is no need for a separate "optimizing" presentation mode or a new playback state machine.

## Starting the presentation

Normal path:

1. resolve the active cache target,
2. detect projector mismatch if applicable,
3. start/reprioritize preparation for that target,
4. if ready, start immediately,
5. if not ready, show preparation progress,
6. start automatically when ready,
7. or start immediately when the user clicks **Continue anyway**.

Once presentation has started, do not add complex live resolution-upgrade behavior in V2.

If the user continued early, let the existing cache preparation continue where safe, but correctness must rely on the current original-image fallback rather than introducing a new in-presentation raster replacement system.

## Readiness

Reuse the existing `checking | preparing | ready | failed` readiness model where possible.

For V2, that is sufficient.

The preparation dialog needs only:

- target resolution,
- completed requirements,
- total requirements,
- failures if any.

Do not introduce a larger readiness taxonomy unless implementation proves it necessary.

Suggested UI:

- **Ready to present**
- **Preparing images · 14/18**
- **Image preparation failed · 2 images**

If preparation fails, the dialog should explain that ShowMe can still continue using originals where available and provide:

- **Retry**
- **Continue anyway**
- **Cancel**

## JPEG versus PNG

Do not change the cache file format in Image caching V2.

The current PNG pipeline is already implemented, validated and integrated with:

- immutable recipe identity,
- file validation,
- retained-cache lookup,
- cache cleanup,
- alpha,
- colour conversion,
- high-bit-depth handling,
- browser and Electron behavior.

Changing this to support JPEG would expand the scope substantially and is not required to solve the projector/startup problem.

The observation that high-quality JPEG may load or decode faster is still useful, but it should be treated as a separate optimization experiment after V2 works.

If later measurements show a large real-world benefit, JPEG support can be designed independently without coupling it to cache-target selection.

## Settings UI

Keep it small.

Under **Image cache**:

**Cache target**

[ Screen ▼ ]

Options:

- Screen
- 1080p
- 4K

Keep the existing:

- Enable image caching
- Delete image cache on close
- Delete image cache
- Cache folder

Do not add format, quality, fallback-tier or advanced-performance settings in V2.

## What not to change

- Do not change the current PNG cache format.
- Do not generalize `PreparedImage.mime`.
- Do not introduce JPEG recipes.
- Do not create multiple maintained cache-resolution tiers.
- Do not create presenter-specific image variants.
- Do not change the document format.
- Do not change media-library originals.
- Do not change the presentation runtime state machine.
- Do not replace the current image planner.
- Do not require the projector resolution to match the cache target.
- Do not prevent the user from continuing when preparation is incomplete.

## Suggested implementation

### Phase 1: cache target setting

- Add persisted `Screen | 1080p | 4K` image-cache target.
- Convert the selected target into the existing `ImageOutputProfile`.
- Make the image-preparation coordinator use that profile.
- Preserve the current exact planner and PNG processor unchanged.

### Phase 2: presentation preflight

- On Present, resolve the assigned audience display.
- Compare fixed 1080p/4K targets against the audience display.
- Add the mismatch modal.
- **Use projector resolution** switches the target to Screen.
- **Keep current target** leaves the target unchanged.

### Phase 3: preparation dialog

- If image readiness is not ready, show a blocking preparation dialog.
- Display existing completed/total progress.
- Start automatically when ready.
- Add **Continue anyway**.
- Add Retry/Cancel behavior for failed preparation.

### Phase 4: verification

Test at minimum:

- Screen target with no external display.
- Screen target, then attach a 1080p projector.
- Screen target, then attach a 4K projector.
- 1080p target + 1080p projector.
- 1080p target + 4K projector, keep 1080p.
- 1080p target + 4K projector, switch to Screen.
- 4K target + 1080p projector.
- Press Continue anyway while preparation is incomplete.
- Failed preparation with original-image fallback.
- Presenter preview still reuses the audience cache and does not create another resolution tier.

## Acceptance criteria

Image caching V2 is complete when:

- Settings contains Screen / 1080p / 4K cache targets.
- Changing the target causes the existing cache system to prepare the selected output profile.
- The PNG cache pipeline itself remains unchanged.
- A projector with materially different resolution produces a clear mismatch dialog for fixed targets.
- The user can switch to projector resolution directly from that dialog.
- Presentation startup waits for preparation by default.
- Preparation progress is visible.
- Presentation starts automatically when preparation completes.
- **Continue anyway** always allows immediate start.
- Continuing early uses existing original-image fallback rather than a new raster subsystem.
- Presenter preview does not create a second cache target.
- No document-format or presentation-runtime changes are introduced.
