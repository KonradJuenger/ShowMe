# Codex investigation and phased implementation plan

Purpose: give Codex a disciplined path to investigate and implement the ShowMe MCP without creating a second editor architecture.

This plan is investigation-first. Each phase has questions, deliverables, tests and a stop condition. Codex should not jump ahead because a later phase looks easy.

## Non-negotiable constraints

Before changing code, read AGENTS.md and all files in docs/mcp/, especially RESEARCH_CONTEXT_AND_STATE.md.

Preserve the persistent edit path:

~~~text
Editor
-> EditorSession
-> DocumentOperation[]
-> DocumentTransaction
-> DocumentAuthority
-> durable recovery
-> accepted revision
~~~

Do not introduce direct .sme mutation, a second document schema, a second DocumentAuthority, an MCP-owned presentation copy, arbitrary Electron IPC forwarding, arbitrary JS/eval tools, an internal LLM for Effect generation, MCP-specific rendering semantics, or a giant raw-document context dump.

The MCP must expose ShowMe, not bypass it.

## Working method

For every phase:

1. Inspect the relevant code completely enough to understand ownership.
2. Write findings before implementation.
3. Identify reusable existing functions.
4. Identify missing abstractions.
5. State what should not be changed.
6. Implement the smallest coherent slice.
7. Run only relevant tests.
8. Update the MCP docs if implementation changes an architectural assumption.
9. Stop at the phase gate.

If a phase reveals that the proposed architecture is wrong, fix the design docs before continuing.

## Phase 0: repository reality check

Goal: validate the research against the current codebase before implementing anything.

Inspect at minimum:

~~~text
AGENTS.md

src/core/document.ts
src/core/element.ts
src/core/editorSession.ts
src/core/editorCommands.ts
src/core/editorChange.ts
src/core/documentTransactions.ts
src/core/documentAuthority.ts
src/core/documentRuntime.ts

src/core/motion.ts
src/core/motionModel.ts
src/core/presence.ts
src/core/effects.ts
src/core/effectAuthoring.ts

src/platform/api.ts
src/platform/editorTransport.ts
src/platform/browser.ts

electron/main.ts
electron/preload.ts
electron/ipcRouter.ts
electron/storage.ts

src/components/EditorCanvas.tsx
src/components/EffectEditor.tsx
src/components/effectRuntime.ts
src/components/textEffectRunner.ts
~~~

Also find the owners of active slide state, selection state, selection scope, Click Timeline playhead/stage state, presenter/preview state, world transform/world bounds helpers, screenshot/preview capture, accepted transaction subscriptions, undo/history ownership and any existing app-instance discovery IPC.

Questions to answer:

1. Where should a read-only Agent Projection live?
2. Which helpers already calculate world bounds?
3. Can those helpers be reused outside React without duplication?
4. Where exactly do active slide, selection, stage and time live?
5. Does Electron main already know enough to answer context?
6. What minimal ephemeral renderer-to-main bridge is required?
7. Can preview capture accept deterministic slide/stage/time now?
8. How does current preview differ from presenter/audience rendering?
9. What accepted transaction information can support semantic deltas?
10. What breaks if actor mcp-local commits while the local editor is open?
11. Which semantic editor commands require renderer-only services such as text measurement?
12. Which Effect validation steps are core-safe and which require DOM/WebGL/Worker?

Deliverable: create docs/mcp/CODEX_PHASE0_FINDINGS.md with the current ownership diagram, file/function references, answers to the twelve questions, deviations from current design docs, recommended Phase 1 file placement and risks/blockers.

Do not implement MCP transport in Phase 0.

Gate: proceed only if the Agent Projection can be added without becoming another source of truth.

## Phase 1: deterministic read projection

Goal: make ShowMe able to describe itself to an agent without MCP.

This is the most important phase.

Suggested core modules, if repository ownership supports them:

~~~text
src/core/agentContext.ts
src/core/agentInspection.ts
src/core/agentProjection.ts
src/core/agentResults.ts
~~~

These are derived views only. They must not own mutable presentation state.

Implement first:

Document outline:
- document/deck metadata;
- canvas dimensions;
- slide order;
- slide IDs/names;
- hidden state;
- template reference;
- element count.

Slide semantic outline as a flat deterministic preorder:
- id;
- parentId;
- layerId;
- depth;
- z;
- name;
- type;
- textPreview;
- worldBounds;
- style references;
- Effect count;
- Motion/Presence summary flags;
- child count.

