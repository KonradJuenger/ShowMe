# Handoff: mixed-effect renderer after review

Work stays on `experiment/mixed-effect-compositing`. [PR #4](https://github.com/KonradJuenger/ShowMe/pull/4) stays draft; do not merge into main. The detailed current evidence is [REVIEW.md](REVIEW.md), [review-results.json](review-results.json) and [review-alignment.json](review-alignment.json). [REPORT.md](REPORT.md) preserves the earlier refined baseline, including its now-isolated video regression.

## Current outcome

Ordinary video → CSS → shader composition is supported. The renderer retains authored pixel order, isolated JS text execution, lazy capture/upload ownership, the dependency graph and compatible GPU handoff. Static inputs behind eight animated shaders still publish about 60 fps with no new captures/uploads or capture-source style reads after warm-up.

The decoded-callback experiment is a confirmed poor route on this Electron/Windows workload: matched initial refined trials drop 44.23–48.11% of reported video frames versus 0–1.02% with polling. Production now uses polling. After final cleanup, 16-video drops are 0–1.15% refined versus 0.12–0.60% naive; composition/interaction remain slow. Callback mode remains a runtime-only benchmark control. Do not reinstate it on publication-rate evidence alone.

The final two-small-panel case publishes median 17.54 fps refined versus 9.59 naive. Refined rAF is 52.43 versus 48.53, but timer p95 is 24.3 versus 18.3 ms. Each panel covers 7.5% of slide area, does not overlap the other and has no enclosing whole-scene effects. The procedural background remains intentionally demanding. All three original slides were also measured in both strategies.

## Changes from the reviewed baseline

- Graph teardown/replacement and dependency-edge changes cannot accept obsolete prepared inputs.
- Logical viewport and transform cache checks, sampling-size completion guards, capture failure dirty retention, late disposed invalidation and partial GPU-allocation cleanup were corrected.
- Native mirror images await readiness and use the original's selected image candidate.
- Refined style/pseudo/media-geometry reads are batched; property filtering and node attributes are cached.
- Large JSON paint snapshots are replaced with exact primitive comparisons, preserving all their inputs.
- Same-sized media canvases/shared drawing buffers are reused. Unchanged bitmap mirrors skip the extra priming paint.
- Mixed text-node topology and identical-string layout reorders invalidate retained snapshots.
- Benchmark controls retain naive/refined, decoded/polling and batched/interleaved matched comparisons; none is persisted.

No document/app version bump or migration is needed. Current v1 schemas, .sme/.smp, recovery, transfer, collaboration, DocumentAuthority and package version 0.1.0 are unchanged. The original input and user library remain read-only.

## Remaining work

1. Add a complete sampled-frame/source-freshness protocol and longer seeking/profile/bypass/context-loss/teardown checks. Copy-to-capture age telemetry excludes decoder age, retained frames and terminal display age.
2. Add measured frame/work and scene-memory budgets that preserve interaction and keep paused/export flushes complete.
3. Reduce traversal/media copying to proven contributors; do not crop arbitrary shader work or shrink media bitmaps without transform/Fit/Fill/Free evidence. Small panels still copy roughly 3 GiB of logical media pixels per five-second trial.
4. Investigate reusable texture lifetimes, larger compiled GPU runs and cached layout checks with correct invalidation. General group/prefix sharing remains absent.
5. Resolve fractional text fidelity (slide 2 at 35% zoom still differs about -16.46% in coverage), arbitrary CSS/alpha/blend/mask/clip boundaries and hidden-window capture.
6. Run mixed-effect export, macOS, long soak and extended/full/release/packaged checks before approval.

Dirty-node style tracking, pseudo-rule gating, containment/shadow-root capture and observer/rAF sharing are proposals, not implemented guarantees. MutationObserver already batches records and scheduled draws coalesce; do not delay dirty-state delivery past explicit flushes merely to reduce callbacks.

## Verification and reproduction

Final effects feature: 85 unit + 37 browser passed. Core: 15 passed. Typecheck, lint, build, stats/audit passed (363 active declarations / 69 groups). Motion 46, media 39 and presenter 24 passed after batching, before final local mirror/cache cleanup; those integration areas were not rerun after that cleanup. Effects pixel/readiness/cache tests cover the final local changes. Native alignment after batching completed 12 comparisons with position parity and unchanged fractional-text differences.

The review records 69 successful timed trials in five separately identified implementation phases. See REVIEW.md for exact commands and limitations. Keep browser suites and benchmarks serial; artifact directories are shared. Do not edit renderer modules during timed measurements.

Original: `D:\01_Projekte\06_presentations\showme-examples\css_js_shader.sme`, SHA-256 `2867d55e2739782c0f496365779f72c3268e2d35bd8914bb4430b642b29501fd`. Build and use Vite on port 5173, then run:

```powershell
node scripts/stress-effects.mjs SOURCE video-isolation 5000 3
node scripts/stress-effects.mjs SOURCE realistic 5000 3
node scripts/stress-effects.mjs SOURCE raster-isolation 5000 3
node scripts/stress-effects.mjs SOURCE review-smoke 5000 3
node scripts/verify-effect-alignment.mjs SOURCE
```

Preserve raw reports before repeating a selector; the runner overwrites its selector/duration/repetition report. Earlier reports/plots remain historical rather than being silently replaced. No main integration, release packaging or version change was performed.
