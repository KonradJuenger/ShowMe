# MCP integration architecture

This document maps the proposed MCP onto the current ShowMe codebase.

## Architectural invariant

Persistent MCP edits must follow the same authority path as every other current edit.

The repo already states the invariant in `AGENTS.md`:

```text
Editor -> EditorSession -> DocumentOperation[] -> DocumentTransaction
       -> DocumentAuthority -> durable recovery -> accepted revision
```

The MCP integration must not weaken that boundary.

## Relevant current seams

### Document ownership

`src/core/documentRuntime.ts`

`DocumentRuntime` wraps exactly one `DocumentAuthority` and already exposes:

- projection;
- render projection;
- commit;
- actor-specific commit;
- lease acquire/renew/release;
- actor-specific undo/redo;
- actor-specific history state;
- accepted transaction subscription;
- current revision.

This is the canonical host-side document boundary.

### Editor transaction assembly

`src/core/editorSession.ts`

`EditorSession` already handles:

- projection installation;
- draft versus accepted state;
- semantic operation collection;
- automatic scope derivation;
- lease acquisition;
- queued commits;
- stale/revision recovery;
- accepted transaction application;
- undo/redo state.

It is not necessary to recreate these semantics in MCP code.

### Semantic editing commands

`src/core/editorCommands.ts`
`src/core/text.ts`
`src/core/motion.ts`
`src/core/presence.ts`
`src/core/textStyleCommands.ts`
`src/core/templateCommands.ts`

These are the correct building blocks for an agent adapter.

The MCP should not directly construct low-level replacement documents when a canonical semantic command exists.

### Effects

`src/core/effectAuthoring.ts`

Already owns:

- blank Effect definitions;
- Effect family/affects conversion;
- shader boilerplate;
- prompt/ABI generation.

`src/core/effects.ts`

Already owns:

- Effect schemas;
- parameters;
- reconciliation;
- diagnostics;
- timing dependencies.

`src/components/EffectEditor.tsx`

Currently owns production validation logic that should be extracted for reuse:

- GLSL compile;
- CSS compile;
- text-JS worker execution;
- preview readiness check.

`src/core/editorCommands.ts::setElementEffectDefinition`

Already owns persistence semantics for applying/replacing an Effect, preserving compatible instance parameters, cleaning old resources and adding required click-timeline bindings.

### Rendering

`src/platform/api.ts` already exposes:

- `renderProjection`;
- `capturePreview`;
- thumbnails;
- prepared images;
- presenter state.

The MCP preview should reuse the production renderer rather than create a second scene renderer.

## Process architecture

Recommended local first release:

```text
MCP client
   |
   | stdio
   v
showme-mcp helper process
   |
   | authenticated local RPC
   v
Electron main
   |
   +--------------------+
   |                    |
   | document reads     | editor UI context
   |                    |
   v                    v
DocumentRuntime      editor renderer
   |                    |
   +---------+----------+
             |
             v
         execution
             |
             v
      DocumentAuthority
```

Why a helper process:

- stdio is natural for local MCP clients;
- the MCP client owns the helper lifecycle;
- ShowMe remains a normal desktop application;
- protocol dependencies do not have to leak through the renderer;
- a future Streamable HTTP endpoint can reuse the same tool handlers.

Why the helper must connect to the running app:

- unsaved accepted document state lives in ShowMe;
- current selection lives in the editor;
- collaboration/leases live in the running authority;
- render state and managed media/fonts belong to the running application.

Reading the `.sme` file directly would miss all of this.

## Local bridge

Do not confuse MCP transport with ShowMe's internal bridge.

The MCP helper can use stdio outward and a private local RPC inward.

Recommended properties:

- loopback or OS-local only;
- random per-install or per-run bearer secret;
- explicit protocol version;
- request/response;
- no arbitrary method invocation;
- fixed allowlist of MCP bridge commands;
- bounded request sizes;
- connection descriptor stored in the user's application data;
- clear stale-PID/stale-token handling.

Possible first implementation:

```json
{
  "version": 1,
  "pid": 1234,
  "port": 43127,
  "token": "<random secret>"
}
```

The ShowMe app binds only to `127.0.0.1` on a random port and writes the descriptor with user-only file permissions where the OS allows it.

The helper reads the descriptor and authenticates every request.

If a loopback HTTP bridge is used:

- validate `Host`;
- reject non-loopback connections;
- reject browser origins;
- do not enable permissive CORS;
- protect against DNS rebinding;
- never expose the bearer token to presentation content or Effect code.

A named pipe/Unix socket with strong per-user ACLs is also reasonable, but a small authenticated loopback bridge is simpler to implement consistently on Windows and macOS.

This bridge is private implementation detail and is not the public MCP API.

## Editor context bridge

Current selection and editing scope live in renderer state.

Add a narrow ephemeral context channel:

```ts
interface EditorAgentContext {
  documentId: string;
  slideId: string | null;
  selectionScopeId: string | null;
  selectionIds: string[];
  updatedAt: number;
}
```

