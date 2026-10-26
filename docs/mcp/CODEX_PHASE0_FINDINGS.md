# MCP Phase 0 findings

Date: 2026-10-13

Historical investigation report. Phase 1 was subsequently implemented on 2026-10-17;
see [README.md](./README.md#implemented-phase-1-read-projection) for the current API,
limits and next phase. The statements below describe the Phase 0 investigation.

This pass validates the MCP design against the current ShowMe repository. It is investigation only. No MCP server, transport, write tool, Agent Projection implementation, preview service, authority change or Effect-validator refactor is implemented here.

## Executive conclusion

The central architecture is valid:

```text
ShowMe document/runtime
        ↓
deterministic Agent Projection
        ↓
MCP
        ↓
external model
```

The repository already has more reusable infrastructure than the earlier design assumed. In particular, `EditorSession` is a core, transport-independent class. A future write-enabled MCP path should not build a second transaction assembler in Electron main. It should use semantic core commands and a dedicated `EditorSession` whose `EditorTransport` is bound to a distinct authority actor such as `mcp-local`.

Phase 1 can also be smaller than the current plan. One pure module, `src/core/agentProjection.ts`, plus focused tests is enough for the first useful slice. Do not add `agentContext.ts`, `agentInspection.ts` and `agentResults.ts` until a concrete need appears.

The Phase 0 gate passes: Agent Projection can be derived from existing projections and core helpers without becoming another source of truth.

## A. Current ownership map

### Durable document and persistence

```text
electron/storage.ts
  Storage.host()
    -> new DocumentRuntime(document, { actorId: "local", durableCommit })

src/core/documentRuntime.ts
  DocumentRuntime
    -> exactly one DocumentAuthority

src/core/documentAuthority.ts
  DocumentAuthority.commit()
    -> validate transaction, leases and stale guards
    -> apply validated DocumentOperation[]
    -> derive inverseOperations
    -> recordAcceptedImpact()
    -> durableCommit(accepted, candidate)
       electron/storage.ts -> RecoveryJournal.append()
    -> publish candidate + accepted revision

explicit Save
  electron/storage.ts Storage.saveDocument()
    -> authority.runExclusive()
    -> serialize current authority snapshot
    -> atomicWrite()
    -> markSaved(revision)
```

The recovery journal is the durable transaction path for accepted unsaved edits. Saving the `.sme` file is a later snapshot operation. MCP writes must therefore enter the authority path, never write the file.

Browser mode follows the same conceptual boundary through the browser `DocumentRuntime` in `src/platform/browser.ts`.

### Editing

```text
React editor
  -> useEditorSession()
  -> EditorSession
  -> pure semantic command in src/core/editorCommands.ts / related core modules
  -> EditorChange carrying DocumentOperation[]
  -> EditorSession.apply()
  -> scopesForOperations()
  -> lease acquire
  -> DocumentTransaction
  -> EditorTransport
  -> DocumentRuntime
  -> DocumentAuthority
```

Key owners:

- `src/core/editorSession.ts`: queued intent execution, lease lifetime, transaction creation, accepted-transaction replica updates, stale/conflict recovery, actor-scoped history calls.
- `src/core/editorChange.ts`: attaches/coalesces `DocumentOperation[]` to an `EditorSnapshot`.
- `src/core/editorCommands.ts`: most semantic element/page edits.
- `src/platform/editorTransport.ts`: maps platform document methods into the core `EditorTransport` interface.
- `src/core/documentOperations.ts`: canonical operation schema/application.
- `src/core/documentAuthority.ts`: authoritative acceptance, leases, revision sequence and history.

A persistent mutation passed to `EditorSession.apply()` without `DocumentOperation[]` is explicitly rejected.

### UI context

There is no single current editor-context owner.

- Active document: Electron main owns `activeDocumentId` in `electron/main.ts`; the renderer also receives the document ID.
- Active editor slide: the loaded `EditorSession` projection, `controller.snapshot.slide.id`. It is not persistent deck state.
- Selection IDs and scope: React state in `src/components/Editor.tsx`; `EditorCanvasSurface` can own an internal selection when uncontrolled.
- Insertion scope: React state in `Editor.tsx`.
- Click Timeline selected stage, cursor and preview time: `useMotionWorkspace()` in `src/components/MotionWorkspace.tsx`.
- `MotionPreviewState`: explicitly renderer-local in `src/core/motionPlayback.ts`.
- Media preview/edit mode: renderer state in `Editor.tsx` / `EditorCanvas.tsx`.
- Running presentation state: `PresentationRuntime` in `electron/presentationRuntime.ts`, represented by `PresenterState` from `src/platform/api.ts`.
- Presentation navigation/timing semantics: `src/core/presentationSession.ts`.

Electron main therefore knows the active document and presenter state, but not the editor selection/scope or Click Timeline preview state.

### Rendering

Important production surfaces converge on `src/components/SlideRenderer.tsx`:

- editor canvas: `src/components/EditorCanvas.tsx`;
- audience output: `src/components/AudienceOutput.tsx`;
- presenter previews;
- isolated capture: `src/components/SlidePreviewPage.tsx`;
- PDF export;
- Effect preview/test harnesses.

`SlideRenderer` resolves template composition with `resolveVisualSlide()`, mounts Effects through the production Effect runtime, and drives Motion/Presence through `useMotionRuntime()`.

The editor adds selection/guides/text/frame overlays outside `SlideRenderer`. Those overlays are not audience output and should not be model screenshot input.

### Motion and Presence

- schema/semantic model: `src/core/motionModel.ts`;
- semantic sampling/property resolution: `src/core/motion.ts`;
- Presence sampling: `src/core/presence.ts`;
- renderer-local preview transport: `src/core/motionPlayback.ts`;
- DOM execution: `src/components/motionRuntime.ts`;
- React lifecycle and Effect clocks: `src/components/useMotionRuntime.ts`.

MCP needs no separate Motion or Presence runtime.

### Effects

- schemas, parameter metadata, timing, semantic invariants: `src/core/effects.ts`;
- authoring boilerplate/context: `src/core/effectAuthoring.ts`;
- document persistence semantics: `setElementEffectDefinition()` in `src/core/editorCommands.ts`;
- library envelope/editing: `src/core/libraryEffects.ts` plus existing platform/Electron storage;
- WebGL compile/link and CSS parse/scope/runtime: `src/components/effectRuntime.ts`;
- text-JS worker: `src/components/textEffectRunner.ts`;
- current human validation orchestration: local `validateCode()` plus preview readiness checks in `src/components/EffectEditor.tsx`.

### Collaboration

The host uses the same authority.

- `electron/collaboration/host.ts` calls `DocumentRuntime.commitForActor()`, `acquireForActor()`, etc. for remote actors.
- `src/core/collaboration/clientReplica.ts` explicitly describes its full-document copy as a transport cache. It applies accepted transactions but is not another accepting authority.
- the host `DocumentAuthority` remains the sole acceptance point.

## B. Answers to the Phase 0 questions

### 1. Where should a read-only Agent Projection live?

In core as a pure derived adapter:

```text
src/core/agentProjection.ts
```

Input should be an existing `DocumentProjection` plus projection options. Optional live context should be passed as plain data, never imported from React or Electron.

Dependencies should stay in core: document/template/scene/text/Motion/Presence/Effect metadata helpers. It should not depend on `EditorSession`, `DocumentAuthority`, React, DOM, platform APIs, Electron or the production Effect renderer.

### 2. Which helpers already calculate world bounds?

`src/core/scene.ts` already owns the transform chain:

- `getWorldMatrix()`;
- `getLocalMatrix()`;
- `getWorldBounds()`;
- `worldPointToScope()`;
- `frameFromWorldMatrix()`;
- `getParentId()`;
- `getOwningLayer()`;
- `flattenSubtree()` / `flattenElements()`.

`src/core/selectionGeometry.ts` provides selection-oriented world geometry and scope transforms.

No MCP transform implementation is justified.

### 3. Can those helpers be reused outside React?

Yes. They are pure core functions. Projection should run them over the same visual page production rendering uses. For template-derived slides that means calling `resolveVisualSlide()` first.

`resolveVisualSlide()` already returns both the resolved slide and a `sources` map marking each element as `"template"` or `"slide"`. Agent Projection should preserve that ownership so a model does not try to edit inherited template content as slide-local content.

### 4. Where exactly do active slide, selection, stage and time live?

- active editor slide: current `EditorSession` projection, `controller.snapshot.slide.id`;
- selection IDs/scope: React state in `Editor.tsx` / controlled `EditorCanvasSurface`;
- Click Timeline selected stage, cursor and preview: `useMotionWorkspace()`;
- exact current preview time: `MotionPreviewState` sampled through `previewTime()`;
- presenter slide/stage/time: `PresenterState` owned by `PresentationRuntime`.

These are deliberately not persistent document fields.

### 5. Does Electron main already know enough to answer context?

No. It knows active document and presenter state and owns every `DocumentRuntime`, but does not know editor selection/scope or Motion Workspace cursor/preview state.

A future context endpoint needs one narrow renderer-to-main publication path. It must not expose arbitrary renderer state.

### 6. What minimal ephemeral renderer-to-main bridge is required?

Eventually publish one typed snapshot, for example:

```ts
type EditorLiveContext = {
  documentId: string;
  activeSlideId: string;
  selectionIds: string[];
  selectionScopeId: string | null;
  mode: "edit" | "preview";
  stageIndex: number | null;
  stageTimeMs: number | null;
};
```

Electron main can store the latest snapshot and increment a local `uiEpoch` when the semantic snapshot changes.

Do not increment `uiEpoch` on every animation frame. Increment on discrete context changes and explicit seeks. A caller needing exact running time can request a current sample.

Presenter context should be composed from existing main-owned `PresenterState`.

### 7. Can preview capture accept deterministic slide/stage/time now?

Not through the current capture API.

`electron/main.ts` `capturePreview(projection, width, height)` uses isolated `SlidePreviewPage`, verifies render-projection revision, waits for readiness, then uses Electron `capturePage()`.

`SlidePreviewPage.tsx` currently renders `SlideRenderer` without `motionState` or explicit `effectClock`, so it captures static/base state.

The renderer already supports deterministic sampling. `SlideRenderer` accepts `motionState` and `effectClock`, and `tests/helpers/renderSamplingHarness.tsx` already feeds it a paused explicit stage/time. `useMotionRuntime()` then samples Motion, Presence and Effects from that state.

Future deterministic capture can therefore extend the isolated preview request. It does not need to manipulate the live editor playhead.

### 8. How does current preview differ from presenter/audience rendering?

The visual component is shared. State/environment differ:

- isolated `SlidePreviewPage`: static video, explicit output size, prepared images, no Motion state today;
- editor: `SlideRenderer` plus editor overlays, optional renderer-local `MotionPreviewState`, editor media playback flags;
- audience/presenter: `SlideRenderer` driven by `PresenterState` and presenter Effect clock origins.

Model screenshots should reuse isolated production rendering with explicit sample state, not capture the editor DOM and not create an MCP renderer.

### 9. What accepted transaction information can support semantic deltas?

`AcceptedTransaction` contains:

- transaction ID;
- document ID;
- epoch;
- actor ID;
- accepted revision;
- accepted `DocumentOperation[]`;
- `inverseOperations`;
- optional history group ID.

This supports cheap deltas:

- changed element IDs from targeted element operations;
- created/deleted IDs from insert/remove/replace;
- changed slide IDs and deck-level changes;
- before values from inverse operations for many operations;
- after values from accepted operations;
- transaction identity and accepted revision.

`src/core/documentImpact.ts` also derives visual/dependency/media/slide impact and is recorded at acceptance. It is useful for invalidation but too coarse for model-facing semantic deltas.

Recommended future hierarchy:

1. generic accepted delta from `operations + inverseOperations`;
2. request-level semantic intent in direct tool response when available;
3. before/after Agent Projection diff only when a richer explanation is needed.

One factual nuance: `DocumentAuthority` can accept a stale `baseRevision` when operation guards prove affected state did not change. A future MCP `expectedRevision` check may deliberately be stricter. That is MCP policy, not current authority behavior.

### 10. What breaks if actor `mcp-local` commits while the local editor is open?

A distinct actor is the safe choice.

`DocumentAuthority.acquire()` ignores conflicts from the same actor and replaces an existing same-actor lease for the same exact scope. A second session using actor `local` can therefore replace the human editor's lease and bypass intended simultaneous-editor conflict behavior.

With `mcp-local`:

- same or ancestor/descendant element scopes conflict correctly;
- unrelated element scopes can proceed when calculated scopes do not conflict;
- different slides are generally independent;
- slide-wide scopes conflict with other actors on that slide;
- LAN actors and MCP share the same authority conflict rules.

History is actor-scoped. Human Ctrl+Z targets the newest non-undone `local` history entry, not the chronologically newest accepted transaction. Therefore:

- Ctrl+Z does not undo an `mcp-local` edit;
- it may undo an older human edit if later MCP edits did not invalidate its guards;
- if later MCP edits touched guarded state, human undo rejects as unsafe instead of crossing the agent edit.

Do not solve this by reusing actor `local`.

A remaining collaboration issue is where local MCP attaches when this app instance is a LAN guest. The host is the accepting authority. Specify that before write-enabled MCP, not in Phase 1.

### 11. Which semantic editor commands require renderer-only services?

| Future operation | Existing seam | Caveat |
| --- | --- | --- |
| `text.set` | `updateText()` in `src/core/text.ts` | auto-sized text needs renderer text measurement for visual parity |
| `elements.move` | `translateElements()` | core scene transforms already handle scope/world conversion |
| `elements.frame.set` | `setElementFrames()` | replacement semantics |
| `elements.appearance.patch` | merge current appearance, then `setElementAppearances()` | current command replaces appearance |
| `element.insert_text` | `insertText()` | insertion is core-safe; autosize after exact text needs measurement |
| `element.insert_shape` | `createBasicShape()` + `insertElements()` / insertion helpers | resolve editable scope and initial frame semantically |
| `elements.remove` | `removeElements()` | core-safe |
| reparent/reorder | `reparentElements()`, `reorderElements()` | core-safe; Motion guards already live in core |
| Effect update | `setElementEffectDefinition()` | executable Effect validation is renderer-side |

Human text editing currently reaches DOM/font measurement through the editor text-layout path. Agent code should not create a second metrics engine.

### 12. Which Effect validation steps are core-safe and which require DOM/WebGL/Worker?

Core-safe:

- `effectDefinitionSchema`;
- `effectAuthoringDiagnostics()`;
- shader parameter scan/reconciliation metadata;
- `validateEffects()` resource/instance/placement/parameter invariants;
- Effect timing/schedule semantics.

Renderer/environment-dependent:

- GLSL compile/link and uniform validation: `shaderProgram()` in `src/components/effectRuntime.ts`;
- CSS parsing/scoping/keyframe rewrite: `compileEffectCss()`;
- text-JS startup/execution validation: `createTextEffectRunner()`;
- full preview readiness/runtime diagnostics: `EffectEditor` currently waits for production preview nodes/surfaces.

The future shared seam should extract the orchestration now local to `EffectEditor.tsx`, then have both human and agent authoring invoke the same production primitives.

## C. Recommended Agent Projection seam

### Module boundary

Start with only:

```text
src/core/agentProjection.ts
```

Conceptual API:

```ts
agentProjection(
  projection: DocumentProjection,
  options: AgentProjectionOptions
): AgentProjection
```

The module must not fetch documents or UI state itself.

### Dependencies

Reuse:

- `DocumentProjection`;
- `resolveVisualSlide()`;
- `flattenSubtree()`, `getParentId()`, `getOwningLayer()`, `getWorldBounds()`, `getWorldMatrix()`;
- text style/typography resolution;
- Motion/Presence model helpers for summaries;
- Effect metadata only.

### Visual tree and ownership

Normal slide inspection should describe the resolved visual composition because that is what the renderer displays. Use `resolveVisualSlide().sources` to annotate each element as slide-owned or template-owned. Include the template ID in slide context.

### Geometry and order

Use `worldBounds` as compact geometry. It is the axis-aligned world-space bounding box produced by production scene math.

Do not expose a vague scalar `z`. ShowMe's real ordering is layer order plus nested sibling order. Prefer:

- `layerId`;
- `layerIndex`;
- `parentId`;
- `siblingIndex`;
- deterministic preorder / paint-path information.

For rotated elements, extended detail may add world transform or four corners derived from `getWorldMatrix()`.

### Text and styles

Default text should be bounded preview plus character count. Exact text is on-demand.

Text styles have real persistent IDs in `deck.textStyles`; expose those references. Do not invent persistent-looking style IDs for arbitrary inline appearance. A projection-local deduplication dictionary is acceptable only if clearly marked as encoding.

`deck.stylesheet` can affect actual rendering and can be up to 100 kB. Normal context should report presence/hash/summary. Exact source belongs on-demand.

### Effects, Motion and Presence

Effect source belongs on-demand. Normal projection should include resource/instance IDs, kind, target/input, placement, enabled state, parameter values and timing summary.

Motion/Presence should be semantic summaries in normal context. Native tracks remain on-demand for exact animation editing/debugging.

## D. Live context seam

Keep live editor context separate from document revision.

```text
Editor.tsx / MotionWorkspace
  -> one typed EditorLiveContext publisher
  -> Electron main stores latest snapshot + uiEpoch

DocumentRuntime
  -> revision / document projection

PresentationRuntime
  -> PresenterState

context query
  -> composes the read-only sources
```

Do not persist `uiEpoch`, selection, stage, playhead or mode.

Active slide should come from live editor context because `DocumentRuntime` does not own "currently viewed slide". Presenter mode can use `PresenterState`.

## E. Preview seam

Correct production path:

```text
DocumentRuntime.renderProjection()
  -> isolated SlidePreviewPage
  -> SlideRenderer
  -> useMotionRuntime
  -> Motion + Presence + Effect production runtime
  -> wait for images/fonts/effects
  -> Electron capturePage()
  -> PNG
```

Reusable now:

- `renderProjection()`;
- isolated hidden preview window;
- `SlideRenderer`;
- prepared images and managed fonts;
- image/font readiness;
- `flushEffectSurfaces()`;
- Electron `capturePage()`;
- explicit paused `MotionPreviewState` sampling already exercised by tests.

Requires later refactor:

- explicit render-sample request;
- paused `MotionPreviewState` from `stageIndex + stageTime`;
- defined Effect clock origins for presentation-relative Effects;
- slide index/count/previous-slide seed when those uniforms are expected;
- deterministic video-frame policy.

No live playhead manipulation is required.

## F. Mutation seam

Future model-facing writes should remain semantic. Do not expose `DocumentOperation` as the normal API.

Repository inspection changes the preferred execution shape to:

```text
semantic agent request
  -> existing pure core editor command
  -> EditorChange / DocumentOperation[]
  -> dedicated EditorSession for actor mcp-local
  -> actor-scoped EditorTransport
  -> DocumentRuntime.*ForActor()
  -> DocumentAuthority
```

This preserves the same lease derivation, transaction assembly, accepted-replica handling, failure recovery and history machinery as the human editor while staying outside React.

The actor-scoped transport does not exist yet, but `DocumentRuntime` already has the required actor-specific commit/lease/history methods and accepted subscriptions.

Do not build a host adapter that manually recreates `EditorSession.commitOperations()`.

Renderer-dependent text measurement and Effect validation should be explicit shared services around this path.

## G. Actor / undo conclusion

Use a separate authority actor such as `mcp-local`.

Do not use actor `local` for a second MCP session. Same-actor lease acquisition can replace the human lease for the same scope and intentionally ignores same-actor conflicts.

Do not change authority semantics for MCP.

Before write-enabled release choose a UX policy:

1. human Ctrl+Z remains human-only and UI exposes "Undo agent edit";
2. guarded revert of a specific accepted agent transaction;
3. later redesign history ownership separately from lease identity.

Option 1 is the smallest and matches current semantics.

## H. Effect validation seam

Eventually add one shared renderer-side validation service, for example:

```text
src/components/effectValidation.ts
```

It should orchestrate existing production primitives:

```text
effectDefinitionSchema
effectAuthoringDiagnostics
  -> shaderProgram OR compileEffectCss OR createTextEffectRunner
  -> optional isolated production preview readiness check
```

Then `EffectEditor.tsx` and future agent Effect authoring use the same service. Persistence remains `setElementEffectDefinition()`; library storage remains the existing library path.

Do not move WebGL/CSSStyleSheet/Worker checks into core.

## I. Risks and architectural corrections

### Corrected

1. **Future host-side writes should not bypass `EditorSession`.** Earlier docs preferred a host-side adapter that directly committed through `DocumentRuntime`. Because `EditorSession` is already core and transport-independent, use a dedicated actor-scoped session.
2. **Authority revision handling is not strict equality.** It can accept stale base revisions when operation guards match. Strict MCP `expectedRevision` remains a sensible higher-level policy.
3. **Template element ownership is already available.** `resolveVisualSlide()` returns a source map.
4. **Preview capture is not stage/time capable yet, but the renderer is.** Missing work is request/state plumbing, not a renderer/runtime.
5. **`documentImpact` is not the semantic delta system.** It is advisory invalidation. Accepted operations plus inverse operations are the better future basis.

### Incomplete assumptions

- `worldBounds` is a useful default AABB, but insufficient for exact rotated orientation.
- flat preorder needs parent/layer/source ownership fields.
- a scalar `z` is not a native ShowMe concept; layer and nested sibling order are.
- style dictionaries fit real text styles, not all inline appearance.
- `uiEpoch` must not tick per animation frame.
- presentation-relative Effects require defined logical clock inputs for deterministic screenshots.
- LAN guest + local MCP write ownership is unresolved.
- auto-sized text parity requires renderer measurement.
- source validation and full Effect preview validation are separate checks.

### Overengineered or premature

- four Phase 1 modules before one projection API exists;
- four universal detail levels as hard architecture;
- semantic before/after projection diffs for every accepted transaction;
- subscriptions in the first read-only slice;
- transport before ShowMe can describe itself correctly;
- any MCP-specific renderer/runtime/editor state machine.

Prefer compact projection plus scoped exact options. Add named presets only when measured payloads justify them.

## J. Phase 1 recommendation

### Smallest implementation

Add only:

```text
src/core/agentProjection.ts
tests/core/agentProjection.test.ts
```

Do not modify Electron, platform APIs, React components, `DocumentAuthority`, `EditorSession` or Effect runtime in Phase 1.

### First API surface

Implement pure functions for:

1. deck outline;
2. one slide visual outline;
3. scoped element detail.

Input is `DocumentProjection`. The caller chooses the slide through existing `DocumentRuntime.projection(documentId, slideId)`.

Normal slide fields should include stable ID, source owner, parent/layer info, depth/sibling order, name/type, bounded text preview, `worldBounds`, actual text-style reference, Effect summary/count, Motion/Presence flags, child count and relevant layer lock/visibility state.

Scoped detail may add exact text, local frame, appearance, geometry, media metadata, Effect instances and optional world transform/corners.

### Reuse

- `resolveVisualSlide()` and `sources`;
- `flattenSubtree()`;
- `getWorldBounds()`, `getWorldMatrix()`, `getParentId()`, `getOwningLayer()`;
- deck layer order;
- text typography/style helpers;
- Motion/Presence/Effect metadata helpers.

### Initial tests

One focused test file should cover:

- deterministic ordering/output;
- nested container with rotation and world bounds;
- multiple layers and sibling order;
- hidden/locked metadata;
- text preview truncation vs exact text;
- real text-style references;
- media metadata without bytes/paths;
- Effect summary without source;
- Motion/Presence summary without raw tracks;
- template-derived element ownership;
- bounded output with long text/Effect source.

No renderer or Electron tests are needed in Phase 1.

### Deliberately defer

- live selection/context and `uiEpoch`;
- screenshots;
- MCP helper/server and transport;
- write tools and actor-scoped MCP session;
- revision deltas;
- Effect validation extraction;
- text measurement;
- Resource URIs/subscriptions;
- LAN guest writes.

## MCP MVP on top of the current architecture

Do not add an MCP architecture parallel to ShowMe. Build a thin vertical adapter in this order:

```text
1. Pure Agent Projection
2. Tiny live-context publisher
3. Extend existing isolated preview capture with explicit sample state
4. One dedicated mcp-local EditorSession + actor transport
5. A small semantic apply surface
6. Thin local bridge
7. Thin MCP stdio helper that only translates MCP <-> ShowMe RPC
```

For the first useful write-enabled MVP, keep the model-facing surface to context, inspect, preview, and apply with text/set, move, frame, appearance, insert text/shape and remove. Add Effect source get/set only after shared validation exists.

Defer animation authoring, semantic deltas, subscriptions, rich Resources, LAN-guest writes and generalized Effect tooling until the read/edit/preview loop is proven.

Most of the difficult architecture already exists inside ShowMe. MCP should add projections and narrow adapters around it, not another application layer.
