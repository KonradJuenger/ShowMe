# Refined effect renderer implementation plan

Baseline: `1e01b6459fee52122f82521cce7aed9bfccf09a0`, branch `experiment/mixed-effect-compositing`.

The rewrite changes renderer-local planning, scheduling and resource ownership. It retains the current document authority, persisted v1 effects, React element views, isolated text workers and shader compilation. No second editor/runtime/document owner is introduced. The old execution strategy remains an explicit in-memory benchmark control while the refined strategy becomes the normal path after verification.

## Structure and implementation order

1. **Dependency coordinator.** Add a small graph executor with cached dependencies, dirty revisions, shared in-flight resolutions and independent terminal requests. Register existing effect surfaces with a coordinator belonging to their slide root. Compile content/subtree and ordered-backdrop dependencies when structure changes. CSS/text preparation resolves before downstream capture. Avoid recursive repeated flushes and scene-wide barriers.
2. **Pixel source ownership.** Move source creation behind demand. Share identical backdrop inputs within the same scene/target/sampling context through reference-counted leases, including their uploaded input texture. No pixel source exists for DOM-only effects or a stage receiving a GPU texture. Release a fallback source when a GPU route replaces it; recreate it if CSS, bypass or an error requires DOM capture.
3. **GPU/DOM output boundary.** Enable direct handoff in the refined strategy. Keep shader output textures distinct from their optional DOM representation. Copy to DOM only at a visible output or a browser-paint consumer, with revision-based materialization. Check CSS/layout decoration conservatively; retain native capture at real CSS boundaries. Source changes, bypass, context loss and teardown must restore valid representations.
4. **Capture and timing invalidation.** Exclude hidden inputs behind completed shader outputs from retained mirrors, with rebuilds when bypass changes their visibility. Drive video invalidation by decoded-frame callbacks. Compare only consumed clock values for shader/string work where dependency analysis is safe; preserve the full effect API delivered to user code. Cache unchanged output and do not write unused shader clock values into CSS every frame. Preserve conservative observation for arbitrary document CSS.
5. **Resource accounting and limits.** Track owned input/output textures and materialized/mirrored bitmaps. Release leases on route/profile changes and unmount. Constrain GPU allocation through the existing render sampling/warning path using a documented scene-level budget; report degradation explicitly. Do not silently reorder effects, merge distinct backdrop prefixes, or pretend an arbitrary shader can be cropped safely.

## Contracts to verify

- DOM-only CSS/JS has zero pixel captures and zero shader allocations.
- A changing shader clock with static source pixels causes shader work but no new source capture/upload.
- Consecutive shaders use GPU inputs and do not retain nested source mirrors or publish every intermediate canvas.
- A CSS boundary requests the required DOM representation and remains visually equivalent to naive execution.
- Compatible backdrop consumers share capture/upload; different ordered scene prefixes remain distinct.
- Dependency resolution is once per request generation, shares in-flight work, and does not block independent stacks.
- Empty/restored text, custom rules/pseudo-elements, alpha, world geometry, backwards seeks, absent owners, context loss and unmount remain correct.
- Bounded resources and explicit sampling diagnostics replace unbounded allocation; paused/export flushes await the requested dependencies.

## Comparison protocol

Use the same source document/assets, Electron version, 1920×1080 viewport, 125% DPR, profiles, durations and private native asset broker as the existing benchmark. Extend its in-memory backend selector with `refined`. Run baseline/refined comparisons serially with a fresh Vite module graph. Preserve the original raw reports and commit new comparison data separately.

Compare cheap shader depths, alternating CSS/shader depths, fixed-area tiles, overlapping lenses, layered background/video/glass/CSS scenes, DOM-only controls and higher-resolution/texture-heavy cases. Measure terminal publications **and source freshness**, decoded frames, captures/uploads/copies, style reads, CPU submission time, logical canvas/texture allocation and process memory. Keep traces and screenshot/pixel comparisons outside the measured intervals. Repeat representative cases; expand when results expose unresolved limits.

Run effects feature tests and the core suite, then relevant motion/media/presenter checks for integration, typecheck, lint, build, registry stats/audit and native screenshot checks. Release/packaging and a new offscreen shared-texture backend are separate work. Record exact outcomes, limitations and final commit SHA in the comparison report.

## Implementation boundary after the first stress run

Steps 1–4 are implemented in the existing renderer, including demand-driven source leases, GPU output materialization and independent dependency resolution. The stress run exposed an interactive scheduling barrier, so consumers now reuse completed shader inputs while native painting is in flight; explicit flushes resolve the dependency cohort first. CSS/JS clock delivery remains conservative because arbitrary JS access and inherited custom CSS variables are public API.

Step 5 currently provides ownership, teardown and input/output texture accounting alongside benchmark bitmap accounting. A scene-wide memory budget, allocation pool and pixel-source eviction policy are **not implemented**. Hardware per-target sampling limits remain in place. These are merge requirements, not claims about the current prototype. General shared prefix composition across different lens targets and a complete sampled-frame/freshness protocol also remain follow-up work. Identical-target capture sharing does not merge differing ordered backdrops.
