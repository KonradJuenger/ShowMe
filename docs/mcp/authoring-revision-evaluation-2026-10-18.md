# Authoring revision implementation and evaluation

Execution: local-codex, branch `codex/local-mcp-server`, starting HEAD `df31f1a733cdfb3992c15ea6f5b14ff32c9f0069`. No branch, commit, push or PR created. Existing user documents and files preserved. Implementation remains uncommitted.

## Implementation

- Reproduced four cold renderer failures (measurement, GLSL, CSS, text-JS). All four pass after installing all five production runtime entry points through one lazy registry and installation handshake. Runtime recovery is covered.
- Added canonical operation discovery, bounded family/detail requests, schema digests, validated examples, authored-page receipts and replay receipts with separately read current observations. Raw SDK tools/list retains canonical shapes; host normalization internals were unavailable, so its precise cause is not established.
- Added stable timeline stage/block identifiers, schedule editing, native Motion settings and Presence update/removal.
- Added deterministic event-trace samples, finite completion and production transition samples using the production renderer and transition hook. Multi-frame output is bounded and partial results are discarded on cancellation or document changes.
- Added atomic multi-page groups through the existing EditorSession/DocumentAuthority path. Fixed full-document scope acquisition for later existing pages; lease conflicts still reject the entire transaction.
- Added production font availability and text overflow feedback. Exact fallback font identity is not claimed.
- Added native accepted-state save/save-as/package delivery. Native destination policy, cancellation and authority admission remain in force. Fixed same-document save invalidating the editor context and stale destroyed preview window routing.

## Presentation evaluation

Created eight editable slides about ShowMe through semantic MCP operations. Native file: `artifacts/showme-ideas-in-motion/ShowMe — Ideas in motion.sme`. Saved and reopened successfully. All eight final previews were visually inspected, reported no warnings, and all 49 measured text runs fit after one heading correction. The deck uses native Frames, Motion, Presence, GLSL, CSS and text-JS. Source references are in speaker notes.

Construction used 72 operations across eight page groups, approximately 19,921 compact JSON bytes. Shared shader treatments were duplicated in this evaluation; template resource reuse is a remaining authoring gap, not a demonstrated capability.

Sampled delayed effects, Motion, Presence and forward/backward/jump transitions. Native pixel tests cover shader time and numeric parameter animation, CSS opacity, text-worker time and repeatability. Live audience navigation was exercised and ended. No frame-rate or smoothness measurement is claimed.

The evaluation caught and fixed compact preview/delivery routing, multi-existing-page scope acquisition, and native save context continuity. Replaying an accepted animation request after a later edit returned its original receipt plus the newer current observation without duplicating objects. A stale revision and a late second-page failure were rejected without partial acceptance.

A one-pass exploratory seven-page comparison measured one batch at 84.2771 ms versus seven serial calls at 139.039 ms on separate fresh instances. This is a tool-call comparison, not a renderer performance benchmark.

## Verification recorded during implementation

- `npm run build`: passed before the final receipt/digest/destination reporting edits; those final edits still require a fresh build/native sweep.
- `npm run typecheck`: passed after the final destination reporting changes.
- `SHOWME_TEST_FILES` selecting agentEditing, agentPreview, agentDelivery, agentProjection, agentBridge, agentInspection, agentClosing and persistence/package-options, followed by `npx vitest run`: **8 files, 96 tests passed**.
- Focused Playwright Electron runs passed raw discovery, four cold starts/recovery, multi-page delivery/reopen, deterministic rendering and fade transition cases (8 tests). Follow-up runs passed recovery cases, the media fixture, existing-page scopes/creative authoring, save context continuity and shader parameter sampling. An earlier combined run exposed failures subsequently fixed; a final combined run has not been performed.
- Full/release suites, packaging, macOS, final lint, test statistics/audit and the audience-navigation commit gate have not run. No commit or integration was made, so the commit gate was not triggered.

## Review and next priorities

There is no global reduced-motion cap or prefers-reduced-motion branch in the current renderer/MCP implementation. The rejected authored media query was caused by the CSS sandbox allowing only :scope and @keyframes. No reduced-motion constraint was introduced or removed.

Highest priority: expose native template creation/editing and inherited-element inspection. A recurring shader background, logo or footer should be authored once in a template and inherited across slides. Template ownership and explicit instance overrides must remain clear.

Named text-style create/update/apply operations already exist. Authoring should establish title, body, caption and label styles once and reuse their IDs instead of copying typography properties. More direct style-property editing and concise style discovery would improve this workflow.

Next: reusable effect resources with shared source and per-instance parameters, semantic reusable slide recipes, native document create/open/close, authorized asset import, and clearer capability/budget discovery. Increase creative expressiveness and reduce repetitive calls while retaining atomic transactions, revision checks, native ownership and native persistence.

At review time no Electron process remained running; the saved presentation is closed. Further template/resource expansion is a recommendation, not implemented functionality.

## Continuation — reusable authoring and fresh modern deck

The six follow-up MCP improvements and a separate modern-theme evaluation are recorded in [modern-authoring-evaluation-2026-10-18.md](modern-authoring-evaluation-2026-10-18.md). That report supersedes the pending verification notes above for the combined implementation. Concrete next-instance tasks and observed friction are in [NEXT_INSTANCE_HANDOFF.md](NEXT_INSTANCE_HANDOFF.md). The original deck remains preserved.
