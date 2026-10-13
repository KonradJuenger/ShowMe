# ShowMe MCP design

Status: design proposal only. This branch does not add an MCP server yet.

Base reviewed: `main` at `7640df7c2b4d229a4baa51567b095d9d1901946b`.

## Research and Codex investigation

The initial architecture was followed by a second research pass focused specifically on how models should see current presentation state.

Read these before implementation:

- [RESEARCH_CONTEXT_AND_STATE.md](./RESEARCH_CONTEXT_AND_STATE.md) — current MCP/Figma/context-engineering research and the recommended Agent Projection.
- [CODEX_PHASED_PLAN.md](./CODEX_PHASED_PLAN.md) — investigation-first implementation sequence with phase gates and evals.

The research makes the model-facing read projection a first-class part of the design: compact orientation, scoped semantic inspection, world-space geometry, explicit UI epoch, on-demand source/native detail, and production-rendered visual verification.

## Goal

Build an MCP interface that lets an external agent inspect, edit, animate, preview and refine a running ShowMe presentation while preserving ShowMe's existing document, collaboration, undo, rendering and Effect semantics.

The MCP should feel like operating ShowMe, not like editing its JSON format.

A good result is:

- few model-facing tools;
- native editable ShowMe output;
- one canonical persistence path;
- atomic multi-part edits;
- useful visual feedback;
- deterministic, structured errors;
- safe behavior while a human is editing;
- no hidden model inside ShowMe;
- no second document runtime;
- no direct mutation of `.sme` files.

## Existing architecture is the foundation

ShowMe already has the important boundary:

```text
Editor
  -> EditorSession
  -> DocumentOperation[]
  -> DocumentTransaction
  -> DocumentAuthority
  -> durable recovery
  -> accepted revision
```

MCP mutations must eventually enter this exact path.

Do not introduce:

- an MCP-owned document copy;
- an MCP-specific document schema;
- a second `DocumentAuthority`;
- direct file editing;
- a separate Effect persistence model;
- a general-purpose JavaScript execution tool.

The MCP layer should translate compact semantic requests into the same command functions and document operations already used by the editor.

## Proposed system

```text
MCP host
ChatGPT / Codex / Claude / Cursor / VS Code
                 |
                 | MCP
                 v
        showme-mcp helper
        local process, stdio
                 |
                 | private local bridge
                 v
        running ShowMe desktop app
                 |
        +--------+---------+
        |                  |
   editor context      semantic edits
        |                  |
        v                  v
   current slide      EditorSession /
   selection          DocumentRuntime
   scope                    |
        |                   v
        |             DocumentAuthority
        |                   |
        +--------+----------+
                 |
                 v
             renderer
                 |
                 v
              preview
```

The MCP helper owns protocol translation only. It does not own presentation state.

For the first implementation, target local desktop workflows. A remote/cloud MCP can be designed later without changing the semantic tool contract.

## Public MCP surface

Keep the public surface intentionally small.

### `showme_context`

Read the active editor context.

Returns enough information to resolve phrases such as "this slide", "the selected title" or "these elements":

- active document ID;
- current slide ID;
- current selection IDs;
- current editing scope;
- current accepted revision;
- deck size;
- presentation name.

This is ephemeral UI context, not persisted document data.

### `showme_inspect`

Read selected presentation state with an explicit scope and requested detail.

Examples:

- deck outline;
- one slide;
- selected elements;
- element tree;
- geometry;
- text;
- appearance;
- Motion;
- Presence;
- Effects;
- notes;
- theme/stylesheet.

Default responses should be sparse. The agent should not receive the whole presentation because it asked about one title.

### `showme_apply`

Apply one atomic semantic edit transaction.

The input contains a list of high-level ShowMe operations such as:

- set text;
- insert text/shape/frame;
- set frame or appearance;
- move/resize/rotate;
- duplicate/delete/reparent/reorder;
- set slide background/notes;
- add/edit native Motion;
- add/edit Presence;
- apply/update/remove an Effect;
- set Effect parameters;
- create/delete/reorder slides.

The adapter uses existing ShowMe command functions to produce `DocumentOperation[]`, then commits through the canonical authority.

One tool call should normally correspond to one coherent undo/history unit.

### `showme_render`

Return a rendered preview for visual inspection.

At minimum:

- document ID;
- slide ID;
- width/height;
- PNG result.

Then extend it to deterministic presentation states:

- stage/click index;
- stage time;
- optional presentation/slide clock state;
- Preview mode rather than editor overlays.

For a presentation editor, visual verification is part of correctness.

### `showme_history`

