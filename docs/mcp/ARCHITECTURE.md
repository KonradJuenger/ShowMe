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

There are two plausible places to translate semantic MCP operations into ShowMe commands.

### Option A: host-side semantic adapter

Electron main / a core service loads projections, applies semantic command functions, derives `DocumentOperation[]`, then commits through `DocumentRuntime`.

Pros:

- headless-friendly;
- clean separation from React;
- easy to test;
- MCP does not depend on editor component lifetime.

Cons:

- actor identity/history problem must be handled deliberately;
- text auto-measurement and other renderer-dependent authoring behavior may need explicit services;
- preview validation still needs renderer capabilities.

Recommended long-term direction.

### Option B: execute through the live editor's existing EditorSession

MCP requests are routed into the editor renderer and executed through the exact active `EditorSession`.

Pros:

- identical local undo behavior;
- identical editor context;
- no second session using actor `local`;
- renderer-dependent authoring services are already present.

Cons:

- more Electron request routing;
- tighter coupling to an open editor window;
- difficult to support headless/background use;
- care is needed not to interrupt active gesture/history groups.

Recommended only as an initial spike if it produces materially better UX with much less code.

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
