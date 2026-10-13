# Image caching V2

## Goal

Make image preparation fast enough that presentation use never depends on waiting for a cache job, while preserving ShowMe's current audience-quality rule: the final audience raster should be prepared for the actual audience display resolution and should not be permanently limited to a generic 1080p cache.

The user workflow to optimize for is ordinary presentation behavior:

1. Open ShowMe.
2. Open a presentation.
3. Connect a projector or external display, possibly after the document is already open.
4. Press Present immediately.
5. The presentation must start even if projector-specific image preparation is still running.

Image caching is an optimization layer. It must not become a startup gate.

## Current architecture and constraints

The current implementation already has several correct ideas that V2 should preserve.

- Audience preparation uses the selected audience display's physical pixel size, `bounds * scaleFactor`.
- `planPresentationImages()` derives per-image sampling requirements from the real deck geometry, media crop, nested scale and Motion scale envelope.
- Prepared audience images are exact-size derivatives. This supports the existing rule that audience assets are scaled once to the required sampling size rather than repeatedly through arbitrary cache tiers.
- Presenter previews reuse audience rasters rather than causing a second presenter-resolution preparation workload.
- The image preparation coordinator prioritizes the current slide and nearby slides and exposes readiness rather than owning presentation playback.
- Unsupported or unavailable prepared images can fall back to the original asset.
- The current desktop cache is PNG-only. Its recipe, validation, file extension, MIME type and retained-cache lookup all assume PNG.
- The processor deliberately preserves alpha, ICC-to-sRGB conversion and high-bit-depth PNG sources. JPEG cannot replace PNG blindly without changing those guarantees.

The current cache therefore solves exact sampling well, but not the "I just connected a projector and need to start now" case as explicitly as it should.

## The actual problem

There are three different concepts that should not be collapsed into one cache state.

### 1. Usable now

Can the audience render this image right now?

A usable source can be, in order of preference:

1. exact cached derivative for the current audience profile,
2. another already-prepared derivative that is good enough as a temporary fallback,
3. a persistent 1080p-class fallback derivative,
4. the original asset.

If none are available, the normal missing-media placeholder is the last resort.

### 2. Exact for this display

Is the image prepared at the exact sampling size required by the current audience display?

Only this state should count as fully "Ready to present" from the image-quality perspective.

### 3. Cached format

Which disposable derivative encoding is preferred?

This is independent from the required pixel dimensions. JPEG versus PNG should not decide presentation readiness or output resolution.

## Proposed V2 model

Use two cache tiers plus the original.

### Tier A: persistent fallback tier

Maintain a low-priority "1080p-class" derivative for presentation images while a document is open and the machine is idle.

Do not literally assume a 1920 x 1080 deck. Define the fallback density from the deck aspect ratio so the shorter deck axis receives roughly 1080 pixels. Examples:

- 16:9 deck: about 1920 x 1080
- 4:3 deck: about 1440 x 1080
- 9:16 deck: about 1080 x 1920

The existing image planner then determines the correct per-image sampling dimensions at that density, including crop and Motion scale.

Preparation order:

1. current slide,
2. next slide,
3. previous slide,
4. remaining visible slides in presentation order during idle time.

This cache is insurance, not final audience quality.

### Tier B: exact audience tier

As soon as ShowMe knows the assigned audience display, prepare the exact audience profile already used today.

Trigger this before the user presses Present when possible:

- when an external display appears,
- when display assignment changes,
- when the selected display resolution or scale factor changes,
- when the document changes in a way that invalidates image requirements.

Priority while not presenting:

1. current slide,
2. next slide,
3. following slides,
4. previous slide,
5. rest of the deck.

Priority while presenting should be stricter:

1. current slide,
2. next slide,
3. next few slides,
4. everything else only when idle.

Exact audience preparation remains the definition of green "Ready".

### Original asset

The original remains the functional fallback for cases where no prepared derivative exists or the image type cannot be prepared.

This path should be uncommon during presentation because decoding a very large original at slide entrance is exactly the workload the cache is intended to avoid.

## Starting a presentation

Presentation start must never wait for exact image preparation.