Scoped element detail:
- exact text/content;
- local frame;
- world bounds;
- appearance;
- geometry;
- content metadata;
- Effect instance summaries;
- relevant style references.

Do not include by default:
- notes;
- full Effect source;
- raw media bytes;
- filesystem paths;
- full native Motion tracks;
- unrelated slides' text.

Determinism requirements:
- stable ordering;
- stable omitted/default fields;
- stable rounding policy;
- stable summaries;
- no model-generated summaries.

World bounds must reuse production scene/transform logic if possible. Do not implement a second transform system just for MCP.

Tests:
- simple slide;
- nested frame/container;
- transformed/rotated child;
- multiple layers;
- text;
- image/media;
- Effects;
- Motion/Presence;
- hidden/locked elements;
- template-derived slide where relevant.

Verify IDs, hierarchy, world bounds, ordering, privacy defaults and bounded text previews.

Gate: a developer must be able to call the projection in a test and understand a slide without MCP.

## Phase 2: ephemeral live editor context

Goal: answer "what is the user looking at right now?"

Investigate the canonical owners of current document/window, active slide, selection IDs, selection scope, editor/preview mode, Click Timeline stage and playhead/time.

Do not move UI state into the document.

Proposed shape:

~~~ts
interface AgentUiContext {
  documentId: string;
  activeSlideId: string | null;
  selectionScopeId: string | null;
  selectionIds: string[];
  mode: "editor" | "preview" | "presenter";
  stageIndex: number | null;
  stageTimeMs: number | null;
  uiEpoch: number;
}
~~~

Exact fields may change after investigation.

uiEpoch should increment when agent-relevant ephemeral state changes: active slide, selection, scope, mode, stage and meaningful playhead changes. It is not document history.

If renderer-to-main communication is required, add one explicit typed channel. Publish only this narrow context. No arbitrary renderer state, DOM exposure or document mutation.

Tests:
- selection changes;
- active slide changes;
- stage changes;
- same document revision with new uiEpoch;
- document close/open;
- stale selection IDs after accepted edits.

Gate: a caller outside React can retrieve document revision, active slide, selection and UI epoch without controlling the editor.

## Phase 3: production preview service

Goal: let an external caller see the same slide the audience/editor preview sees.

Investigate renderProjection, capturePreview, thumbnail rendering and presenter rendering. Document exact differences.

First support a static request containing document ID, slide ID, revision and requested viewport size.

Return PNG plus actual width/height, revision, slide ID and warnings.

Then investigate deterministic timeline state with explicit stageIndex and stageTimeMs.

Do not fake this by mutating the live editor playhead. Find the cleanest sampling seam shared with presenter/runtime.

Tests:
- no editor frames/guides;
- missing media behavior;
- Effect rendering;
- text;
- images;
- transparency;
- nested containers;
- high-DPI behavior where relevant;
- no accidental full-resolution waste for a small preview.

Gate: context -> inspect -> preview works entirely inside ShowMe, still without MCP.

## Phase 4: read-only MCP spike

Goal: prove the context design with real models before granting write access.

Current transport hypothesis:

~~~text
MCP host
-> stdio showme-mcp helper
-> authenticated local bridge
-> running ShowMe
~~~

Investigate packaging/process ownership before finalizing. Use the current MCP 2026-07-28 semantics and TypeScript SDK v2.

Initial public tools only:

~~~text
showme.context
showme.inspect
showme.preview
~~~

No writes.

showme.context: cheap orientation.

showme.inspect should experimentally support targets such as document, slide, elements and selection; detail levels minimal, extended, full and native; and selective includes such as content, geometry, appearance, hierarchy, styles, Effects, Motion and explicitly requested notes. Codex should simplify this if real model use shows it is too flexible.

showme.preview: MCP image result plus structured metadata.

Implement only Resources shown to improve the actual read loop. Likely first candidates are showme://capabilities and stable Effect specs. Do not build a huge resource hierarchy preemptively.

Local bridge security if loopback HTTP is used:
- bind loopback only;
- authenticate;
- protect Host and Origin;
- reject browser origins;
- bound payloads;
- no permissive CORS;
- no arbitrary RPC dispatch.

If named pipe/socket is clearly simpler and safer cross-platform, document why.

Cross-client experiment: test at least three available MCP clients. For the same tasks record tool sequence, payload size, correct target recognition, screenshot usage and failures.

