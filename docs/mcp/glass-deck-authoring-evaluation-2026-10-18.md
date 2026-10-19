# Glass deck MCP authoring evaluation — 2026-10-18

User requested a reference-inspired ShowMe deck, a shared changing shader background, CSS glass overlays, staggered Presence entrances, and a record of MCP friction. No application source changes, commits, branches or PRs were made.

## Result

- Created six editable slides in the running app using only ShowMe MCP for document authoring.
- Document: `724b46b4-a47d-49e6-a63e-ae23dd2deb38`, final accepted/saved revision 5.
- Shared Template A contains one continuous GLSL background. Slide and previous-slide seeds blend its composition over 1.2 seconds. Native fade transitions last 700 ms.
- CSS Effects provide translucent gradients, backdrop blur, rounded borders and shadows on structural Frames. Presence animates the parent Frames and text at entry with 800 ms eased moves and staggered offsets.
- Saved successfully, preserving animation, to `D:\01_Projekte\06_presentations\showme-examples\ShowMe — Ideas in motion.sme`.

## Observed friction and improvements

1. **App discovery:** initial context and authoring calls both returned `APP_UNAVAILABLE` because ShowMe was closed. User opened it and retry succeeded immediately. Error was accurate. Consider returning distinct discovery reasons (no running instance versus disabled MCP versus wrong profile) when safely knowable. Authoring contract discovery also requires the running app, so useful planning is blocked during an outage.
2. **Native expansion budget:** a six-page batch with 123 semantic operations passed the advertised 128-operation count but failed atomically with `PAYLOAD_TOO_LARGE`: assembled intent exceeded 256 native operations. No changes were accepted. Three sequential two-page batches succeeded. Provide an estimate/preflight or per-operation native cost; ideally report actual assembled cost and a suggested split. Expanded semantic budgets would not resolve the native limit.
3. **Schema discovery volume:** compact operations discovery lists names, requiring additional targeted calls for exact schemas. Targeted schemas worked well, but repeated common envelope prose and duplicated text/structured responses consume substantial context. A multi-operation schema query or concise schema-only response would help.
4. **Transition sample invariants:** the first transition request used different incoming/outgoing capture times and was correctly rejected. Matching both capture times succeeded. Add a complete two-trace example to preview discovery; the invariant is easy to miss in the outer schema.
5. **Strict read envelope:** an initial deck inspection accidentally included `slideId` from the common context object and was correctly rejected. Retrying with the exact read envelope succeeded. This was caller error, not an application defect.

## What worked

- Context exposed document identity, revision, template support and editing authorization clearly.
- Exact-revision transactions, explicit IDs, cross-page staging and semantic parent-local Frames worked reliably.
- Production font measurement confirmed Arial availability and heading fit before construction.
- All six settled slide previews succeeded without missing-media or Effect-fallback warnings.
- Multi-sample Presence preview at 400 and 1800 ms showed the intended stagger. A corrected mid-transition sample succeeded without warnings.
- Shader preview revealed a seam caused by my nonperiodic angular color formula. Updating the existing template Effect to use an integer angular frequency fixed it for all slides. This was authoring error, not MCP friction.
- Native save returned an explicit destination, written status, animation preservation and saved revision.

## Verification boundary

Visual review used `showme_preview` at exact revisions, including settled slides, Presence timing and a transition. These PNG samples establish appearance and timing, not live audience playback smoothness. No performance benchmark or live playback capture was run. No product code changed, so repository product tests and the main-commit audience-navigation gate were not applicable; no rendering-affecting commit was created.
