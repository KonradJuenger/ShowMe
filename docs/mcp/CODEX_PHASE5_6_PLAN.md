# Phases 5–6: ordinary agent editing

Status: implemented for local development, 2026-10-18. See
`CODEX_PHASE5_6_FINDINGS.md` for outcomes and verification. This file retains the
design plan. The developer explicitly selected “Allow local editing with the new
opt-in; keep evaluation pending” and clarified that there are no MCP users yet.
That instruction supersedes this plan's original external-write evaluation gate
for local development; cross-host evaluation is still unfinished, not claimed passed.

## Intended result

Support `context -> inspect -> apply -> preview`, with visible **Undo agent edit**
and **Redo agent edit** actions in ShowMe. One apply changes one presentation slide,
atomically, at an explicit document epoch/revision. Human selection and playhead
stay where they are. Agent edits use the normal recovery/save/collaboration pipeline.

Start with seven semantic operations: text replacement, movement, frame sizing,
appearance patching, text/shape insertion and removal. No raw transactions, arbitrary
JSON patches, Effect source, Motion/Presence authoring, template edits, media import,
slide management, file access, export or external MCP integration.

The outstanding Phase 4 model-targeting evaluation remains a gate before external
writes are enabled. Phase 5 can be built and tested without adding a productive MCP
write route. Automated transport tests are not a substitute for that evaluation.

## Ownership and findings

The single persistent path remains:

```text
semantic request -> existing core commands -> EditorChange/DocumentOperation[]
                 -> EditorSession -> DocumentTransaction -> DocumentAuthority
                 -> existing durable recovery writer -> accepted revision
```

The dedicated agent session is an ordinary `EditorSession` over the existing runtime;
it is not another authority, persisted document copy or editor runtime.

Verified current seams:

- `src/core/editorCommands.ts`: insertion/removal, translation, frame/appearance
  replacement and production resizing. Commands accumulate semantic operations.
- `src/core/text.ts`: `updateText`, `insertText`, native defaults and auto-size frame
  calculation. `updateText` needs a `TextMeasure` for auto-sized text.
- `src/components/editor/textLayout.ts`: actual DOM text measurement. Do not invent
  Node font metrics or rely on a later human edit to repair agent text sizing.
- `src/core/editorSession.ts`: lease derivation, commit queue, replica, history and
  failed-intent handling. `apply` schedules; `flush` reports completion. Accepted
  transaction receipts are currently private to its commit path.
- `src/core/documentRuntime.ts`: actor-specific commit, acquire/renew/release,
  history/undo/redo and accepted subscriptions already exist.
- `src/core/documentAuthority.ts`: one serialized commit queue and durable writer.
  It can accept stale transactions with unchanged guards. Agent semantic intent
  needs stricter exact-revision admission inside that queue.
- `electron/agentBridge.ts`, `mcp/server.ts`, `mcp/showmeClient.ts`: existing authenticated
  fixed-command dispatch, stdio framing and per-call discovery. Extend their explicit
  unions, never forward arbitrary methods from `operations`.

Two traps to avoid: nesting `commit()` inside `runExclusive()` deadlocks the same
queue; sharing actor `local` lets independent sessions replace the human's leases.

## Public request and initial semantics

Recommended `showme.apply` input:

```ts
{
  documentId: string;
  epoch: string;
  expectedRevision: number;
  mutationId: string; // caller-generated retry identity, not an element ID
  slideId: string;
  operations: SemanticOperation[];
}
```

One slide per call matches the existing session projection and makes atomicity and
history easy to assess. Reject mixed-slide batches rather than committing each slide
separately. IDs target accepted state; apply has no `current-selection` shortcut and
never resolves a changing selection itself. An agent first inspects selection, then
supplies the returned explicit IDs. Later selection/navigation within the same active
document does not retarget those IDs.

