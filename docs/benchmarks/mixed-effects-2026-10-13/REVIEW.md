# Renderer review and focused cleanup

The 16-video decoder-drop regression is isolated to the decoded-callback route on this Windows/Electron configuration. Refined capture now defaults to polling. Ordinary video → CSS → shader composition remains supported. The branch is still a draft because overload responsiveness, memory budgets and complete frame-coherence validation remain unfinished.

No document or application version bump is needed: current v1 schemas/readers/writers, `.sme`/`.smp`, recovery, transfer, collaboration, DocumentAuthority and package version `0.1.0` are unchanged. Integration would change rendering and enable Electron's native capture feature, not the persisted format. Main has not been modified.

## Correctness and ownership fixes

- Removed/replaced graph consumers cannot execute after their awaited dependency completes. Changed dependency edges invalidate settled consumers; replanning during pending work defers the consumer until its new input is ready.
- Logical viewport dimensions and world transforms participate in the capture cache, including its early-out. A completed capture for an earlier sampling size cannot mark a different profile's source prepared.
- Failed captures retain dirty state for a later retry; disposed sources ignore late invalidation. Native mirror images await decode and use the original's selected `currentSrc`, with responsive/lazy image attributes stripped from mirrors.
- Partial framebuffer/texture allocation failures release whichever allocation succeeded.
- Same-size media staging canvases and the shared drawing buffer retain their backing stores. Media copies still clear before drawing, preserving transparent pixels.
- Text-node topology changes rebuild mirrors. A structure revision prevents a rebuild with identical combined text/style strings from reusing the preceding layout.
- A native bitmap needs the extra priming paint only after pixels were written. CSS-only changes around an unchanged committed bitmap use one paint; fresh-versus-retained pixel checks protect this case.

Sources are still renderer-local snapshots. No second document authority, worker execution path, persistence path or historical compatibility layer was added.

## Video isolation

Every row below represents three serial five-second trials with the same 16-video fixture. The first phase changed only a source-created runtime switch between callbacks and polling; all other refined behavior stayed identical. It ran HEAD `6b5603f` with the switch later committed as `5f90486`. Post-fix comparisons ran `8b42554`. The Chromium/compositor mechanism behind the callback regression has not been established; the matched routing experiment establishes its practical relevance here.

| Phase / route | Publication fps, median | rAF fps, median | Timer p95, median ms | Reported video drops, range |
| --- | ---: | ---: | ---: | ---: |
| Initial naive | 5.33 | 16.38 | 111.8 | 0–1.09% |
| Initial refined decoded | 6.30 | 18.89 | 84.7 | 44.23–48.11% |
| Initial refined poll | 5.55 | 16.64 | 107.1 | 0–1.02% |
| Post-fix naive | 5.69 | 17.27 | 114.1 | 0–1.69% |
| Post-fix refined decoded | 5.95 | 18.05 | 89.5 | 48.28–51.16% |
| Post-fix refined poll | 5.06 | 15.38 | 111.3 | 0–1.07% |

Higher callback publication rates coexist with markedly worse decoder drops. Polling restores decoder behavior close to naive; it does not resolve the five-fps composition limit or roughly 100 ms timer latency of this workload.

## Realistic fixtures

At `524c315`, all three unchanged source slides and a two-small-panel derivative ran in both strategies, three five-second trials each. Each small panel occupies 30% × 25% = 7.5% of slide area. They do not overlap and have no enclosing whole-scene CSS/shader groups. The derivative retains the stress procedural background, image, video, JS text and glass/CSS panels, so it is still more demanding than a plain static-background glass slide.

| Fixture | Naive / refined median publication fps | Naive / refined median rAF fps | Naive / refined median timer p95 ms |
| --- | ---: | ---: | ---: |
| Source slide 1 | 59.86 / 60.07 | 59.86 / 60.07 | 0.4 / 0.8 |
| Source slide 2 | 43.30 / 30.13 | 60.06 / 60.06 | 9.9 / 8.7 |
| Source slide 3 | 29.62 / 29.50 | 59.44 / 59.41 | 5.2 / 4.8 |
| Two small panels | 9.36 / 14.48 | 47.56 / 43.83 | 18.6 / 35.9 |