MCP-owned undo/redo for agent edits, if MCP uses a separate authority actor. Keep this narrow. It should not be a general "undo whatever the human last did" tool.

This tool may be omitted from the first spike until the actor model is settled.

## Resources, not giant tool descriptions

Use MCP resources for stable read-only authoring contracts:

```text
showme://spec/effects
showme://spec/motion
showme://spec/presence
showme://spec/document-semantics
showme://effect-authoring/{documentId}/{slideId}/{elementId}
```

The Effect authoring resource should be generated by the existing `buildEffectAuthoringPrompt()` path. This is the correct place for the detailed GLSL/CSS/JS ABI.

The MCP tool description should not repeat thousands of tokens of Effect documentation.

## Effects: the agent writes the code

Do not build an "Effect compiler" that calls another model.

The MCP client already has a model.

Correct flow:

```text
agent decides an Effect is appropriate
  -> read ShowMe Effect authoring resource
  -> agent writes GLSL / CSS / text JS
  -> showme_apply receives normal EffectDefinition
  -> ShowMe validates it using the production Effect runtime
  -> setElementEffectDefinition(...)
  -> normal document transaction
  -> showme_render
  -> agent visually checks result
```

Extract the Effect validation currently embedded in `EffectEditor.tsx` into a reusable production function so the Effect Editor and MCP use identical validation.

Keep Effect Library ownership separate:

- "apply this Effect" changes the presentation;
- "save this Effect to my library" changes the Library.

Generated Effects should not automatically pollute the global Effect Library.

## Motion and Presence stay native

Agents should use ShowMe's native abstractions instead of generating code for ordinary animation.

Examples:

```text
"move the title in"          -> native Motion
"pulse these three cards"    -> native Motion
"show this from click 2"     -> Presence
"scramble these characters"  -> text Effect
"distort this image"         -> shader Effect
"flowing generated backdrop" -> generated shader Effect
```

The MCP should expose these as semantic operations while preserving ShowMe's existing Motion/Presence model.

## Important open decision: actor identity

`DocumentAuthority` currently uses `actorId` for both lease ownership and actor-scoped history.

This creates a real trade-off.

### Reuse actor `local`

Advantage:

- normal Ctrl+Z naturally includes agent edits.

Problem:

- leases from the same actor do not conflict;
- acquiring the same scope replaces the same actor's lease;
- a second MCP-side session could invalidate or interfere with an active local editor gesture.

Therefore a second independent `EditorSession` using actor `local` is not safe enough.

### Separate MCP actor

Advantage:

- proper lease conflict with active human edits;
- clean attribution;
- agent undo/redo can be actor-scoped;
- behaves like a collaborator.

Problem:

- normal local Ctrl+Z does not currently own the MCP actor's history.

Recommended first implementation: use a distinct MCP actor for safety, surface lease conflicts clearly, and provide MCP-owned rollback. Before release, decide whether the editor should gain a user-facing way to undo/revert the latest accepted agent transaction.

A stronger future design could separate "lease identity" from "history ownership", but that is a DocumentAuthority design change and should not be introduced casually.

## Current MCP protocol target

As of 2026-10-13:

- target MCP specification `2026-07-28`;
- use the stable TypeScript SDK v2 (`@modelcontextprotocol/server`);
- use stdio for the local process-spawned MCP helper;
- use Streamable HTTP if a remote service is added later;
- do not build new features on deprecated Roots, Sampling or Logging;
- do not rely on hidden MCP protocol session state;
- use explicit ShowMe IDs/revisions in requests;
- use JSON Schema / Zod input and output schemas;
- return `structuredContent` that conforms to declared output schemas;
- set tool annotations deliberately (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

References:

- https://modelcontextprotocol.io/
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://developers.figma.com/docs/figma-mcp-server/

Figma is useful as a current creative-tool reference, particularly its separation of sparse metadata, richer context, native write operations, screenshots, shader source and workflow Skills. ShowMe should borrow those reliability patterns, not copy Figma's document model.

## What "world-class" means here

Not maximum tool count.

It means the agent can reliably complete real presentation work with few calls:

```text
inspect only what matters
  -> make one coherent native edit
  -> receive exact changed IDs + revision
  -> render the relevant state
  -> inspect the image
  -> make one targeted refinement if necessary
```

Measure:

- task success;
- correct target selection;
- schema-valid calls;
- calls per successful task;
- unrelated mutations;
- stale revision handling;
- lease conflict handling;
- deterministic replay;
- visual correctness;
- editor/audience/export parity;
- Effect compile/runtime success;
- recovery after failed calls;
- cross-client behavior.

See the other documents in this folder for the proposed contracts, integration seams and implementation sequence.