| Operation | Contract and existing behavior to reuse |
| --- | --- |
| `text.set` | One text element and exact replacement text; `updateText`, preserving style/content settings and measuring native auto-size. Plain text only. |
| `elements.move` | Explicit IDs, `scopeId`, finite `dx`/`dy` in that scope's units; `translateElements`. No implicit world-AABB arithmetic. |
| `elements.frame.set` | One element, explicit parent-local x/y/width/height. Preserve rotation, origin, scale and flips. Reuse production resize/content-preservation behavior for size changes, then position; do not bypass Free-media adjustments or text auto-size rules with a raw frame replacement. Rotation editing is deferred. |
| `elements.appearance.patch` | Explicit IDs and a nonempty allowlisted patch: fill, stroke color/width, opacity, radius. Merge with accepted appearance, then `setElementAppearances`; no CSS, URLs, Effect or geometry injection. |
| `element.insert_text` | Explicit editable parent, parent-local center and exact text, optional name. Convert center through production transforms for `insertText`, use native text defaults and measure. ShowMe generates the ID. |
| `element.insert_shape` | Explicit editable parent, rectangle/ellipse, parent-local x/y/width/height and optional appearance/name. Use native factories and `insertElements`; ShowMe generates the ID. |
| `elements.remove` | Explicit IDs through `removeElements`, including the existing cleanup of associated native bindings/resources. Report removed descendants; never remove template content implicitly. |

Validate with strict discriminated schemas. Initial limits: 32 semantic steps,
128 distinct existing targets, the existing 64 KiB bridge request cap, and the native
256-operation transaction cap after expansion. Bound text/names/numbers using current
document/text contracts. Reject NaN/infinity, invalid sizes/colors, unknown options,
empty batches and oversize expanded work before committing.

Validate targets against slide-owned editable content, not the resolved visual
composition alone. Inherited template objects may be inspected but are not writable
through their presentation instance. Respect hidden/locked layers and existing scope
and hierarchy rules. Movement rejects ancestor+descendant selections and invalid
coordinate scopes as the native command does. Prevalidate all IDs; never partially
apply a batch because a lower-level command ignores one missing target.

Operations run in order against one detached working `EditorChange`. Existing IDs
may be modified by later steps, but inserts cannot be referenced by speculative IDs
or temporary aliases in this slice. Configure the inserted object in its own step,
or use the returned generated ID in a later request. No-op batches return
`changed:false`, unchanged revision and null transaction ID; they create no history.

## Phase 5A: assembly and production text measurement

Add a narrow core module (suggested `src/core/agentMutation.ts`) for request validation,
target validation, command mapping and deterministic result summaries. It receives an
accepted projection and explicit measurement/ID services; it does not fetch files,
read React state or commit itself. Reuse the existing scene/transform helpers.

Provide a typed host-owned text-measurement request to the isolated production
renderer. Reuse/extract the current `measureText` implementation and managed-font
loading. Pass only host-validated candidate text/style/frame data, use normal text
nodes, and return measurements; no arbitrary renderer execution or client-supplied
document body. Serialize this with existing hidden-surface work or isolate the
measurement probe lifetime so it cannot corrupt a concurrent preview.

Auto-size measurements must be ready before transaction assembly finishes. Preserve
native fallback behavior for genuinely unavailable fonts, with a clear warning;
measurement/renderer failure returns `MEASUREMENT_UNAVAILABLE`, with no commit. Fixed
size text uses its existing frame. Revalidate document/access/revision after every
await. Test wrap, newline, resolved text styles, managed fonts and non-square frames.

For frame sizing, identify the exact reusable production content-preservation seam
in `resizeElements`; extract only that shared responsibility if needed. Before
advertising support, verify parity for rotated/scaled parents, text and Free media.
Do not create a second resize engine to force a convenient public shape.

## Phase 5B: actor transport and exact commit admission

Use actor `mcp-local`. Serialize agent requests for each document so two helpers
cannot replace that actor's active leases. Construct a short-lived dedicated
`EditorSession` per request over an actor-bound transport; history lives in the
authority, not the session. Flush and release/dispose in `finally`; no idle lease
renewal loop, retained failed-intent queue or automatic later retry after rejection.

The actor transport routes to the same `DocumentRuntime.*ForActor` methods and accepted
subscription. It does not use renderer IPC methods bound to actor `local`. Read/write
routing is host-owned; accepting a public caller-supplied actor ID is prohibited.

Add the smallest session receipt API needed to obtain the actual accepted transaction
from the existing schedule/commit path. Do not reconstruct acceptance from a guessed
revision or bypass `EditorSession` to get a convenient return value. Preserve existing
human scheduling/retry/grouping behavior.

Add an optional, host-only commit-admission policy evaluated in the authority's
serialized commit task immediately before transaction evaluation/durable writing.
Pass it through the runtime actor boundary; it is not part of persisted/wire
`DocumentTransaction` schemas. For agent calls it verifies exact request epoch and
expected revision, active document/runtime identity, access generation and eligibility.
It must not await external work or enqueue another authority commit.

