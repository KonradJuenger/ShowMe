# Phase 2 plan: ephemeral live editor context

Status: implemented, 2026-10-17. This is Phase 2 of `CODEX_PHASED_PLAN.md`.
The implementation outcome below records the added main-settings requirement.

## Outcome and gate

A caller outside React can read the active editor page, selection, editing scope,
view mode and timeline context together with accepted document identity/revisions.
`uiEpoch` distinguishes meaningful UI changes from document revision changes.

This adds a narrow renderer-to-main publication path and an application read API.
It does not add an MCP server, local HTTP bridge, screenshots, writes, agent actor,
or another document owner. UI context never enters document operations, history,
recovery, save files or browser storage.

The gate passes when deterministic tests cover normalization/lifecycle and one
focused Electron integration file verifies the real UI/preload/IPC/read path.

## Ownership verified in the current checkout

- `src/components/Editor.tsx`: current controller, `CanvasSelection` (IDs/scope),
  insertion scope and the `play` media-preview flag. Insertion scope is distinct
  from selection scope and is not needed for this phase's read contract.
- `src/components/useEditorSession.ts`: accepted snapshot, accepted revision,
  saved revision and document epoch; the displayed snapshot can contain drafts.
- `src/components/MotionWorkspace.tsx`: selected stage (`active`), cursor,
  `MotionPreviewState`, Motion-state editing and optional animation drafts.
- The workspace updates its informational playback cursor every 100 ms. Its canvas
  runtime advances independently. Publishing every cursor tick is unnecessary.
- `src/core/motionPlayback.ts`: existing preview time/clock semantics. A preview
  can use stage index -1 to represent the state before slide entry.
- The editor can load a template page. Phase 1 slide inspection deliberately accepts
  presentation slides only; context must identify templates honestly.
- `electron/main.ts`: active document and document lifecycle. Its stored
  `activeDocumentId` is not by itself proof that a renderer view is current.
- `electron/presentationRuntime.ts`: existing presenter state. Presentation and
  editor views can coexist and must not overwrite each other's context.
- `electron/ipcRouter.ts`: window/main-frame authorization. Preview, export,
  audience and console windows already have separate method allowlists.
- `src/EditorApp.tsx`: keys/remounts editors on document replacement. Its current
  `onHome` creates a new untitled presentation rather than displaying a home page.
- `src/platform/index.ts`: selects desktop or browser adapter. Desktop context
  publication must remain optional so browser editing continues to work unchanged.

## Proposed data contract

Add shared strict Zod schemas and TypeScript types in `src/core/agentContext.ts`.
This module holds data definitions and pure normalization/equality helpers only.

Conceptual renderer snapshot:

```ts
interface AgentEditorUiSnapshot {
  documentId: string;
  documentEpoch: string;
  observedRevision: number;
  page: { kind: "slide" | "template"; id: string };
  selectionScopeId: string | null;
  selectionIds: string[];
  mode: "edit" | "media-preview" | "motion-preview" | "motion-state-edit";
  timeline: {
    selectedStageIndex: number;
    stageIndex: number; // -1 is valid before slide entry
    stageId: string | null;
    stageTimeMs: number;
    running: boolean;
    sampledAtMs: number;
  } | null;
}
```

Rules:

- Document epoch prevents confusing close/reopen with an earlier incarnation of
  the same document ID. `observedRevision` is the renderer's observation, not a
  claim that its UI snapshot and a later main-process read were simultaneous.
- Page kind and ID come from the controller's actual page. Do not map a template
  to an invented slide ID. No projection or document body is published.
- Selection scope reflects `CanvasSelection.scopeId`; do not substitute insertion
  scope or silently choose a different editable layer.
- Preserve native selection order and remove duplicate IDs. Bound counts/strings
  using existing ID and document limits; reject extra fields and non-finite times.