The renderer publishes changes to Electron main.

Main stores only the latest context for the active editor window.

Rules:

- no persistence;
- no document authority;
- no hidden mutation;
- context updates can be coalesced;
- IDs are authoritative only at the instant read;
- writes resolve to explicit IDs before commit.

Do not expose React component internals, DOM nodes or arbitrary renderer execution to the MCP helper.

## Execution location

Repository inspection removes the need to choose between a host-side transaction assembler and routing every write through the live React editor. `EditorSession` is already a core, transport-independent class.

The preferred future write path is:

```text
semantic MCP operation
  -> existing core editor command
  -> EditorChange / DocumentOperation[]
  -> dedicated EditorSession
  -> actor-scoped EditorTransport
  -> DocumentRuntime.*ForActor()
  -> DocumentAuthority
```

The dedicated session can live outside React and use actor `mcp-local`. This preserves `EditorSession` lease derivation, queued commits, stale/conflict recovery, accepted-replica handling and history semantics without sharing the human editor's actor or component lifetime.

The actor-scoped transport is a small adapter still to be implemented. `DocumentRuntime` already exposes the required actor-specific commit/lease/history methods and accepted-transaction subscription.

Renderer-only services such as text measurement and executable Effect validation should be called explicitly where needed. They are not a reason to route all writes through the live editor.

Do not build a second transaction assembler that recreates `EditorSession.commitOperations()`.

Do not create a second independent `EditorSession` with actor `local`. `DocumentAuthority.acquire()` ignores conflicts from the same actor and replaces same-actor leases for the same scope. That can interfere with an active editor interaction.

## Actor model

Recommended safe baseline:

```text
human editor actor: local
MCP actor:          mcp-local
LAN peer:           existing remote actor IDs
```

Benefits:

- MCP conflicts with active human leases rather than stealing them;
- MCP history is attributable and reversible;
- agent actions behave like collaborative edits.

Cost:

- current Ctrl+Z is actor-scoped, so local Ctrl+Z will not automatically undo `mcp-local` history.

This must be treated as a product decision, not hidden in infrastructure.

Potential options before release:

1. keep separate actor and expose "Undo agent edit" in UI;
2. add a guarded transaction-revert affordance for accepted agent transactions;
3. refactor authority identity so lease identity and local undo ownership can differ;
4. route execution through the existing local EditorSession instead.

Do not compromise lease correctness merely to get Ctrl+Z for free.

## Revision and stale-state handling

MCP is stateless at the protocol level. ShowMe also benefits from explicit optimistic concurrency.

Every mutation takes:

```text
documentId
expectedRevision
stable slide/element IDs
```

Flow:

```text
inspect revision 41
  -> formulate semantic edit
  -> showme_apply(expectedRevision=41)
  -> if current revision == 41: execute
  -> else: REVISION_CONFLICT
```

This is a deliberately strict MCP policy. The underlying `DocumentAuthority` is more permissive: a stale `baseRevision` can still be accepted when operation guards prove the affected state is unchanged. MCP should not silently use that guarded stale-acceptance behavior for model-authored semantic intent.

Do not silently rebase semantic intent onto unknown changes.

The agent can re-inspect the affected scope and retry.

## Atomicity

One MCP `showme_apply` call should normally produce one coherent transaction.

Example:

```text
"Change the headline, move it down 40 px and make it red."
```

Internal sequence:

```text
snapshot
 -> updateText(...)
 -> translateElements(...)
 -> setElementAppearances(...)
 -> accumulated EditorChange operations
 -> one commit
```

If any semantic step is invalid before commit, commit nothing.

If authority rejects the transaction, report the rejection and accepted current revision.

## Effect validation boundary

Refactor the code currently inside `EffectEditor.tsx::validateCode` into a reusable module.

Desired API shape:

```ts
interface EffectValidationContext {
  sampleText?: string;
  previewElement?: Element;
}

interface EffectValidationResult {
  definition: EffectDefinition;
  diagnostics: EffectDiagnostic[];
}

async function validateEffectDefinition(
  definition: EffectDefinition,
  context?: EffectValidationContext,
): Promise<EffectValidationResult>;
```

Responsibilities:

1. parse `effectDefinitionSchema`;
2. run `effectAuthoringDiagnostics`;
3. compile GLSL using production shader compilation;
4. compile scoped CSS using production compiler;
5. run text JS in the production isolated worker;
6. optionally run actual preview readiness.

Do not implement a Node-only fake GLSL validator with different behavior from Electron/WebGL.

## Render boundary

The MCP needs an actual image, not just `DocumentProjection`.

A render service should accept explicit presentation state and return a PNG.

Initial:

```text
render static slide at revision R
```

Then:

```text
render slide S
stageIndex N
stageTime T
previewMode=true
```

Eventually support:

- transition state;
- slide-entry state;
- effect clocks;
- deterministic previous-slide context.

The same inputs should be usable for tests and export diagnostics.

## Security boundary

The MCP can mutate local presentation documents. Treat it as privileged.