Both checks matter: preflight prevents wasted work; the in-queue check prevents a
human/LAN transaction accepted between preflight/lease acquisition and admission
from slipping through native guarded stale acceptance. Keep native human/LAN stale
semantics unchanged. Even if a session's replica advances, the immutable request's
`expectedRevision` remains the agent policy, never the session's latest revision.

Initially support a locally owned document, including a host with LAN collaborators.
While this app is a collaboration guest return `GUEST_EDITING_UNSUPPORTED`; no local
authority fallback and no edits under the guest's human actor. Reads remain available.
Remote-host delegation for distinct agent identities is a separate future capability.

## Phase 5C: retries, durable acceptance and revocation

Maintain a bounded host replay registry keyed by `(documentId, epoch, mutationId)`,
with a canonical validated request fingerprint, pending promise and terminal result.
Check active document/epoch/access first, then a prior result before current-revision
preflight. Identical retries share pending work or return the original receipt with
`replayed:true`. A different request under the same key returns `MUTATION_ID_REUSED`.
Accepted insertion IDs are generated once and returned on replay.

Retain entries across helper reconnects, MCP off/on and undo/redo within that live
document epoch; never replay an undone edit as a new commit. Do not evict accepted
identities silently. Start with limits of 1,024 identities and 8 MiB of receipt metadata
per epoch; reserve space before admission and refuse new identities with
`MUTATION_CAPACITY_REACHED` when full. Pending entries cannot be evicted. Store hashes
and bounded summaries rather than full text bodies. Document close/new epoch clears
the registry; this is bounded process-local retry protection, not durable exactly-once
execution across restarts. A new epoch requires inspection and a deliberate new intent.

Define the commit boundary truthfully:

- Before authority admission, disable, document replacement/close or cancellation
  invalidates queued work and commits nothing.
- Once durable writing begins, do not roll back, cancel the durable writer, abandon
  the authoritative outcome or claim the edit was rejected. It may be accepted after
  access is revoked. Finish recording the receipt and releasing resources.
- An interrupted/disabled connection can lose the response. Reconnect and retry the
  same identity to recover the outcome when the same document epoch is active; do not
  automatically issue a new identity. A timeout is not evidence that nothing changed.
- Post-acceptance projection/history refresh failure must not turn a known accepted
  edit into an ordinary rejection that a client might repeat as a new intent. Return
  the stored acceptance plus a refresh warning whenever delivery remains authorized.

This intentionally differs from read-only preview cancellation: discarded pixels
have no durable side effect; an accepted mutation does.

## Phase 5D: receipts and agent history

Success returns `ok`, document/epoch/slide, mutation ID, previous/accepted revision,
transaction ID, `changed`, `replayed`, created/changed/removed IDs, a bounded semantic
change set and warnings. Derive the change set from commands plus accepted operations
and before/after projections, including measured frame changes and removal cascades.
Do not return source, full documents, lease tokens or inverse operation bodies.

Expected failures include `INVALID_REQUEST`, `REVISION_CONFLICT`, `EPOCH_CONFLICT`,
`LEASE_DENIED`, `UNKNOWN_SLIDE`, `UNKNOWN_ELEMENT`, `INVALID_SCOPE`, `TARGET_NOT_EDITABLE`,
`UNSUPPORTED_OPERATION`, `DOCUMENT_NOT_ACTIVE`, `DOCUMENT_CLOSED`, `MCP_DISABLED`,
`EDITING_DISABLED`, `MCP_ACCESS_CHANGED`, `GUEST_EDITING_UNSUPPORTED`,
`MEASUREMENT_UNAVAILABLE`, `MUTATION_ID_REUSED`, `MUTATION_CAPACITY_REACHED` and durable
commit failure. Use typed internal failures at changed boundaries rather than parsing
English exception strings; preserve current callers. Return safe recovery guidance,
actual revision where useful and affected request-step indices, not raw stacks.

One changed apply is one agent undo unit; no history grouping across requests or
merging into the human's active typing/drag group. Human Ctrl+Z remains actor `local`.
The UI offers **Undo agent edit** / **Redo agent edit**, calls the existing guarded
actor history path, and identifies the latest agent action with a compact summary.
No MCP history tool in this slice. Authority guards/leases can refuse undo after a
conflicting human/LAN edit; explain and leave state unchanged rather than overwriting
the later work. Disjoint later edits should survive a permitted agent undo.

History status/undo IPC is editor-main-frame-only and restricted to the active local
document/agent actor. The user must be able to undo an accepted agent edit even after
MCP/editing is turned off; human recovery actions are independent of external access.
Use the existing authority history state, not a parallel undo stack or persisted log.