Read-only task corpus:

~~~text
"What is selected?"
"Describe the current slide."
"Which element contains 26%?"
"Is the headline aligned with the chart?"
"What happens on click 2?"
"Does the selected object have an Effect?"
"Which elements overlap?"
"Which slide contains the phrase X?"
~~~

Compare:
A. structure only
B. screenshot only
C. structure + screenshot

Measure target correctness and context usage.

Deliverable: docs/mcp/CODEX_PHASE4_READONLY_EVAL.md with real traces/results and recommended contract changes.

Gate: do not add writes until models reliably identify targets and understand visual state.

## Phase 5: semantic mutation adapter without MCP

Goal: prove safe native editing as an application API before exposing it as a tool.

Build a stable model-facing semantic operation layer. Do not expose raw DocumentOperation as the normal agent API.

Initial operations only:

~~~text
text.set
elements.move
elements.frame.set
elements.appearance.patch
element.insert_text
element.insert_shape
elements.remove
~~~

Postpone operations that depend on unclear renderer-only behavior.

Every mutation includes documentId, expectedRevision, mutationId and operations. Targets use explicit stable IDs.

Investigate bounded mutationId replay protection so a transport retry cannot apply the same completed change twice. Do not create hidden durable protocol sessions.

Atomicity:
- validate all semantic operations;
- build one coherent editor change;
- commit once;
- fail without partial accepted state.

Output:
- previous revision;
- accepted revision;
- transaction ID;
- mutation ID;
- created IDs;
- changed IDs;
- warnings;
- semantic change set.

Investigate semantic deltas derived from requested operation, accepted DocumentOperation[], before/after projection or accepted transaction metadata. Prefer deterministic machine derivation.

Actor investigation: prototype mcp-local and test human active lease on same element, another element, another slide, LAN collaborator lease, undo/redo, close and revision conflict.

Write findings before exposing write tools.

Gate: the semantic mutation API is demonstrably safe in tests without MCP transport.

## Phase 6: write-enabled MCP for ordinary editing

Goal: expose the proven semantic adapter.

First write tool hypothesis: showme.apply.

Start with the Phase 5 operation union only. Do not expose every editor feature.

Expected workflow:

~~~text
showme.context
-> showme.inspect
-> showme.apply
-> showme.preview when visually material
~~~

Structured expected errors:
- REVISION_CONFLICT;
- LEASE_DENIED;
- UNKNOWN_SLIDE;
- UNKNOWN_ELEMENT;
- INVALID_SCOPE;
- UNSUPPORTED_OPERATION;
- DOCUMENT_CLOSED.

Include recoverability and recommended next action.

Investigate/prototype a user-visible activity/undo affordance such as "Agent changed 3 elements / Undo agent edit". Do not merge an awkward history model silently.

Evaluation:
- edit selected title;
- move selected object;
- recolor selected group;
- insert a label;
- delete one element;
- atomic two-property edit;
- stale revision;
- selection changes between context and apply;
- repeated mutation retry.

Measure unrelated mutation rate. Target should approach zero.

Gate: ordinary agent edits are predictable and reversible.

## Phase 7: native Motion and Presence

Goal: let agents animate using ShowMe semantics, not generated code.

Investigate current addMotionPreset, addParameterAnimation, addPresence, editPresenceSchedule and setSlideMotion behavior.

Public-domain hypothesis: separate showme.animate from showme.apply. Test whether this actually improves model tool selection.

Possible operations:
- motion.add;
- motion.update;
- presence.add;
- presence.update;
- property.animate.

Do not expose raw keyframe IDs/ranges for routine tasks.

Evaluation:
- "Move the title in on slide entry."
- "Have these cards appear one by one."
- "Hide this until click 3."
- "Fade this out at the next click."
- "Make this Effect parameter ramp over 800 ms."

Grade whether native Motion/Presence was used correctly.

Gate: normal animation remains editable through ShowMe's existing UI.

## Phase 8: Effect authoring

Goal: allow model-authored GLSL/CSS/text-JS while preserving production validation.

First refactor shared validation out of EffectEditor.tsx. Do not create a fake Node-only validator.

Shared behavior should cover schema parsing, authoring diagnostics, real GLSL compilation, real scoped CSS compilation, text-JS worker validation and production preview readiness where necessary.

Resources should split stable Effect ABI from target-specific authoring context. Do not repeat the entire Effect specification in every tool description.

