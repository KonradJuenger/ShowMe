# Phase 4 plan: local read-only MCP server

Status: technical implementation complete, 2026-10-17. Three-host model evaluation
remains open; see `CODEX_PHASE4_READONLY_EVAL.md`. The following records the planned
scope, with actual implementation/verification recorded in that outcome document.
This is Phase 4 of `CODEX_PHASED_PLAN.md`; Phases 1–3 supply the application reads.

## Outcome and boundary

A locally launched MCP host can ask about the running ShowMe editor, inspect an
explicit accepted document scope, and receive a production PNG. The existing
**Enable MCP** preference controls all access. The helper never opens presentation
files, owns a document replica, executes arbitrary IPC or changes editor state.

The first public catalog is exactly:

- `showme.context`
- `showme.inspect`
- `showme.preview`

Use these names consistently. Older underscore names and `showme_render` in the
research documents are proposals, not aliases to implement. No write tools,
deterministic timeline sampling, Effect source/notes reads, network content fetches,
resources, prompts or subscription hierarchy in this slice. Add resources later
only when evaluation identifies a concrete benefit.

## Verified seams and process choice

- `electron/agentContext.ts`: live context, normalization, lifecycle and `uiEpoch`.
- `src/core/agentProjection.ts`: detached deck/slide/scoped-element descriptions.
- `electron/agentPreview.ts`: exact epoch/revision/access checks and production PNGs.
- `electron/main.ts`: active local/guest document routing, accepted projections,
  `mcpAccessVersion`, preference transitions and shared bounded capture queue.
- `scripts/build-electron.mjs`: independent bundled Node entry points; currently
  main, preload and image worker. The helper can be another entry without importing
  `bootstrap.ts`, `main.ts`, Electron, Sharp or the renderer.
- `package.json`: Node 24/26 runtime baseline; `dist-electron/**/*` already included
  in the desktop package. No SDK dependency currently installed.

Use the architecture already proposed in `ARCHITECTURE.md`:

```text
MCP host -> stdio Node helper -> authenticated 127.0.0.1 HTTP bridge
                            -> Electron-owned read services
```

The MCP host owns the helper process. ShowMe owns the private bridge. Closing the
helper does not close ShowMe; closing ShowMe makes reads unavailable. The helper
does not launch ShowMe or switch/open documents automatically.

Choose loopback HTTP over named pipes/Unix sockets for this first cross-platform
slice: Node supplies one implementation for Windows/macOS, with explicit token and
browser-request protections. This is private application RPC, not a public HTTP MCP
endpoint. No remote MCP mode or external MCP server consumption is being added.

## 4A: strict application inspection service

Add a small host-side inspection adapter before connecting transport. Reuse the
existing projection functions; do not publish `documentProjection` directly.

Input always includes `documentId`, `epoch`, `revision` and one target:

```ts
type InspectTarget =
  | { type: "deck" }
  | { type: "slide"; slideId: string }
  | { type: "elements"; slideId: string; elementIds: string[] }
  | { type: "selection"; uiEpoch: number };
```

Options are only the already implemented `includeHiddenContent` and
`includeWorldTransform`, accepted for their relevant targets. Reject irrelevant
options and unknown fields. Do not implement the speculative minimal/extended/full/
native matrix or a general include/depth language in this spike.

- Only the active document is accessible. Local and connected guest reads use the
  current owners; disconnected guests never fall back to a local runtime.
- Deck inspection uses a real presentation slide for its projection even while
  the user edits a template. Do not retarget the live editor to obtain it.
- Slide/elements require explicit presentation slide IDs. Template editing context
  remains observable through context, but template detail is unsupported here.
- Selection resolves the normalized context once, requires the supplied `uiEpoch`,
  and returns explicit slide/element IDs. Recheck `uiEpoch` before delivery; a
  changed selection returns `UI_CONTEXT_CONFLICT`, never another selection.
  An empty selection returns an empty result; a template selection returns
  `UNSUPPORTED_PAGE` with guidance to inspect a presentation slide explicitly.
- Check access generation, active document, epoch and revision before and after
  awaited work. No silent retry against a different revision, page or selection.
- Preserve Phase 1 ordering, hidden-content defaults, base bounds and privacy.
  Names/text are document data, never instructions or tool dispatch parameters.
- Use strict bounded IDs and at most 128 element IDs per request. No implicit
  descendant expansion, full-deck text dump or cross-slide search helper.