All reported zero video drops and unchanged documents with settled effects. Slide 2's lower publication count is recorded, not hidden; publication includes redundant/clock-only draws, so unique visible change/freshness must be checked before assigning a visual regression. The panels demonstrate that higher composition throughput can still mean worse responsiveness. Both strategies own 43.57 MiB of canvas bitmaps there; refined also owns input/output textures.

## Assessment of the suggested raster optimizations

| Suggestion | Review and disposition |
| --- | --- |
| Separate reads/writes | Relevant; refined defaults to batched style/pseudo/geometry reads. Live computed declarations are copied into primitive values before writes. An interleaved benchmark control remains. |
| Cache property filtering | Implemented once per refined source. Standard declarations remain explicit; custom variables, animation and transition properties retain the existing exclusion policy. |
| Remove large JSON snapshot | Implemented as an exact shallow comparison of the same primitive paint inputs, including normalized clone styles, text, bitmap revision/layout, image readiness, transform, viewport, fonts and structure revision. A dirty flag alone would lose correctness. |
| Debounce MutationObserver | Not adopted. It already calls `markDirty` once per delivered batch, not once per record; scheduled draws coalesce. Deferring semantic invalidation to rAF could let paused/export flushes miss changes. |
| Dirty-node style tracking / declaration deltas | Deferred. Inheritance, selector dependencies, arbitrary rules and browser paint context require broader invalidation evidence; a shadow-root backend is a separate experiment. |
| Gate pseudo reads | Deferred. A stylesheet-string scan does not establish safety for imports, inaccessible/adopted sheets or CSSOM changes. |
| Output-sized media copies | Relevant but deferred. Source resolution, world transforms, object-fit/position and arbitrary shaders need validated sampling bounds. Same-size allocation reuse is implemented. |
| Prime only changed bitmaps | Implemented and checked against freshly captured pixels after CSS-only changes. |
| Shared observers/rAF and cached dynamic state | Deferred pending measured attribution. Hidden noncontributing videos no longer force polling. CSS animation scanning remains conservative. |
| Set node attributes once | Implemented during mirror construction. |
| Add containment | Deferred; can change percentage sizing, containing blocks and browser-paint semantics. |
| Re-arm failures | Dirty state is retained after rejection. No automatic unbounded retry loop was added. |
| Skip hidden windows | Not adopted as a blanket rule; hidden/paused export still needs a deterministic complete capture. Hidden-window recovery remains a runtime check to add. |
| Await clone image readiness | Implemented for native mirrors, including selected image candidate. |
| Mixed text topology | Implemented without rebuilding for ordinary same-topology string changes. |
| SVG/MathML children | The generic capture walker still omits these. No persisted DOM/SVG content model was added; check actual supported slide contributors before extending it. |
| Source root replacement | Renderer sources have a root fixed for the owning surface lifetime and are disposed/recreated with that surface. Root replacement within one source is not a new supported contract. |
| Transform early-out / same-size clear | Transform early-out fixed. `resizeRasterCanvas` already avoids same-size resets. |

Same-build isolation at `fab1681` uses polling throughout and changes only batched versus interleaved reads. Property caching, one-time attributes and correctness fixes are shared by both routes, so this does not isolate their individual gains.

| Fixture / metric | Interleaved median | Batched median |
| --- | ---: | ---: |
| Small panels: refresh ms/capture | 6.67 | 6.31 |
| Small panels: publication fps (range) | 17.34 (17.31–17.36) | 17.70 (16.73–17.97) |
| Small panels: timer p95 ms | 24.8 | 24.1 |
| 16 videos: refresh ms/capture | 29.68 | 27.14 |
| 16 videos: publication fps (range) | 6.36 (5.94–6.58) | 7.24 (6.16–7.49) |
| 16 videos: rAF fps | 19.27 | 21.91 |
| 16 videos: timer p95 ms | 128.2 | 110.8 |

Panel throughput ranges overlap; the change is modest and timing remains variable. Batched video drops range 0.15–0.72%, versus 0–1.15% interleaved. Refresh timing includes serialization, mirror updates and media copying, not exclusive layout time. No forced-layout count or GPU execution timing was measured.

The small-panel source still copies roughly 2.8–3.0 GiB of logical RGBA media pixels per five-second trial. These are copy-work estimates, not additional live memory. This supports pursuing contributing bounds and media sampling, not claiming the entire capture problem is solved.

