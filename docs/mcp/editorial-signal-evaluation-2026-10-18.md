# Editorial signal — fresh MCP evaluation, 2026-10-18

Created a NEW eight-slide native presentation, **ShowMe — Editorial signal**, through MCP semantic tools. Earlier presentations and artifacts were preserved. No branch, commit, push, PR, publication or message sending was performed.

Final artifacts:

- `artifacts/showme-editorial-signal/library/ShowMe — Editorial signal.sme` — 92,367 bytes; uses its adjacent managed library.
- `artifacts/showme-editorial-signal/library/ShowMe — Editorial signal 2.smp` — 470,749 bytes; FINAL portable package, with speaker notes included and media export unlocked.
- The unsuffixed SMP is an earlier checkpoint before the media-caption alignment correction. It is retained as evidence, not the final deliverable.
- `fresh-library/Signal.smp` is a byte copy of the FINAL package. `cold-package-final.json` records the exact source path, complete fresh document identity, eight-slide outline and corrected media captions.

The presentation uses warm ivory, vermilion and ink, Georgia display typography, editorial rules, geometric registration art and restrained native motion. This is distinctly different from the prior cool Aurora theme. Three authored shared templates (plus the required default), seven authored Text Styles (plus two defaults), page-owned shared CSS instances inherited from a template, and a native slide recipe were exercised. Artwork is original SVG, its PNG rasterization and a two-second WebM made from it. These are authored graphic studies, not product screenshots.

Slides: (1) Make ideas impossible to ignore; (2) A working canvas; (3) One system, many stories; (4) Timing is part of meaning; (5) An agent, your document; (6) Every asset, in its element; (7) Keep the work; (8) Make your next point.

## Discovery and authoring evidence

The evaluation client discovered tools/list and authoring contracts through MCP. It queried template, slide, deck, text, element, effect, Presence, Motion and timeline families, plus workspace/delivery/preview and the complete CSS guide. Construction used discovered schemas and exact identities, not raw document writes. The shell harness only launches isolated native sessions, invokes the real stdio SDK client, writes evidence and creates input media. It adds no application tool, renderer, serializer or persisted recipe model.

`tool-calls.jsonl` records **116 callTool requests**, **zero error responses**, plus one intentionally failed item inside a successful non-atomic mixed import receipt. Distribution: context 23, workspace 8, authoring 13, inspect 34, apply 10, measure_text 3, preview 20, deliver 5. tools/list, harness launch/close and local failures are outside that callTool count. Image content is saved separately, not logged as base64. No bridge credentials are logged. Runtime user-data directories are private infrastructure; do not publish them.

Seven page groups were built in one **90-operation** atomic edit; the eighth slide was instantiated from slide 3 with five discovered text-slot replacements. Its native idMap and template/style references were retained. Notes were explicitly replaced with slide.update. Shared template CSS was captured, attached to a second instance, revised once and pruned through semantic tools. Timeline inspection supplied stable Motion/Presence block IDs, then duration, delay and entrance timing were revised through them. Human editor context remained on the cover, with empty selection and clean saved state.

All eight 1440×810 base slides were visually inspected. Slide 6's original single text line used spaces for three captions, which misaligned the labels with media. This was an authoring/layout mistake, not a text-fit defect: it was replaced with three independently positioned editable text boxes. Final production measurements cover **48 text appearances**, including repeated inherited text, with **zero horizontal or vertical overflow**. The final fit file combines the unchanged 45 appearances and three remeasured caption boxes; no typography was silently shrunk.

**29 frames** were captured in 20 preview calls. Fourteen sampled frames cover the revised click reveal at 0/1250/2400 ms; shared native-time CSS at 0/1800 ms; and forward, backward and jump push transitions at 0/325/650 ms. Representative states and transition midpoints were visually inspected. Warnings were empty. These establish composition/timing correctness only. No live audience frame-rate, smoothness or performance improvement is claimed.

## Issues, exact symptoms and recovery

1. **Harness bootstrap configuration mistake.** Two launches stopped before an Electron window because the new selected root lacked `ShowMe Library`; the native setup/error dialog precedes editor creation. Observed harness error: `electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"`. Recovery: create the required library directory, close only the evaluation processes, then launch again. This was normal native root validation, not a workspace-create defect. No semantic calls were made by those launches.
2. **REPL/tooling detours.** Dynamic dependency imports failed with `The requested module './test.js' does not provide an export named 'default'`, the equivalent `./index.js` error, and `Event is not defined`. Recovery: a local Node CLI harness using the real SDK/Playwright modules. An unavailable Python alias and malformed temporary Node editing scripts also failed before edits were applied; successful source changes were verified afterward. These were engineering/harness issues, not application errors.
3. **Intentional partial import probe.** The SVG and PNG imported with prepared 900×900 dimensions; the absent path returned item `{index:2,status:"failed",preparation:"unsupported",error:{code:"IMPORT_FAILED",message:"Could not import this item. Check its format and selected-root authorization."}}`, while earlier IDs remained usable. The failed item was not retried. `unsupported` is an imprecise preparation label for a missing source; see the remaining handoff issue. A later WebM import returned 450×450, duration 2 seconds; an EXIF orientation-6 JPEG returned native decoded 60×120 from encoded 120×60.
4. **Real black-video-poster defect.** Initial slide 6 showed a black WebM rectangle with `warnings:[]`. The prepared JPEG was also black, while FFmpeg's independently extracted first frame showed the registration graphic. `loadeddata` could precede a drawable offscreen frame. Fix: production media enrichment and poster capture wait for seek completion; static preview prepares posters before mounting/capture. Native regression checks known red poster pixels, then cold package pixels in a fresh library. Reimport retained the content hash and refreshed the catalog/poster. Corrected and final screenshots remain alongside the original failure.
5. **Harness package-version mistake.** The first fresh-library check copied the unsuffixed earlier SMP after a second export had allocated `… 2.smp` under native no-overwrite policy. The original verification copy was preserved as `Signal-before-caption-fix.smp`; the exact final package was copied to `Signal.smp`, cold-opened again and checked for the new caption IDs. This was a caller artifact-selection error. Native filename suffixing was correct.
6. **Expected native identity changes.** Opening an SMP created an independent document ID and a fresh epoch/revision 0. Both warm package open and final cold open refreshed the COMPLETE identity before any reads. No stale-identity call was attempted. This is normal native behavior, not lost history or a defect.
7. **Expected font portability warning.** Typed package delivery returned `fontWarnings:["Georgia"]`. The package embeds used SVG/PNG/WebM assets, not the Georgia font. Georgia was loadable on this Windows machine; exact face/glyph identity and other-machine typography are not guaranteed. Native package/font policy was preserved.
8. **Inspection guidance typo found during review.** The initial new recipe receipt said `slide.notes.set`, which does not exist. It was corrected to `slide.update with notes`. The authoring client had already used the discovered valid slide.update operation, so this caused no rejected authoring call.