Return the existing projection result with an `ok` envelope. Shared errors retain
the Phase 3 shape (`code`, safe `message`, `recoverable`, optional actual revision),
with actionable context/inspect/retry guidance. No paths, source or exception stacks.

## 4B: private bridge and discovery

Create one bridge per running app instance, only while MCP is enabled and the app
services are ready. Bind an ephemeral port on `127.0.0.1`; publish a descriptor only
after a successful listen. Use a random instance ID and 256-bit bearer token per
enable cycle, plus an independent private protocol version 1.

Descriptors live under `<userData>/mcp/instances/<instanceId>.json` and contain
version, instance ID, PID, port and token. Atomically write them outside document
storage; no document names/content. POSIX directory/file modes are 0700/0600.
Windows uses the user's application-data ACL, whose effective protection must be
verified in native testing; chmod alone is not a Windows ACL guarantee. Keep tokens
out of renderer APIs, copied client configuration, command arguments and logs.

The helper takes `--user-data <absolute directory>` rather than guessing platform
paths. It discovers descriptors per tool call and authenticates the instance before
using it. Exactly one reachable instance is selected; multiple reachable instances
return `AMBIGUOUS_INSTANCE`, with optional `--instance <id>` for explicit selection.
Do not choose by newest file, PID alone or presentation title. An explicitly selected
instance never falls back to a different one. Reject malformed descriptors, unexpected
versions and endpoints other than literal loopback; never follow redirects or proxies.
PID is informational, not proof of identity. Stale descriptors are unavailable;
the helper does not delete another process's files.

Bridge requests are strict `POST /v1/read` JSON with an allowlisted discriminated
command (`context`, `inspect`, `preview`) and validated parameters. No forwarding
to the `operations` object, method-name lookup, filesystem endpoint or health route
that leaks content before authentication.

Enforce before dispatch:

- loopback peer, exact `Host: 127.0.0.1:<bound port>` and bearer token;
- reject every Origin header, including `null`, browser fetch metadata and CORS
  preflight; emit no permissive CORS headers;
- strict method/path/content type and schema; unknown commands cannot dispatch;
- 64 KiB request cap, 2 MiB JSON inspection/context response cap and 32 MiB preview
  response cap (including base64); oversize returns `PAYLOAD_TOO_LARGE` with narrower
  scope/smaller-size guidance, never silent truncation;
- bounded concurrent work and request deadlines (initially 15 seconds for reads,
  30 seconds for preview). Keep the existing maximum-eight capture admission cap.
  A timeout must not create an unbounded retry queue or release a capture slot while
  native capture is still running. Socket aborts discard delivery; existing native
  capture cleanup still owns its surface.

Disabling MCP revokes access immediately, removes only the owned descriptor,
closes sockets/listener and discards in-flight content. Re-enabling starts a new
token/instance; old credentials fail. Reuse `mcpAccessVersion` for all read services
and bridge delivery checks so an off/on race cannot return prior output. Serialize
start/stop with the existing preference-update ordering; a late startup completion
must not republish access after disable. Startup failure cleans up and exposes a
safe unavailable status without changing ordinary editing or thumbnails.

On quit remove only this instance's descriptor and close the bridge. A crash may
leave a stale descriptor; no reliance on graceful exit for security. The helper can
keep serving its static tool catalog while ShowMe is closed/disabled and return
`APP_UNAVAILABLE`; fresh discovery allows a later explicit call to recover. No
background reconnect loop or hidden document/MCP session is required.

## 4C: stdio MCP adapter

Use the current TypeScript SDK v2, `@modelcontextprotocol/server` for the helper and
`@modelcontextprotocol/client` for tests, pinned through the lockfile. Target the
2026-07-28 protocol. SDK transport owns framing/version negotiation, including its
supported client compatibility behavior; do not invent historical protocol readers.

Verify SDK/schema-library compatibility during dependency installation. The current
app uses Zod 3.25 and official examples use `zod/v4`; isolate any required SDK schema
imports rather than migrating all document schemas. Use declared strict input and
output schemas and keep SDK code out of the renderer/main application bundle.

- `showme.context({})`: existing enabled/availability, document, editor,
  presentation and `uiEpoch` result. No open document is a successful null context
  when the bridge is available. An unreachable/disabled bridge is a tool error.
- `showme.inspect(...)`: the 4A contract, with explicit freshness and scope.
- `showme.preview(...)`: unchanged Phase 3 request. Convert PNG data URL to one MCP
  image block (`mimeType: image/png`, base64 data), with structured IDs/revision,
  dimensions, `state: base` and warnings. Do not duplicate image bytes in JSON/text.