Rules:

- local bridge disabled unless MCP integration is enabled;
- local-only bind;
- authenticated helper;
- no arbitrary filesystem paths in generic edit tools;
- no arbitrary Electron IPC forwarding;
- no arbitrary JS execution tool;
- all Effect code still passes normal Effect sandbox/runtime restrictions;
- validate every bridge payload with Zod at the boundary;
- cap operation counts and source sizes;
- preserve current asset and document path guards;
- return structured errors, not stack traces;
- do not send notes or private document content unless the tool request asks for it.

For a future remote MCP:

- use Streamable HTTP;
- use proper MCP authorization/OAuth resource-server behavior;
- scope users to their documents;
- do not reuse the local bridge token model.

## Observability

Use normal application diagnostics, not a bespoke model-facing log firehose.

Capture internally:

- tool name;
- request ID;
- document ID;
- revision before/after;
- duration;
- operation count;
- validation outcome;
- render duration;
- error code.

Do not log full presentation text or Effect source by default.

The current MCP specification deprecates new use of MCP Logging. Prefer stderr for the stdio helper and normal structured application telemetry for diagnostics.

## Failure philosophy

A world-class creative MCP should fail narrowly.

Examples:

- bad Effect source does not mutate the slide;
- stale revision does not "try anyway";
- lease denial does not steal the human's scope;
- missing media still allows inspection and returns a warning;
- render failure does not roll back an already accepted edit, but clearly reports that visual verification failed;
- unsupported semantic operation returns `UNSUPPORTED_OPERATION`, not a generic internal exception.

## Future remote mode

Do not design remote hosting into the first implementation, but preserve the semantic contract.

A future architecture could be:

```text
remote MCP
   -> authenticated ShowMe account/service
   -> explicit document handle
   -> synchronized ShowMe document authority
```

That is a separate product problem.

The local MCP should not be burdened with cloud infrastructure before the editing contract is proven.

## Current MCP performance model

The persistent stdio helper keeps the last verified ShowMe bridge descriptor in
memory and uses a keep-alive HTTP agent for loopback requests. The first request
discovers and verifies the running instance. Ordinary later requests go directly
to that instance without rescanning descriptor files or probing `showme.context`.

Every request still carries the bearer token and validates ShowMe's instance
headers. A closed connection, wrong instance response, authorization/access
generation change, stale process or stale descriptor clears the cache. The helper
then rediscovers and retries once. Disabling MCP remains authoritative because the
app closes all bridge connections, removes the descriptor and rotates both
instance identity and token when MCP is enabled again.

This is intentionally still loopback HTTP. Persistent HTTP removes the avoidable
hot-path work without introducing a second transport.

## Renderer services

Renderer-dependent agent work is split into two logical services while reusing
ShowMe's production renderer code:

```text
Agent Runtime
  -> production text measurement
  -> GLSL validation
  -> CSS Effect validation
  -> text-JS Effect validation

Slide Preview
  -> production slide composition
  -> native raster capture
  -> PNG encoding
```

The Agent Runtime owns a small persistent hidden Chromium surface with
`backgroundThrottling: false`. It has its own bounded queue, is created lazily,
is reused across requests and is recreated once after destruction/runtime failure.
Effect source is still accepted only after production validation.

Slide Preview keeps its separate production capture surface and queue. Full PNG
capture remains intentionally expensive and does not block ordinary text
measurement or Effect validation.

## Model-facing animation semantics

Presence owns element lifecycle:

```text
absent -> entering -> present -> exiting -> absent
```

Use Presence for enter/exit visibility and entrance/exit movement. Use Motion for
property animation while the element is present. Do not add a Move Motion preset
merely to reproduce a move Presence entrance.

Motion and Presence expose the same model-facing named easing vocabulary:
`Linear`, `Ease In`, `Ease Out`, `Ease In Out`, and `Hold`. The MCP
semantic layer translates those names to ShowMe's canonical internal easing values.
Presence may also accept an explicit cubic-bezier tuple where a custom curve is
needed.

## Composite construction

Composite visual objects should use ShowMe's existing Frame/group structure, not
MCP-only component primitives:

```text
Frame/group
  -> background
  -> icon
  -> title
  -> body
```

Create the parent with a stable ID, insert children using that ID as `parentId`,
author child frames in parent-local coordinates, and apply Presence to the parent
when the component should enter or exit as one visual object.

## Batched text measurement

`showme.measure_text` is a read-only production-layout query. It requires exact
`documentId`, `epoch` and `revision`, accepts up to 64 text items in one
renderer round trip, loads the document's managed fonts, and returns measured
width/height using the same DOM measurement semantics as ShowMe text auto-sizing.

Use it before construction when wrapping or measured paragraph height affects
layout. It does not mutate the document.

## Atomic batch size

`showme.apply` accepts 1-128 semantic operations. The byte limit, semantic
validation, exact revision check, actor separation, leases, detached staging and
single durable transaction remain unchanged. A late invalid operation rejects the
whole batch.