No semantic construction batch failed. The deliberate malformed-operation and style-collision cases were exercised separately by deterministic and real SDK regressions; they are not hidden in the deck call count.

## Useful single-run latency observations

These are observations from one Windows workload, not comparable benchmarks or improvement claims:

- Workspace create: 64.70 ms; authority identity immediately available, context still needed polling.
- Seven-page, 90-operation construction: 283.51 ms.
- Recipe duplicate plus notes replacement: 62.36 ms.
- Initial CSS production validation: 200.56 ms; capture/attach/source update/prune batch: 14.51 ms.
- SVG/PNG/missing-item import: 229.44 ms; WebM plus oriented JPEG: 140.30 ms.
- Text preflight, 25 items: 41.76 ms; 46 final appearances before caption replacement: 38.02 ms; three replacement captions: 84.44 ms.
- First base preview: 539.16 ms; corrected cold video preview: 830.67 ms. Preview warm/cold state differs.
- First typed package: 173.97 ms; final package: 230.34 ms. Exact destinations come from receipts.

## Verification and limitations

- `npm run build`: passed; includes TypeScript checking and Electron/MCP bundles.
- `SHOWME_TEST_FILES` selecting agentEditing, agentWorkspace, agentProjection, agentDelivery, session-failure, agentPreview, agentBridge, agentInspection, agentClosing and persistence/package-options, then `npx vitest run`: **10 files, 113 tests passed**.
- `SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts","tests/extended/agent-preview.spec.ts"]'; npx playwright test --config playwright.electron.config.ts --output test-results-mcp-friction-isolated-final`: **17 passed (58.6 seconds)**, evaluation apps closed. No retries or assertion weakening.
- A later SDK root-field diagnostic refinement reran agentEditing: **46 passed**. The targeted real-SDK/native lifecycle checks are recorded in the completion note below.
- `npm run test:stats`: **597 active declarations / 88 groups**. `npm run test:audit`: passed.
- ESLint on all task-touched source/tests: passed. Final whitespace and delta checks are recorded below.

Earlier failing native attempts are retained in `test-results-mcp-friction-native`, `…-native-corrected`, `…-video-package` and `…-package-diagnostic`. They exposed missing isolated-runtime asset-read authorization and the incomplete first package-option plumbing (native lock questions still opened, followed by `DELIVERY_BUSY`). The fixes authorize only scoped asset/font reads for the isolated runtime, keep catalog writes in main, and route both explicit package choices. The corrected native PNG/SVG path passed; the video/package path then passed including fresh-library assets, notes removal and focused-edit switch refusal. The isolated 17-declaration sweep passed afterward.

Full/release suites, installers, macOS, repeated benchmarks and live audience smoothness measurement were not run. No commit/integration was authorized, so the audience-navigation commit gate was not triggered. All evaluation app instances are closed. See `FRICTION_IMPLEMENTATION_HANDOFF_2026-10-18.md` for actionable remaining work.

## Final completion note

The final SDK check passed **2 declarations (8.9 seconds)**. After reviewing recovery labels, missing-source preparation was corrected from `unsupported` to `not-attempted`; a corrupt PNG now returns its retained imported ID with `preparation:unsupported` and `MEDIA_PREPARATION_UNSUPPORTED`. Decoder rejection is returned as an item diagnostic instead of being mistaken for renderer loss/restarted. Agent metadata preparation uses an 8-second deadline inside the existing runtime envelope; normal human enrichment retains its 15-second default. The final native command `SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts"]'; npx playwright test --config playwright.electron.config.ts --grep 'native templates shared|raw SDK tools list' --output test-results-mcp-friction-media-recovery-final` passed **2 declarations (9.3 seconds)**, including corrupt/valid media, notes policy, focus-safe lifecycle refusal and fresh-package pixels. The saved presentation's valid assets/content were unchanged. Build/typecheck passed after the delta. The original evaluation receipt remains logged as observed; this note records its subsequent diagnostic fix.

Final local audit: ESLint passed for all task-touched source/test files; `git -c core.safecrlf=false diff --check` passed; final `npm run test:audit` passed with 597 declarations in 88 groups. The local evaluation harness was stopped after closing all evaluation app instances. All prior uncommitted work/artifacts remain; no Git mutations were performed.