When Present is pressed:

1. open the audience and presenter windows immediately,
2. render each image from the best already-available source,
3. raise exact current-slide and next-slide preparation to highest priority,
4. continue preparing exact audience derivatives in the background,
5. upgrade future slides to exact derivatives as they become available.

Do not use a blocking modal or a required "finish preparing" step.

A progress bar is useful only as non-blocking status. The existing readiness indicator is the right place. It can become more explicit:

- **Ready**: all currently relevant images are exact for the audience profile.
- **Optimizing images 12/18**: presentation is usable, but some exact derivatives are still being prepared.
- **Image issue**: one or more images have no usable prepared source or preparation failed.

The presenter view may show the same compact readiness state. The audience output should never show preparation UI.

## Upgrading an image during presentation

Avoid a visible quality pop or decode hitch in the middle of an animation.

The current displayed raster should normally stay pinned for the lifetime of the active slide or active Motion interval. When an exact derivative becomes ready:

- use it immediately for slides that have not been entered yet,
- use it on the current slide only at a safe boundary, for example after the current Motion interval or on the next slide re-entry,
- never replace an already-decoded current raster merely because a higher-quality derivative finished a few milliseconds later if that swap can disturb playback.

This keeps background preparation from becoming presentation-time visual churn.

## Projector resolution changes

Do not assume the main screen and projector match.

The audience profile must continue to come from the assigned audience display's physical pixel dimensions. A laptop Retina display, 1080p projector and 4K projector can all require different derivatives.

If a display profile changes after the document is open:

- existing exact derivatives for the old profile remain valid fallback candidates,
- the new exact profile becomes the target immediately,
- presentation remains usable while the new derivatives are prepared,
- readiness changes from Ready to Optimizing, not to a blocking state.

If the new target is lower-resolution than an existing derivative, that larger derivative may be used temporarily, but it should not be considered exact. The final exact derivative should still be generated so the audience path preserves the "scaled once to target sampling size" rule.

## JPEG versus PNG

The cache format should be a user preference because it is a performance/quality trade-off, not a document-format decision.

Recommended settings UI:

**Image cache format**

- **High-quality JPEG (faster)**, recommended default if benchmarks continue to show a meaningful startup/decode advantage.
- **PNG (lossless)**.

Do not expose a JPEG quality slider initially. Pick one fixed, versioned recipe after benchmarking. A sensible starting candidate is high quality with 4:4:4 chroma sampling, but the exact quality value should be chosen from ShowMe's real image corpus rather than by assumption.

The setting describes the preferred derivative format. It must not make invalid JPEGs.

JPEG mode must automatically use PNG when correctness requires it, at minimum for:

- images with alpha/transparency,
- image types or precision paths that the JPEG processor cannot preserve safely.

The current processor explicitly preserves high-bit-depth PNG sources. V2 must decide this policy deliberately. The safe initial policy is to keep high-bit-depth sources on PNG even when JPEG is preferred.

Changing the cache format must not mutate originals or presentation documents. It only changes the cache recipe used for new derivatives.

## Cache identity

Format and encoder settings must be part of the immutable recipe identity.

Conceptually:

`<format>-<quality/encoder>-lanczos3-sdr-v2:<assetId>:<width>x<height>`

This allows JPEG and PNG variants to coexist safely, makes cache hits deterministic and avoids having to destructively "convert the cache" when the user changes settings.

A cache clear should remove all known derivative recipes. Normal cleanup should remain conservative around unknown files.

## Cache reuse rules

For final audience quality:

- exact required width + height + recipe is a ready cache hit,
- do not redefine a larger derivative as exact merely because Chromium can downsample it.

For immediate fallback:

- exact current profile,
- otherwise a prepared derivative at equal or greater sampling dimensions if already available,
- otherwise the 1080p-class fallback tier,
- otherwise another prepared derivative,
- otherwise original.

Fallback selection should avoid upscaling a tiny thumbnail when a full original is available. Thumbnail assets should not enter the audience fallback chain.

## Background work and presentation performance

Background preparation can itself cause dropped frames. V2 should treat "presenting" as a scheduling signal.