- Selected timeline stage and displayed preview stage are separate fields.
  Closed/inapplicable timeline state is null, not a fabricated stage-zero sample.
- Mode reflects what is displayed: active Motion-state authoring takes precedence
  over Motion preview, then media preview, then ordinary editing. Do not change
  any of these existing modes to publish context.
- Timeline values may describe a local animation draft. Mark that with an explicit
  draft indicator in the implemented contract rather than claiming those stages
  exist at the accepted revision. Never publish draft tracks or element frames.

The read result contains `uiEpoch`, accepted document identity/epoch/revision/
savedRevision/dirty state, nullable editor context and a separate optional compact
presentation summary. Keep editor and presenter page/stage identities distinct.
When no valid document view has been published, editor context is null; an open
document may still be loading. Use an explicit availability value to distinguish
loading/unavailable context from a ready empty selection. Do not choose slide 1.

This is an application API. Final MCP tool names and wire schemas remain later work.

## Publication and lifecycle

Add `src/components/useAgentContextPublisher.ts` and call it once from `Editor.tsx`.
Keep React publication separate from context validation/storage. Read existing
Motion Workspace state through its returned values; only add a small read-only
workspace descriptor if that avoids exposing hook internals or duplicating time math.

Use one typed writer channel, provisionally `editorAgentContext`, with a small
allowlisted action union: attach, publish and detach. Attach returns a host-issued
ephemeral view token; subsequent messages include that token and a monotonically
increasing per-view sequence number. This token is a lifecycle guard, not a document
ID, authority actor, lease, durable protocol session or external authorization token.

- Attach is scoped to the authorized editor main frame and the active document.
  It invalidates the prior view token, including remounts of the same document.
- Publish accepts only the current token/document/epoch and a newer sequence.
  Delayed old publications and old cleanup messages cannot replace/clear a new view.
- While attach is pending, retain only the latest local snapshot. On unmount,
  cancel pending publication and detach only that view's token. Handle React
  Strict Mode setup/cleanup without leaking subscriptions or reviving old views.
- Clear/invalidate on active-document replacement, successful close/discard,
  editor navigation/reload, render-process loss and window destruction. A canceled
  close/save dialog must leave valid context intact.
- Do not route publication through the serialized save/import queue. Perform
  authorization and lifecycle ordering before any asynchronous projection reads;
  recheck the view token/generation after awaited work.
- Optional capability absence in browser mode does not create a browser context
  store and does not affect editing. Publication failures must not interrupt an
  editor command, force a flush or change editor document-error state. Handle stale
  lifecycle messages quietly; use normal bounded diagnostics for actual failures.

Store the latest view and counter in `electron/agentContext.ts`, outside React,
with injected document/projection access so it can be tested without launching
Electron. Add an application query, provisionally `agentContext()`, which the future
MCP bridge can call. Expose that read through the editor-only platform/preload API
to verify the complete path; do not expose arbitrary RPC or renderer execution.

## Freshness and uiEpoch

Maintain one monotonic `uiEpoch` for the app-process context service. Do not reset
it to zero on document switch and do not persist it across application restarts.

Increment it for effective changes to document/view identity, active page,
selection/scope, view mode, selected/displayed stage, explicit seek, play/pause/stop
and context availability. Ignore duplicate snapshots, timestamps by themselves,
ordinary document text revisions and passive playback progression.

Publish timeline context from preview anchors and discrete actions. During running
preview, do not make the 100 ms informational cursor a publisher dependency and do
not add a new timer/animation loop. Use the existing `previewTime`/`motionTime` and
schedule semantics when taking a sample; do not implement clock sampling in main.
`stageTimeMs` plus `sampledAtMs`/`running` is an observed sample, not a promise of
the exact current playback time at query delivery. On-demand live sampling can be
added later if a concrete consumer needs it.

