# Revert c9580ee: audience GPU comparison

2026-10-23. Local experimental comparison only; main has not been reverted.

Fixed main: `a699fbdd3af0e3ff8ab940db53379a8e4aeb1dfc`. Comparison renderer: `8dabe7b9c97b13c4517da8992a081b0df41f29e6`, reverting `c9580ee`. Production source matches its parent `1778927`. The newer SceneTexture capture fix cannot apply to the older renderer API; conflicted source/tests were restored to that parent. Only diagnostic evidence survives from the later main changes.

Three serial interleaved ten-second runs for each version/mode, identical harness
and saved `shader-text-shader.sme` (digest in evidence). Production Electron,
Radeon 880M / D3D11, 1596×998 CSS pixels, DPR 1.6042. Original user app remained
running. No concurrent verification jobs. Presenter-off prevents its renderer
from loading by substituting about:blank; editor and audience session remain.

| Renderer | Presenter | Audience FPS median [min, max] | Glass updates/sec median [min, max] | Frame p95 ms median [min, max] |
| -------- | --------- | ------------------------------ | ----------------------------------- | ------------------------------ |
| main     | on        | 21.1 [20.7, 22.5]              | 10.4 [10.4, 11.2]                   | 99.9 [99.8, 99.9]              |
| main     | off       | 27.0 [26.2, 27.7]              | 13.4 [13.0, 13.8]                   | 83.1 [66.8, 83.2]              |
| reverted | on        | 28.9 [23.8, 30.5]              | 14.3 [11.8, 15.2]                   | 66.8 [66.7, 83.4]              |
| reverted | off       | 49.1 [36.6, 50.2]              | 24.5 [18.3, 25.0]                   | 33.4 [33.4, 50.1]              |

The reverted renderer is faster for this visible GPU workload, particularly with
the presenter disabled. Ranges are broad; this does not establish universal
performance or visual equivalence. It also does not reach 60 glass updates/sec.
The earlier headless SwiftShader workloads do not predict this hardware result.

Background, text and glass were visible in captures and no shader diagnostics
were reported. Screenshots are not exhaustive pixel-parity or full-refresh
continuity verification. Counts measure rAF callbacks and shader publications,
not physical-display FPS.

Both production builds and `npm run verify:build` passed. Before pushing fixed main,
`SHOWME_TEST_FILES='["tests/feature/presenter/audience-navigation.spec.ts"]' npx playwright test --config playwright.config.ts --output test-results-capture-fix-main-gate`
passed both declarations on the exact candidate based on latest main. The revert
branch was built for measurement; its full correctness/release suites were not run.
No merge of the revert is authorized or performed.

[Raw measurements and provenance](evidence/revert-c9580ee-gpu-2026-10-23.json).
Raw screenshots/harness are retained locally under `.agenttmp` in both worktrees.