Public-domain hypothesis: showme.effect with actions apply, update, parameter.set, enable, disable and remove.

Generated Effects remain presentation-local by default. Do not auto-save to Effect Library.

Workflow:

~~~text
inspect target
-> read Effect authoring resource
-> model writes source
-> showme.effect
-> production validation
-> accepted revision
-> showme.preview
-> narrow diagnostic repair if needed
~~~

Evaluation corpus:
- generated background shader;
- content shader;
- backdrop shader;
- CSS Effect;
- text JS;
- shader syntax error;
- invalid parameter;
- slow/infinite text JS;
- parameter preservation on update;
- transparency;
- non-square element;
- stage-timed Effect;
- continuous Effect.

Measure first-pass compile rate and repair rate.

Gate: human- and agent-authored Effects share validation/runtime behavior.

## Phase 9: deterministic timeline preview

Goal: close the loop for Motion, Presence and Effects.

Implement explicit sampling by slide ID, stage index, stage time, slide-entry state and relevant clock context. Reuse presenter/Effect runtime semantics.

Do not manipulate the live playhead just to capture output.

Verify equivalent inputs match actual presenter sampling across native Motion, Presence and Effects.

Gate: an agent can visually inspect before/after click states deterministically.

## Phase 10: incremental context

Goal: avoid rereading large scopes after every small edit.

Investigate/implement:
- semantic mutation change sets;
- optional inspect(sinceRevision);
- resource invalidation;
- current MCP subscriptions/listen only if clients benefit;
- cache hints for stable specs.

If a correct delta cannot be guaranteed, return deltaAvailable=false and recommend reinspection. Never fabricate a partial delta.

Evaluate workflows of 10-20 edits for context bytes/tokens, full reinspection count, stale-state mistakes and latency.

Gate: incremental context improves efficiency without introducing hidden state.

## Phase 11: broader ShowMe capabilities

Only after the core loop is reliable.

Candidates:
- duplicate/reparent/reorder;
- resize/rotate;
- slide create/duplicate/delete/reorder;
- templates;
- text styles;
- transitions;
- media insertion;
- notes;
- export;
- library operations.

For each addition:
1. identify a real workflow;
2. define the semantic contract;
3. add an eval task;
4. only then implement.

Do not mechanically wrap internal APIs.

## Phase 12: workflow skill/instructions

Once tools are stable, add concise agent guidance:

~~~text
current/selected intent -> context first
inspect smallest relevant scope
ordinary edit -> apply
timeline behavior -> animate
custom visual runtime -> effect
read Effect ABI before source authoring
use explicit IDs/revisions
preview after visual changes
make narrow follow-up corrections
~~~

The server must remain correct without trusting the skill.

## Evaluation program

Maintain a versioned corpus in the repo.

Categories:
- orientation;
- targeting;
- layout;
- editing;
- Motion/Presence;
- Effects;
- concurrency;
- privacy;
- visual output.

Record:
- final ShowMe state;
- success/failure;
- exact target correctness;
- unrelated mutations;
- first tool chosen;
- tool calls;
- bytes/tokens returned;
- latency;
- revision conflicts;
- lease conflicts;
- duplicate writes;
- Effect compile/runtime outcomes;
- preview parity;
- human visual-quality grade where subjective.

Final environment state matters more than the model claiming success.

## Questions Codex should challenge rather than assume

1. Is six tools better than context/inspect/apply/preview?
2. Is flat preorder always the best normal tree shape?
3. How much style information is needed for normal reasoning?
4. Does uiEpoch need every playhead update or only semantic timeline changes?
5. Should selection be an inspect target or always resolved via context first?
6. Is loopback HTTP the best internal bridge on Windows/macOS?
7. Can mcp-local actor UX be intuitive without authority changes?
8. How long should mutation replay IDs be retained?
9. Are semantic deltas cheap enough for every accepted transaction?
10. Which renderer path is the correct source for deterministic previews?

Answer these from code and experiments, not architectural preference.

## Branch workflow

Keep MCP work in branches.

This design branch is:

~~~text
chatgpt/mcp-architecture
~~~

When implementation starts, prefer a dedicated implementation branch from an updated MCP design base if that makes review cleaner.

Do not merge into main automatically.

Stop after each significant phase or coherent slice and report:
- what was learned;
- what changed;
- tests run;
- remaining uncertainty;
- whether the next phase should proceed.
