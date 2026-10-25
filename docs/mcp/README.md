# ShowMe MCP

Start with [local client setup](LOCAL_SETUP.md). MCP and agent editing are disabled
by default and are enabled separately in Settings. Editing requires a locally owned
document; collaboration guest writes remain outside the MCP boundary.

## Current documentation

- [Tool contract](TOOL_CONTRACT.md): discovery, request admission, revision identity,
  mutation receipts and recovery rules.
- [Authoring capability matrix](AUTHORING_CAPABILITY_MATRIX.md): supported authoring
  operations and editor parity.
- [Local setup](LOCAL_SETUP.md): connection, editing, preview, delivery and recovery.

Persistent edits use the existing editor session, semantic document operations,
document authority and durable recovery. Agent history remains separate from human
undo/redo. Inspection and previews use the current document and production renderer.

## Engineering records

These files record decisions and verification at specific revisions. Use the current
contract and setup documentation for supported behavior.

- [Architecture investigation](ARCHITECTURE.md) and [decisions](DECISIONS.md)
- [Initial findings](CODEX_PHASE0_FINDINGS.md) and [read-projection findings](CODEX_PHASE3_FINDINGS.md)
- [Read-only evaluation](CODEX_PHASE4_READONLY_EVAL.md)
- [Editing implementation findings](CODEX_PHASE5_6_FINDINGS.md)
- [Refinement findings](REFINEMENT_FINDINGS.md) and [implementation evaluation](refinement-evaluation-2026-10-19.md)
- [Discovery evaluation](schema-discovery-evaluation-2026-10-19.md)

Dated authoring evaluations and measurement JSON files remain available for
traceability. The discovery baseline is also an active test fixture. Superseded
implementation plans and transient agent handoffs have been removed; Git history
retains them. Cross-host model evaluation remains pending and is not established
by SDK checks or wire-size measurements.