## Phase 6: MCP and user controls

Keep **Enable MCP** as the master switch. Add **Allow agent editing**, default false,
under it. Existing users who enabled read-only MCP do not silently grant write access
on upgrade. Turning editing off preserves reads and revokes not-yet-admitted writes;
turning the master off revokes all external access. No per-edit confirmation dialog.
Expose a narrow editing-availability/reason summary in context, including guest or
capacity limitations. Update Settings copy and setup instructions to match.

Only after the application and targeting gates, extend the private bridge's strict
command union with `apply` and register exactly one new public tool, `showme.apply`.
Its schema is the semantic request above; no raw operation/transaction forwarding.
Keep the catalog stable when editing is disabled; execution checks the actual grant.
Annotations: readOnly false, destructive true, closed-world, idempotent true for the
explicit retry-identity contract. Annotations never enforce authorization.

Return structured receipt/error plus compact text using the existing conventions.
Preserve all bridge authentication, Host/Origin protections, payload/admission limits
and SDK framing. A write deadline or disconnected helper aborts delivery but does not
erase an admitted mutation or free its work slot prematurely. Set the write deadline
after measuring the bounded measurement/commit path, without adding automatic retries.

## Implementation sequence and gates

1. **Phase 5 contract/assembler:** strict semantic union, one-slide staging, exact
   target rules, native command mappings and deterministic summaries.
2. **Phase 5 runtime:** shared production measurement, actor transport/session receipt,
   in-queue admission policy and replay registry. No external apply dispatch yet.
3. **Phase 5 gate:** deterministic atomicity, durability, retry, lease, history and
   lifecycle tests pass; focused native text/resize parity passes. Record findings.
4. **Phase 4 evaluation gate:** complete the existing read-only three-host targeting
   corpus and record actual results. Missing environments remain explicit unfinished
   evaluation; do not substitute SDK tests or silently waive this gate.
5. **Phase 6 exposure:** editing subsetting, `showme.apply`, compact activity/agent undo
   controls, context availability and updated setup. No extra editing feature families.
6. **Phase 6 gate:** real client inspect/edit/preview plus user undo/redo, safe concurrent
   edits, repeated/lost-response recovery and small real-model editing corpus pass.

## Verification and handoff

Use deterministic domain/runtime tests for every operation, whole-batch rollback on
one invalid step, no-op history, exact-revision races (including disjoint native
stale-acceptable edits), human same-target and ancestor leases, unrelated scopes,
LAN actor conflicts, lock/template restrictions, invalid scope, durable-writer failure,
receipt-after-refresh failure, duplicate concurrent/helper-reconnected requests,
different-payload identity reuse, ledger capacity, accepted retry after undo and
off/on, close/reopen, pre-admission cancellation and revocation during held durability.
Assert accepted state, revision, writes and history counts, not only returned errors.

Native tests cover production text measurement/font/wrap behavior, resize/content
parity, unchanged human selection/playhead, live document updates, agent undo/redo
with later human edits, both setting switches and IPC window/frame restrictions.
Real stdio tests cover inspect/apply/preview, lost-response replay without duplicate
inserts, stale targets, off/on and rejected guest writes. Reuse current preview pixel
tests rather than duplicating their entire rendering matrix. Verify the Windows
packaged helper path; report macOS/real LAN-host runs separately when unavailable.

Register explicit declarations in `tests/registry.json`, regenerate stats/audit.
Expected checks: focused Vitest and Electron selections via `SHOWME_TEST_FILES`,
`npm run build`, targeted ESLint, `npm run test:stats`, `npm run test:audit`,
`git diff --check`. Changes to authority/session admission justify running affected
existing document/session/collaboration contracts in addition to the new adapter tests;
broaden only for their actual reach. No full release suite by default.

Run a real-model corpus for selected-title edit, scoped movement, appearance patch,
text/shape insertion, deletion, atomic combined edit, stale revision, selection change
after inspection and dropped/repeated request. Record exact target IDs, accepted final
state, unrelated mutations, tool sequences, preview use, conflicts, repair calls and
undo outcomes. No successful prose response substitutes for final-state inspection.

Suggested outcome document: `CODEX_PHASE5_6_FINDINGS.md`, with real verification/eval
results, deliberate limits and any contract changes. Do not create it filled with
invented results during planning. This request does not imply commits, branches,
PRs, publishing or running product tests on these documentation-only edits. Before
any eventual rendering-affecting main commit/integration, run the repository's exact
audience-navigation gate against that candidate.
