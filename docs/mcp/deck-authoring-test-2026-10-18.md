# ShowMe MCP deck authoring test — 2026-10-18

## Result and scope

Created **EMBER — Make it move**, a seven-slide, editable, fictional creative studio pitch in the running ShowMe desktop app, entirely through ShowMe MCP semantic operations. No application source changes, Git commits, or exports were made. The live document is `bc9c685c-06d5-4edc-90c1-bcbd7307d941`, epoch `774f512a-1ef2-4f94-9485-280f1971261d`, final accepted revision 15. It remains dirty (`savedRevision: 0`); this is a live document, not a saved `.sme` deliverable.

Environment: local-codex; branch `codex/local-mcp-server`; HEAD `df31f1a733cdfb3992c15ea6f5b14ff32c9f0069`; MCP server 1.3.0; effect API 1. The checkout was clean before this test's documentation/reference artifacts.

## Specific visual inspiration

Selected [FusionForce Creative Marketing Agency](https://dribbble.com/shots/24246998-Pitch-Deck-FusionForce-Creative-Marketing-Agency), by **Dhefry Andirezha for One Week Wonders**, after opening the requested pitchdeck collection and comparing actual imagery from FusionForce and SlabPixel's Deepstack, plus Outcrowd's conversational AI deck description.

The inspected FusionForce image uses monumental condensed orange uppercase typography, warm cream italic serif lettering, a near-black grain surface, and an asymmetric editorial grid. Those concrete choices informed EMBER's Impact/Georgia/Arial typography, `#FF4D16` orange, `#FFF2DA` cream, and `#17100D` dark base. Layouts, text, and procedural visuals are original. No reference artwork was inserted into the presentation. Credit is recorded in the first slide's notes.

## Deck and animation coverage

1. **Make some heat:** oversized stacked title; copper ribbon GLSL shader with procedural grain and continuous presentation time; eased entrances; subtle CSS ink pulse.
2. **The attention problem:** cream editorial slide with three columns and eased text entrances.
3. **A studio built for movement:** orange typography slide; CSS shimmer; 850 ms push transition.
4. **Form and feeling:** continuous GLSL contour field; CSS light treatment; eased title and serif entrances.
5. **A launch worth measuring:** editable native bars (100 and 180), isolated JavaScript counter completing at 1.8×; one click reveals the bars. Figures are explicitly illustrative, not client results.
6. **How the work moves:** three native Frames, with parent-local children and Presence on each Frame. DEFINE enters at slide start; two clicks reveal DESIGN and LAUNCH. Three native scaleX Motion tracks animate the rules.
7. **Make it move:** orange closing slide; live CSS signature movement; eased entrances; 850 ms wipe transition.

Default transition is a 700 ms fade with ease-in-out. The deck contains two GLSL effects, four CSS effects, one text-JavaScript effect, 28 Presence entries, and three numeric Motion tracks. All persistent edits went through the existing semantic MCP path; no direct storage or document JSON mutation was used.

## Observed errors and recovery

| Observation | Evidence | Recovery / implication |
| --- | --- | --- |
| `MEASUREMENT_UNAVAILABLE` while context reports ready | Three measurement requests failed before runtime initialization, including after a successful preview. | Not solved by ordinary retries or preview creation. |
| `EFFECT_VALIDATION_UNAVAILABLE` | Two cover batches rejected at operation index 3, the background shader. | The whole batch remained uncommitted, preserving atomicity. |
| Missing lazy entry points in the agent runtime | `src/main.tsx` installs a lazy wrapper for `measureAgentText`, but not `measureAgentTextBatch` or `validateAgentEffect`. The complete functions exist in `SlidePreviewPage.tsx`, loaded only on installation. | Inserting a useful `autoSize: "height"` text element calls the working single-element measurement wrapper, installs the module, and makes subsequent batch measurement and effect validation succeed. This was verified without modifying source. |
| `TEMPLATE_OWNED` on starter slide background | Initial cover batch rejected at operation index 2. | The returned `suggestedOperation: slide.make_independent` worked. The failure also prevented earlier rename/default-transition operations from committing. This is a useful guard, not a broken ownership rule. |
| Create response names the source slide | Creating `ember-02` returned the original slide in top-level `slideId`; `createdSlideIds` correctly contained `ember-02`. Repeated for subsequent slides. | Client must use `createdSlideIds`, not assume top-level `slideId` is the authored page. |
| Base preview cannot establish final animated appearance | The initial finite CSS entrance left the cover description blurred in base preview; the counter preview shows its beginning around 1.0× while bars show authored final geometry. | Replaced the cover's blur treatment with a readable continuous CSS treatment and native Presence. Counter remains a deliberate animation. No timestamp/step sampling exists in the MCP preview contract. |

## Prioritized MCP improvements

### P0 — Initialize all hidden-runtime entry points

Add lazy startup wrappers for `window.measureAgentTextBatch` and `window.validateAgentEffect` alongside the existing wrappers in `src/main.tsx`, or await one explicit runtime-ready handshake before either call. Cover cold startup directly, rather than warming the runtime incidentally in a test. Context should distinguish runtime initialization from document/editor readiness. Preserve the underlying diagnostic cause instead of converting every failure to the same retry message.

### P1 — Publish usable operation schemas through discovery

The exposed `showme_apply` metadata represents operations as `unknown` alternatives. Layout/text/motion authoring returns names and a few examples, not complete request shapes. Repository access was needed to discover insert arguments, transition vocabulary, stage behavior, and effect update fields. A remote agent should not need the source checkout.

Return a versioned schema for the requested operation family, with required/optional fields, examples, limits, stage semantics, template ownership, and create-response semantics. Include deck transition operations in discovery. Return compact contracts by default and the long creative-code prompt only on request; this reduces repeated context cost.

### P1 — Add deterministic animation preview

Support explicit slide time, stage/click index, elapsed stage time, and a settled-state option through the production renderer. A bounded contact sheet at selected times would expose overlap, counter completion, clipping during entrances, and backward/jump behavior efficiently. Report the actual sampled clocks in the result. Base-only preview is valuable for composition but cannot verify smooth transitions or temporal correctness.

### P2 — Make returned identities and revisions unambiguous

Use explicit `sourceSlideId` and `targetSlideId` for slide construction, or document top-level `slideId` clearly. An idempotent replay correctly returns the original historical revision (10 here) even when the current document is at 15; expose `currentRevision` separately so clients do not accidentally regress their next expected revision after recovering a lost response.

### P2 — Expose timeline scheduling and editing

Presence supports creation but the MCP operation lacks start offsets, end schedules, and update/remove operations. Numeric Motion likewise has no exposed delay, and presets have no settings argument. This limits deliberate automatic stagger and revision of an existing timeline. Add semantic block IDs and bounded schedule edits, retaining native Presence for lifecycle and Motion for values. In this deck, differing durations and click stages were available; genuine delayed stagger was not.

### P2 — Reduce deck construction round trips

`slide.create` must be first in its batch, and the batch then targets one slide. Seven slides therefore require serial revision-dependent writes. Consider a bounded multi-slide semantic batch with explicit page targets and local references. Keep authority/revision checks and atomicity; do not add a parallel document persistence path.

### P2 — Complete review and delivery workflows

The six exposed tools provide no save/export operation, playback navigation, or deterministic playback inspection. Add explicit semantic save/export and presentation navigation capabilities with clear path/overwrite rules. This test can leave a live deck, but cannot deliver a native saved presentation through MCP alone. A font-availability query and content-fit diagnostics would also reduce avoidable preview iterations.

## Verification and exploratory timings

- `showme_preview`: visually inspected all seven slides at 1440×810. Every response had an empty warnings array. Reviewed typography, intended spacing, native chart ratios, and grouping. Rechecked the final cover after replacing the finite blur effect.
- `showme_measure_text`: after warmup, successfully measured the cover and four major heading layouts with production fonts; the latter four were measured before construction.
- `showme_inspect`: confirmed seven slides, names/order, default transition, and native Frames/parent-local geometry, click-indexed Presence, and numeric Motion on the process slide.
- Replayed exactly the accepted `ember-slide-07-v1` request: `replayed: true`, original transaction/revision returned, no duplicate slide.
- Sent a deliberately stale revision-9 rename intent after revision 15: rejected with `REVISION_CONFLICT`, `actualRevision: 15`. Final name/revision remained intact.
- Warm successful six slide-construction batches took approximately **75–313 ms** each for 10–28 semantic operations, measured around tool promises in this session. Three parallel preview requests completed in approximately **0.17–1.21 s**, depending on shader/content and queue position. These are single-session exploratory observations, not repeatable benchmarks or regression claims.
- Effects passed ShowMe's production validation after runtime warmup. Smoothness, actual audience playback, reverse navigation, and exact animated timestamp states were **not verified**: the MCP has no playback/sample interface. Preview success is not evidence of frame-rate performance.
- No product test commands, builds, or audience-navigation gate were run: application code was unchanged and no rendering-affecting commit/integration was made. Changes on disk are test documentation and downloaded visual references only.