Before presentation, use the existing bounded worker concurrency.

During live presentation:

- current and next slide exact jobs have priority,
- reduce background concurrency if needed, initially one image worker is a safer assumption,
- do not precompute the full deck aggressively during an active animation,
- schedule distant-slide work through idle time,
- measure frame timing before increasing concurrency.

JPEG being faster to decode is only useful if generating JPEGs in the background does not steal enough CPU to make Motion, video or effects less smooth.

## Readiness model

The current `checking | preparing | ready | failed` state is too coarse for graceful fallback because "not exact yet" is not the same as "cannot present."

V2 should track at least these counts for the active target profile:

- total requirements,
- exact ready,
- fallback ready,
- original-only,
- unavailable/failed.

Suggested top-level interpretation:

- **ready**: all relevant requirements exact,
- **optimizing**: all relevant requirements usable, some not exact,
- **degraded**: presentation can run, but some images are original-only or failed preparation,
- **failed**: one or more required source assets are unavailable.

This is still image-preparation state. It must not become a second presentation/playback state machine.

## What not to do

- Do not hard-code the audience to 1080p.
- Do not block Present until conversions finish.
- Do not force full-deck exact preparation before first slide.
- Do not generate multiple exact raster sizes merely because the presenter window is resized.
- Do not use thumbnails as audience assets.
- Do not transcode originals in the media library.
- Do not silently flatten transparent PNGs into JPEG.
- Do not let background conversion compete unboundedly with live presentation rendering.
- Do not replace current exact-resolution planning with a generic "one cache image per asset" model.

## Questions to answer with measurements

Before implementation, benchmark these on Windows and macOS with realistic decks:

1. JPEG quality/encoder settings that are visually acceptable for photos, gradients, line art and screenshots.
2. JPEG decode time versus current PNG compression level 3 at 1080p and 4K-class derivatives.
3. JPEG encode time versus PNG encode time.
4. Disk size and retained-cache hit behavior.
5. Whether one worker during presentation is enough to prepare the next slide before navigation.
6. Whether swapping a newly-ready raster while a slide is static is visually safe or should always wait for slide transition.
7. How much opening a document is affected if the 1080p-class fallback tier starts immediately versus only after a short idle delay.

## Suggested implementation phases

### Phase 1: generalize cache recipes

- Generalize `PreparedImage.mime`, file extension, validation and retained-cache lookup.
- Add a preferred cache-format setting.
- Version cache identity by format/encoder recipe.
- Implement JPEG processing with mandatory PNG fallback for alpha and protected precision.
- Keep all current exact audience planning behavior.

### Phase 2: fallback tier

- Add the 1080p-class persistent presentation tier.
- Generate current/next first, remaining slides only at low priority.
- Add lookup for best available fallback without calling it exact.

### Phase 3: non-blocking audience upgrade

- Make "usable" versus "exact" explicit in readiness.
- Start presentation regardless of exact preparation status.
- Prioritize exact current/next jobs when the audience display is known.
- Pin the active displayed raster through unsafe swap periods.

### Phase 4: scheduling and benchmarks

- Throttle preparation during presentation.
- Add startup/decode/encode benchmarks for JPEG versus PNG.
- Tune JPEG quality and concurrency from data.
- Verify 1080p, 4K, mixed-DPI and projector-resolution-change scenarios.

## Acceptance criteria

Image caching V2 is successful when:

- A presentation can start immediately after connecting a projector, even with an empty projector-specific cache.
- The first visible frame uses the best already-available image source rather than waiting on conversion.
- A 4K audience eventually receives exact 4K-class sampling, not a permanently upscaled 1080p cache.
- A lower-resolution projector does not force decoding the original when a suitable prepared fallback already exists.
- JPEG and PNG are user-selectable cache policies without changing originals.
- Transparent images remain correct.
- Prepared image work does not create a second presenter-resolution cache.
- Background preparation does not materially disturb presentation playback.
- Readiness tells the user whether the presentation is exact, merely usable, or missing assets.
- Existing document, asset and presentation-runtime architecture remains unchanged.