`videoSampleAgeMs / videoSamples` measures copied-video age at capture completion (about 36–38 ms for panels and 121–136 ms for batched 16-video trials). It omits decode-to-copy age, unchanged retained frames, later shader/DOM publication and visible presentation. It is not an end-to-end freshness/coherence proof. Current-time revisions are not decoded-frame identities.

## Evidence, verification and remaining boundaries

[review-results.json](review-results.json) preserves separate implementation phases, per-trial responsiveness, decoder drops, capture/upload/copy work, logical allocations, process-memory snapshots and settled diagnostics. Raw samples remain under ignored `test-results-effects-stress`. The earlier [REPORT.md](REPORT.md) and its results remain historical evidence.

Final cleanup at `d71a31f` ran 15 additional trials, bringing the review to **69 successful timed trials** across five implementation phases. Small panels reached median 17.54 fps refined versus 9.59 naive, 52.43 versus 48.53 rAF fps, and 24.3 versus 18.3 ms timer p95. The final 16-video case reached median 7.27 versus 5.71 publication fps, with drop ranges 0–1.15% versus 0.12–0.60%. Its refined timer p95 median was still worse (120.7 versus 113.9 ms), and the three-trial range was wide. Static inputs behind eight shaders remained 60.04–60.05 fps with zero new captures, uploads and capture-source style reads. No renderer modules were edited during timed measurements.

Exact verification commands:

- `npx playwright install chromium`: completed before browser checks.
- `npm run test:feature -- effects` with `SHOWME_TEST_PORT=5174`: final **85 unit + 37 browser passed**. Earlier targeted `SHOWME_TEST_FILES='["tests/feature/effects/mixed-compositing.spec.ts"]' npx playwright test --config playwright.config.ts` runs passed as parity/recovery/mirror contracts were added; the final area run covers them all.
- `npm test`: **15 passed** after final production cleanup.
- `npm run typecheck`, `npm run lint`, `npm run build`: **passed** after final production cleanup.
- `npm run test:stats`, `npm run test:audit`: **passed**, 363 declarations / 69 groups, with registry reasons updated.
- `npm run test:feature -- motion`: **34 unit + 12 browser passed**; `npm run test:feature -- media`: **30 unit + 8 browser + 1 Electron passed**; `npm run test:feature -- presenter`: **15 unit + 8 browser + 1 Electron passed**. These ran after batching, before final local priming/topology/primitive-cache cleanup; they were not rerun after that cleanup.
- `node scripts/stress-effects.mjs SOURCE video-isolation 5000 3`: **9/9 successful**, first at baseline plus the isolated toggle, then **9/9** after polling/lifetime fixes. The initial raw report was preserved before repetition.
- `node scripts/stress-effects.mjs SOURCE realistic 5000 3`: **24/24 successful** at `524c315`.
- `node scripts/stress-effects.mjs SOURCE raster-isolation 5000 3`: **12/12 successful** at `fab1681`.
- `node scripts/stress-effects.mjs SOURCE review-smoke 5000 3`: **15/15 successful** at `d71a31f` after final production cleanup.
- `node scripts/verify-effect-alignment.mjs SOURCE`: **12 comparisons completed** after batching, before final local mirror/cache cleanup; [review-alignment.json](review-alignment.json) preserves position parity and the unresolved fractional text difference. This is an identity/original geometry fixture, not mixed-effect export verification.
- `git diff --check`: passed during cleanup; original SHA-256 remains `2867d55e2739782c0f496365779f72c3268e2d35bd8914bb4430b642b29501fd`.

`SOURCE` in these commands is the read-only `D:\01_Projekte\06_presentations\showme-examples\css_js_shader.sme`. Benchmarks used Vite on 5173 and the production Electron build/native asset broker. The retained harness bootstrap warnings appeared in older browser fixtures; assertions passed. Browser suites, benchmarks and alignment ran serially; no timed trial overlapped tests/builds.

Outstanding: scene-level frame/work/memory budgets; contributor pruning and safe media sampling; texture lifetime pooling and broader compiled GPU runs; complete sampled-frame/source freshness; arbitrary CSS/blend/mask/clip correctness; fractional text fidelity; hidden-window capture and longer seek/profile/teardown soaks. Extended/full/release/packaged, macOS, mixed-effect export and long-soak checks are still unrun. Keep PR #4 in draft.