At query/accepted-change boundaries, normalize against the current accepted
projection: remove deleted/invalid selection IDs, clear a vanished scope, and mark
a deleted/unavailable page unavailable. Never retarget to another slide or scope.
Do not include unaccepted draft-created elements as accepted selectable targets.
Normalization that changes effective UI context increments `uiEpoch` even if no
new renderer publication arrives. A revision change alone does not.

Obtain current document revisions from the existing application document-projection
route, not the renderer payload. Recheck identity/generation after asynchronous
reads; if the view changes mid-read, retry once or return unavailable rather than
combining old UI and a new document. Reuse the existing collaboration projection
route for guest reads when available; disconnected/unavailable guest state remains
explicitly unavailable. Do not create a local guest authority or enable agent writes.

Presenter context comes from existing main-owned `PresenterState`, with current
deck/slide/index, black state and existing motion sample where available. It is a
separate summary, not another editor mode or a second presenter clock. Presenter
navigation/availability affects the context epoch; elapsed time alone does not.

## Boundary and file scope

Expected new files:

- `src/core/agentContext.ts`: shared schemas and pure normalization/equality.
- `src/components/useAgentContextPublisher.ts`: narrow lifecycle-aware publisher.
- `electron/agentContext.ts`: ephemeral view ownership, normalization and reads.
- `tests/feature/editor/agentContext.test.ts`: deterministic domain/lifecycle tests.
- `tests/extended/agent-context.spec.ts`: focused Electron integration coverage.

Expected small edits: `Editor.tsx`, optionally `MotionWorkspace.tsx`,
`src/platform/api.ts`, `electron/preload.ts`, `electron/ipcRouter.ts`,
`electron/main.ts`, test registry/statistics and MCP status docs.

Require the editor main frame for both writer and read IPC. Reject audience,
console, export, preview and subframe callers; validate the strict action schema,
token, document scope and epoch at the boundary. No notes, text bodies, Effect
source, filesystem paths, DOM nodes or arbitrary React state belong in this channel.

Do not change document/authority/session schemas, lease/history behavior, browser
persistence, navigation, selection, Motion execution or renderer sampling behavior.
Phase 1's projection API remains unchanged unless an observed defect requires a
separate focused fix. Work on the current branch; no automatic commit/push/PR.

## Implementation sequence

1. Add shared contract and host service with pure normalization/lifecycle tests.
2. Add editor-only IPC authorization, strict validation and preload/platform methods.
3. Add the hook and minimal Editor/workspace publication points.
4. Wire lifecycle invalidation and compose accepted revisions/presenter summary.
5. Exercise the real Electron path and update MCP status docs with exact behavior.

## Verification

Register new unit coverage as active feature/editor; use explicit named declarations
for meaningful contracts rather than one test for every state field:

- selection/page/scope/mode changes versus duplicate publication;
- stage selection, before-entry state, seeks and play/pause versus passive clocks;
- same document revision with a changed `uiEpoch`, and changed revision with stable UI;
- deleted selections/scopes/pages and unaccepted draft IDs;
- document/template identity, replacement, close/reopen and missing projection;
- delayed attach/publish/detach, sequence ordering, read races and canceled close;
- detached results and no persisted/body/source data;
- presenter changes independent of editor selection and guest unavailability.

The small Electron file is active extended/editor with runtime `electron`. It must
verify that real editor selection/navigation reaches the read API without changing
document revision, and that invalid payloads/non-editor or subframe callers reject.
Also cover one replacement/reload lifecycle with no stale selection resurrection.
Use product UI interactions and typed reads; do not inspect React internals or DOM
nesting. Reuse existing startup/temp-user-data helpers. Do not expand release tests.

Focused PowerShell commands after implementation:

```powershell
$env:SHOWME_TEST_FILES = '["tests/feature/editor/agentContext.test.ts"]'
try { npx vitest run } finally { Remove-Item Env:SHOWME_TEST_FILES }

npm run build
$env:SHOWME_TEST_FILES = '["tests/extended/agent-context.spec.ts"]'
try { npx playwright test --config playwright.electron.config.ts }
finally { Remove-Item Env:SHOWME_TEST_FILES }
```

