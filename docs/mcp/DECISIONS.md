# MCP decision log

This file records architectural decisions for the MCP branch. It is intentionally blunt so later implementation work does not accidentally reintroduce rejected approaches.

## Accepted

### MCP is an adapter over ShowMe, not a second editor

All persistent writes must end in the existing `DocumentAuthority`.

Reason: ShowMe already has one current document model, recovery path, collaboration model and accepted revision sequence.

### The running ShowMe app owns document state

The MCP helper does not independently open and mutate `.sme` files.

Reason: file contents can be behind accepted unsaved state and cannot provide current leases, collaboration state, selection or production rendering context.

### Local first

Initial transport:

```text
MCP host -> stdio helper -> authenticated local ShowMe bridge
```

Reason: proves the product interaction with minimal deployment/security complexity.

Remote Streamable HTTP is a later product mode.

### Small tool catalog

Start with:

```text
showme_context
showme_inspect
showme_apply
showme_render
showme_history (only if needed)
```

Reason: models select tools more reliably when the catalog maps to user-level tasks rather than backend methods.

### Semantic apply operations

`showme_apply` accepts user-meaningful operations and maps them onto existing ShowMe command functions.

Reason: raw `DocumentOperation` is a persistence contract, not the ideal public authoring contract.

### Writes use expected revisions

Mutation requests include `expectedRevision`.

Reason: do not silently apply an intent to a presentation that materially changed after inspection.

### ShowMe creates IDs

Agents should not invent persistent ShowMe IDs.

Reason: identity generation is application responsibility and generated IDs must be returned explicitly.

### Visual feedback is first-class

The MCP needs production-rendered image output.

Reason: successful structured mutation is not enough to establish that a presentation looks correct.

### The connected agent writes Effect code

The agent reads the existing ShowMe Effect authoring contract and writes GLSL/CSS/text JS itself.

Reason: the external MCP host already has a model. A second hidden model adds cost, nondeterminism, configuration and debugging complexity without a clear benefit.

### Effect validation is shared with the Effect Editor

Extract validation from `EffectEditor.tsx` rather than implementing an MCP-only validator.

Reason: accepted code must behave the same whether authored by a human or an agent.

### Motion and Presence remain native

Ordinary movement uses Motion. Lifecycle uses Presence. Effects remain visual modules.

Reason: agents should create editable ShowMe-native structure rather than replace it with generated code.

### MCP context is ephemeral

Current slide, selection and editing scope may be exposed, but are not persisted into the document.

Reason: UI state and document state have different ownership.

### MCP is closed-world by default

The core MCP edits only the running ShowMe application and does not fetch arbitrary network content.

Reason: keep permissions understandable and tool annotations accurate.

## Rejected

### "Effect Compiler" architecture

Rejected as a top-level subsystem.

The only compilation that should exist is the real technical validation already required by the Effect runtime, such as GLSL compilation.

Do not introduce:

```text
EffectIntent
 -> AI planner
 -> engine selector
 -> internal LLM
 -> compiler
 -> repair model
```

for the first MCP.

### Direct document JSON patches

Rejected.

Reason: bypasses semantic command behavior, invariants and future refactors.

### Direct `.sme` file writes

Rejected.

Reason: bypasses the running authority, durable recovery and collaboration state.

### MCP-specific DocumentAuthority

Rejected.

Reason: two authorities mean two competing truths.

### Second independent EditorSession using actor `local`

Rejected unless authority semantics change.

Reason: same-actor leases do not conflict and acquiring the same scope can replace an active same-actor lease.

### One MCP tool per internal function

Rejected.

Reason: internal granularity is not model-facing semantics.

### Arbitrary run_javascript tool

Rejected.

Reason: unnecessary security boundary. Text Effects already have a deliberately restricted worker runtime.

### Auto-save every generated Effect to Library

Rejected.

Reason: presentation Effects and reusable Library Effects have different ownership.

### Hidden automatic stale-state rebase

Rejected.

Reason: an agent should re-inspect and deliberately retry after a revision conflict.

### Protocol dependence on one MCP client

Rejected.

Reason: ShowMe should work across multiple compliant hosts.

## Recommended but still to validate

### Separate MCP actor

Current recommendation: use a distinct actor such as `mcp-local` so agent edits conflict correctly with active human leases.

Remaining UX issue: local Ctrl+Z is actor-scoped and therefore does not automatically undo MCP history.

This needs a product decision before a write-enabled public release.

### Private loopback bridge

Current recommendation: authenticated random-port loopback bridge between helper and Electron main.

Alternative: OS named pipe / Unix socket.

Choose based on implementation simplicity and security testing on Windows/macOS.

### Host-side semantic adapter

Long-term preference: semantic operation adapter outside React, using existing core commands through a dedicated `EditorSession` and an actor-scoped `EditorTransport` backed by `DocumentRuntime.*ForActor()`.

Reason: `EditorSession` is already core and transport-independent. Reusing it preserves native lease derivation, transaction assembly, stale/conflict handling and accepted-replica behavior without coupling MCP to the live React editor.

Renderer-only services such as text measurement and executable Effect validation should remain explicit shared services, not a reason to bypass this session path.

## Open questions

1. Should user Ctrl+Z undo the latest MCP edit even when it came from a separate authority actor?
2. Should MCP calls appear in collaboration presence/history as a named agent?
3. Should `showme_apply` expose a dry-run mode, or is inspect + expected revision sufficient?
4. What is the smallest render-state input needed to sample Click Timeline states without duplicating presenter logic?
5. Which semantic operations are required for the first useful public release?
6. Should effect authoring context be a Resource only, or also retrievable through `showme_inspect` for clients with weaker Resource UX?
7. Do we need an MCP-specific "current selection changed" subscription later, or are explicit reads sufficient?
8. Should the MCP helper be packaged with ShowMe, installed separately, or generated as a tiny launcher command by the app?
9. How should the helper discover multiple simultaneously running ShowMe instances, if that is ever supported?
10. When remote MCP exists, what is the document identity/synchronization model? Do not let this question complicate local v1.

## Decision rule for implementation

When there are two possible designs, prefer the one that:

1. preserves the existing ShowMe authority and runtime;
2. creates native editable presentation state;
3. is visually verifiable;
4. has explicit IDs/revisions;
5. has fewer model-facing concepts;
6. fails safely under concurrency;
7. can be tested without relying on model behavior.

Only add abstraction after a concrete workflow demonstrates that the simpler path is insufficient.
