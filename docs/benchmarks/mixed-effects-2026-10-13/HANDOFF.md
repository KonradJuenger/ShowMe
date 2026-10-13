# Handoff: review the current mixed-effect renderer

User intent: Electron-only CSS, JS text/animation, custom CSS, images/video and shaders should compose in authored order, while paying for pixels only when a stack needs them. Work stays on `experiment/mixed-effect-compositing`; the user authorized pushing it and creating an in-progress draft PR. The user now wants a new instance to review the current implementation. Do not start another large rewrite before reviewing this evidence.

Draft PR: [#4](https://github.com/KonradJuenger/ShowMe/pull/4). The branch and documentation are pushed. A read-only `git merge-tree --write-tree HEAD FETCH_HEAD` against main `d6494e3da6b59165167c04b3ce945cfc18bb900c` found no content conflicts; GitHub subsequently reported mergeable. The two newer main commits change AGENTS.md workflow guidance, not production code. Main was not merged or otherwise modified. Inspect the latest workflow instructions before any future integration; the renderer blockers below still prevent approval.

## State to review

Renderer commits:

- `cb8032a`: naive native mixed-effect support and first GPU experiment.
- `1e01b64`: original stress benchmark and design evidence.
- `6843bad6989963b2d782faddaec0e48f8d1a75ed`: dependency coordinator, lazy source leases, GPU output materialization, pruned mirrors and decoded-video invalidation.
- `53f60c78b2dc503081a9ff83cd78833f7e01e392`: shared readiness cohort, including preserving newer invalidations for a later request.

The current default is refined. `setEffectExecutionExperiment("naive")` retains the comparison control; `setGpuEffectChainingExperiment` retains the earlier experiment. These are runtime-only controls, not persisted schema options.

Read `src/components/effectGraph.ts`, `effectSources.ts`, `effectRuntime.ts`, `domRaster.ts`, `shaderOutput.ts`, and `tests/feature/effects/execution-graph.test.ts` / `mixed-compositing.spec.ts`. The existing `SlideRenderer`, isolated text workers, document model and persistence authority are retained. Follow the repository AGENTS.md; do not introduce a second document architecture or historical adapters.

[REPORT.md](REPORT.md), [results.json](results.json), [results.csv](results.csv), [comparison.svg](comparison.svg) and [alignment.json](alignment.json) are the committed evidence. The earlier [report](../mixed-effects-2026-10-12/REPORT.md) contains 94 baseline/prototype measurements. New evidence has 82 measurements / 45 scenarios, including four initial setup failures and successful targeted reruns after the cohort fix. Raw samples/PNGs/traces are local and ignored under `test-results-effects-stress/`; alignment originals are under `test-results-effects-alignment/`.

Original input, read-only: `D:\01_Projekte\06_presentations\showme-examples\css_js_shader.sme`. Hash `2867d55e2739782c0f496365779f72c3268e2d35bd8914bb4430b642b29501fd`. Its assets were copied through the current native library/profile path for benchmarking. Do not edit the original or user library.

## What is established

Eight shaders: median 1.58 → 58.15 publication fps, canvas bitmaps 415.55 → 24.26 MiB. Refined additionally owns 63.28 MiB output and 7.91 MiB input textures. Sixteen shaders: about 0.20 → 58.94 fps. Alternating CSS/shader depth 8: 3.38 → 17.49 fps. Two-lens heavy layered scene: 3.96 → 9.34 fps.

Static-image/text inputs feeding eight animated shaders reached 60.04 fps with **zero new captures and uploads** after warm-up. Computed-style reads in the capture source also stayed at zero; sampling and GPU-bridge checks still read styles outside that counter. DOM-only CSS/JS controls have zero pixel captures/owned shader textures. Red-element bounds now match within one screenshot pixel across the source-slide zoom checks.

These are publication rates, not unique video frames or source freshness. Logical texture/canvas accounting is not VRAM/residency. Group summaries choose the longest duration; inspect implementation SHA and individual rows when comparing phases.

## Known blockers and review risks

1. **Confirmed video regression.** With 16 videos, three naive runs dropped 0.34–1.04% of reported video frames; refined dropped 46.46–48.52%, with similar six-fps composition. Investigate the decoded-frame callback route against polling in an otherwise identical refined build. This comparison has not been run, so causality is not established.
2. **Main-thread responsiveness.** More terminal publications can coexist with worse rAF/input latency. Four heavy layered scenes reached 1.68 fps, 3.73 rAF fps and 1140 ms timer p95. At 64 shaders the main thread has long frame callbacks and video drops. Inspect trace function attribution rather than treating inclusive GPU-thread/paint wait totals as GPU saturation.
3. **No scene-level memory or work budget.** Owned allocations are released/accounted, but there is no pool, eviction policy or global reservation limit. At 64 shaders output textures alone reach 506 MiB. Hardware per-target caps do not make arbitrary scenes safe.
4. **Incomplete frame/freshness protocol.** Interactive work can use published inputs during capture; explicit flushes share requests. Mutable textures are not a fully immutable sampled frame token. Review seeking, profile/geometry changes, context loss, late workers/captures, consumer bypass and absent-owner transitions for stale completion hazards.
5. **Limited GPU bridge scope.** Same-element consecutive content shaders can hand off textures when computed paint/layout is neutral. General group runs and shared ordered prefixes across different lens targets are not implemented. Review arbitrary custom CSS, alpha conventions, interpolation, blend/filter/mask/clip and decoration changes; the existing channel/alpha case is not universal proof for every GLSL program.
6. **Fractional text fidelity.** Slide 2 text coverage changes −16.46% at 35% zoom despite correct bounds. Do not equate position parity with exact pixels.

## Proposed next performance work, in priority order

**First, benchmark realistic glass panels.** The existing two-lens scene is a stress derivative: each lens covers 85% × 85% of the slide, overlaps the other, and two enclosing full-slide groups add CSS/shader pairs. It uses a twelve-iteration procedural background, video, image and JS text. It is not an unchanged source slide or typical two-small-panel layout. Add a modest layout and benchmark the original three slides in both strategies before generalizing its 9.34 fps result.

**Reduce small-panel capture work.** Native capture already returns the target viewport, but retained source traversal and media bitmap copies still cover much of the lower scene. Prune contributors outside conservative visual bounds; include transforms, clipping, shadows/filter reach and backdrop dependencies. Keep a full-path fallback when reach/context is unknown. Avoid unsafe arbitrary-shader cropping.

**Compile whole GPU runs.** Keep DOM representation only at actual browser-paint/visible boundaries. Plan temporary texture lifetimes and reuse ping-pong/pooled targets where no other consumer needs an intermediate. Preserve authored ordering, per-stage timing/bypass and fallback semantics. Cache paint-neutral layout checks with correct invalidation and batch graph invalidation/clock sampling once per frame. These are proposals; current outputs are retained per shader stage.

**Protect interaction with budgets.** Coalesce to the newest required source/clock/profile generation and limit work admitted per frame. Prioritize visible stacks and responsive interaction; allow effect refresh to fall under load instead of saturating the main thread. Budget owned textures, capture mirrors/media and pending work, with explicit diagnostics. Paused/export rendering must remain deterministic and complete rather than silently degrading.

**Then evaluate capture backend alternatives.** Offscreen/shared-texture Electron capture was discussed but is unimplemented/unmeasured. It must retain the current document authority and preserve JS results/clock state; do not duplicate stateful/random script execution in a second renderer and assume equivalent pixels. Measure it only if native capture remains the bottleneck after the above changes.

## Verification and reproduction

Final renderer: `npm run test:feature -- effects` **82 unit + 33 browser passed**; `npm test` **15 passed**; `npm run typecheck`, `npm run lint`, `npm run build` **passed**. Motion **46**, media **39** and presenter **24** feature checks passed during this implementation; the last shared-cohort change was additionally checked with the effects/core/static/build paths. Stats/audit: **356 active declarations, 69 groups**. Do not run the full suite by default; full/release/package/macOS/export/long-soak remain unrun merge gates.

Use a fresh Vite instance on 5173 for Electron measurements, `npm run build`, then:

```powershell
node scripts/stress-effects.mjs 'D:\01_Projekte\06_presentations\showme-examples\css_js_shader.sme' v2compare 5000 3
node scripts/stress-effects.mjs 'D:\01_Projekte\06_presentations\showme-examples\css_js_shader.sme' v2cold 5000 1
node scripts/stress-effects.mjs 'D:\01_Projekte\06_presentations\showme-examples\css_js_shader.sme' v2extras 5000 1
node scripts/verify-effect-alignment.mjs 'D:\01_Projekte\06_presentations\showme-examples\css_js_shader.sme'
```

`v2limits 3000 1` originally ran before the shared-cohort fix; rerunning it will measure the current implementation and overwrite that raw report. Preserve evidence first. Repeating the two exact 16-video scenario IDs with `5000 3` produced the confirmed regression; their IDs are in results.json. Use `--destination=...` when summarizing so the older committed report is not overwritten.

Run browser suites **serially**: distinct ports do not isolate their shared `test-results-browser` artifact directory. Tests used `SHOWME_TEST_PORT=5174`. Do not edit renderer modules or run other heavy checks during timed measurements. Existing harness bootstrap logs are documented in the baseline report; do not repair unrelated harnesses as part of this review.

Next instance should review correctness and the video regression first, then choose a focused experiment. The draft must stay a draft until the blockers have evidence-backed resolutions.