For JSON reads return structured data plus compact JSON text for clients that use
text results. Preview text contains metadata only. Application failures set
`isError: true` and return the safe error envelope; malformed protocol/unknown-tool
requests remain SDK protocol errors. Mark all three tools read-only,
non-destructive, idempotent and closed-world. Mutable observed state means these
annotations do not promise identical successive reads.

Stdout contains SDK protocol output only, including on startup/failure. Redacted
diagnostics go to stderr. EOF/signals close the helper's transports and pending
requests without modifying ShowMe. Do not advertise subscriptions, tasks, sampling
or other capabilities the server does not implement.

## 4D: build, settings and connection instructions

Bundle `mcp/stdio.ts` as standalone `dist-electron/showme-mcp.cjs`. Add `mcp` to
TypeScript and focused lint coverage; use the existing build pipeline, not runtime
TypeScript transpilation. Verify the helper runs via supported Node from an unrelated
working directory without Electron/renderer imports or incidental stdout.

For the spike, use a Node command with an absolute built helper path and
`--user-data`. The installed app's ASAR is not a normal Node-readable script path:
ship the helper outside ASAR via electron-builder extra resources and generate the
correct packaged path. Node 24/26 is an explicit first-release prerequisite; do not
silently enable `ELECTRON_RUN_AS_NODE` or disable Electron security fuses. A native
standalone helper/runtime installer is a separate distribution decision.

Extend the current MCP settings section minimally with connection status and a
**Copy client configuration** action. Derive paths in main; expose only configuration
and safe status to the renderer, never the secret/descriptor contents. Copy a common
`mcpServers.showme` stdio JSON example; document host-specific configuration placement
separately. Do not rewrite any client's config or register connections automatically.
Show loading/failure states and keep Enable MCP as the single master preference.

## Verification and Phase 4 gate

Use deterministic unit tests for inspection freshness/selection/privacy, bridge
validation/limits, descriptor ambiguity/staleness and enable/disable races. Test the
real HTTP listener on ephemeral loopback ports for auth, Host/Origin, malformed and
oversize requests, revocation, response bounds and cleanup. Mock only expensive
document/capture dependencies in these transport tests.

Add one focused extended Electron file using an actual SDK stdio client and built
helper: enable through Settings, context -> inspect -> preview, decode its MCP image,
verify unchanged accepted state/selection, then disable/re-enable, switch/close a
document and close/restart the app. Verify previous credentials fail, stale requests
return no content, no unframed stdout and the helper exits on client disconnect.
Reuse Phase 3 pixel tests rather than repeating the full rendering matrix.

Register explicit declarations in `tests/registry.json`, regenerate stats and audit.
Planned commands: `npm run build`, focused `npx vitest run` with `SHOWME_TEST_FILES`
selecting new unit files, focused `npx playwright test --config
playwright.electron.config.ts` selecting the new native integration file, targeted
ESLint, `npm run test:stats`, `npm run test:audit`, and `git diff --check`.
Run independent Playwright configs sequentially. Verify packaged resource placement
and helper launch on the current host when packaging wiring is implemented; macOS
packaged execution needs a macOS host and must be reported separately if unavailable.
No full suite/release packaging cycle by default and no commit implied by this plan.

Record actual model/client traces in `CODEX_PHASE4_READONLY_EVAL.md`, using at least
three available hosts as required by the phased plan. Availability is a factual
constraint: SDK integration tests do not count as three model clients, and absent
clients are reported as untested rather than fabricated results. Compare structure,
image and combined reads on selection, slide description, text targeting, alignment,
overlap and Effect identification. Click-2 behavior must report the current sampling
limitation; phrase search requires deliberate per-slide reads, not invented search.
Record target correctness, calls, payload bytes, screenshot use, latency and errors.

The technical gate is a working authenticated real-client read loop with reliable
revocation and unchanged ShowMe state. The broader Phase 4 evaluation gate remains
open until actual client/model targeting results support it. Do not start writes
merely because the transport smoke passes.

## References checked for this plan

Official sources checked 2026-10-17:

- [SDK v2 baseline](https://ts.sdk.modelcontextprotocol.io/v2/)
- [stdio serving, ownership and stdout rules](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)
- [client stdio transport](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
- [schema libraries](https://ts.sdk.modelcontextprotocol.io/v2/advanced/schema-libraries.html)
- [tool result/schema semantics](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx)