The build already includes typecheck; do not repeat it without a relevant change.
Lint changed TypeScript files, then run `npm run test:stats` and
`npm run test:audit`. Repeat Phase 1's focused test only if its contract/dependencies
change. No full suite, release packaging or performance benchmarks are planned.
Before any rendering-affecting commit on main, apply the repository audience-navigation
gate; this plan requests no commit and does not alter rendering semantics.

## Handoff

Report the final application API, actual publication/epoch rules, lifecycle handling,
guest/template limits, exact verification commands/results and unrun checks. Update
this plan and README if implementation changes a design assumption. Stop at the
Phase 2 gate. Phase 3 then adds production preview capture; MCP transport remains
Phase 4 in the current phased plan.

## Implementation outcome

Implemented the shared contract/normalizer, host context service and lifecycle-aware
publisher at the planned seams. Existing Motion Workspace return values were enough;
no workspace or rendering changes were needed. The application query is
`platform.agentContext()`, and `editorAgentContext()` is the strict writer action
channel. See README.md for output semantics and availability limits.

The user additionally requested an MCP control in main settings. `McpSettings.tsx`
adds a native checkbox using the existing settings section layout, with immediate
pending feedback, disabled state during saving and an actionable save error.
`getMcpEnabled`/`setMcpEnabled` and an enabled-change event synchronize the publisher
and setting. The boolean is stored in existing app settings, defaults off, and gates
both publication and reads. It does not start a server or expose a network endpoint.

Registered 11 unit and 2 Electron declarations. The Electron fixture creates its
own ShowMe root and user settings, uses production preload/IPC and exercises actual
UI selection/navigation. Rendering, document/history/recovery semantics and Phase 1
projection functions were retained. No commit, push or PR is part of this phase.

MCP and image-cache preference writers share the existing IPC settings queue so
concurrent toggles preserve both persisted values. The Electron test covers this
alongside the real checkbox, selection, timeline seek, template/slide navigation,
reload and window/subframe boundary. The rendered settings section was inspected;
the Impeccable detector reported no findings.

Completed verification:

- `SHOWME_TEST_FILES=["tests/feature/editor/agentContext.test.ts"]` with
  `npx vitest run`: all 11 passed.
- `npm run build`: passed, including typecheck, Vite and Electron bundles.
- `SHOWME_TEST_FILES=["tests/extended/agent-context.spec.ts"]` with
  `npx playwright test --config playwright.electron.config.ts`: both passed.
- `npx eslint src/core/agentContext.ts electron/agentContext.ts electron/settings.ts electron/ipcRouter.ts electron/main.ts electron/preload.ts src/platform/api.ts src/components/useAgentContextPublisher.ts src/components/McpSettings.tsx src/components/Editor.tsx src/components/editor/EditorToolbar.tsx tests/feature/editor/agentContext.test.ts tests/extended/agent-context.spec.ts`:
  no errors; one pre-existing unused `compositionWindow` warning in main.ts.
  The final queue/test additions were also linted successfully.
- `npm run test:stats`: updated (488 active tests in 79 groups).
- `npm run test:audit`: passed.
- Tracked and new-file whitespace checks: passed.

The focused commands above are expressed with their selected-file environment;
the PowerShell blocks in Verification show how to set and clear that environment.
Failed development checks were corrected at their source: pending checkbox feedback,
isolated first-run test setup and awaited frame/accessibility-based test targeting.
No retries, skipped declarations or weakened production contracts were introduced.

Full/release suites, packaging, audience-navigation tests and a real LAN-guest
session were not run. Guest unavailability and presenter composition have deterministic
unit coverage; this phase does not change presenter rendering or enable agent writes.
No commit/integration was requested. Phase 2 is complete; Phase 3 has not started.
