# Connect a local MCP client to ShowMe

Use a local MCP host that can launch a stdio command. ShowMe exposes its own
inspection, preview and optional editing tools; it does not connect to external MCP services. Node.js 24 or 26
must be installed and available to the host as `node` (or use its absolute executable
path in your client configuration).

## Setup

1. In a source checkout, run `npm install` and `npm run build`, then launch ShowMe
   normally. A desktop package already includes the built helper.
2. Open the intended presentation and **Settings → MCP · Experimental**.
3. Turn on **Enable MCP** and wait for **Local connection is ready**.
4. Select **Copy client configuration**, add the JSON to your MCP host's local-server
   configuration, then restart or reconnect that host. Most IDE/agent hosts discover
   MCP tools only when an agent session starts; adding the configuration mid-session
   will not make the tools appear in that already-running session.

The copied configuration uses the current app's actual absolute paths:

```json
{
  "mcpServers": {
    "showme": {
      "command": "node",
      "args": [
        "<absolute helper path>/showme-mcp.cjs",
        "--user-data",
        "<absolute ShowMe user-data directory>"
      ]
    }
  }
}
```

The angle-bracket values above are placeholders; prefer the Settings action. Hosts
with a different configuration format should use the same command/argument array
in their stdio server entry. Do not paste the connection descriptor/token into a
client config, prompt, issue or presentation. ShowMe never edits host configuration
automatically. Rebuild/restart ShowMe after changing source code; moving an install
or checkout requires copying its configuration again.

The source helper is `dist-electron/showme-mcp.cjs`. The packaged helper is
`resources/showme-mcp.cjs` outside ASAR. The helper can run from any working directory;
it uses only the explicit app-data directory and never scans for presentation files.
Closing ShowMe does not close the helper's MCP tool catalog. Subsequent calls return
`APP_UNAVAILABLE` until ShowMe is running and enabled again.

## Read loop

- Call `showme.context` with `{}` first. Its result is `{ok:true,data:...}` with
  document identity/epoch/revision, editor page/selection and `uiEpoch`.
- Call `showme.inspect` with `documentId`, `epoch`, `revision`, and a `target`:
  `{type:"deck"}`, `{type:"slide",slideId}`, `{type:"elements",slideId,elementIds}`
  or `{type:"selection",uiEpoch}`. Selection means the exact observed UI epoch.
  `includeHiddenContent` is optional within slide/elements/selection targets;
  `includeWorldTransform` is optional within elements/selection targets.
- Call `showme.preview` with the same freshness fields plus explicit `slideId`,
  `width` and `height`. Both sizes are output pixels, integer 1–2048. It returns one
  PNG image and structured metadata/warnings. Start at 960×540 or smaller; hosts may
  impose their own image/message limits.

These calls read accepted unsaved state from the running application. They do not
flush text/interaction drafts, save files, select objects, move the playhead or edit
anything. Preview state is `base`, with static video/posters and existing production
Effect clocks; click/time sampling is unsupported. Template context can be observed,
but inspection/preview targets must be presentation slides.

Notes, media bytes and filesystem paths remain excluded. Effect source and deck
stylesheet are opt-in: request `includeEffectSource:true` on element/selection detail
or `includeStylesheet:true` on deck inspection. `includeMotion` and
`includePresence` return semantic summaries rather than raw keyframes. Exact text is
available only for scoped element details; hidden content is withheld by default.

## Local editing

In Settings, enable **Allow agent editing** under the master MCP switch. It is off
by default. This is a local development feature; cross-host model evaluation is still
pending. The existing copied client configuration works without additional credentials.
Reconnect your host to refresh its tool catalog if it does not show `showme.apply`.

Inspect the actual target first. Apply accepts explicit IDs, not “current selection”:

```json
{
  "documentId": "<from context>",
  "epoch": "<from context>",
  "expectedRevision": 12,
  "mutationId": "<new UUID for this intent>",
  "slideId": "<inspected presentation slide ID>",
  "operations": [
    { "type": "text.set", "elementId": "<inspected text ID>", "text": "Updated title" }
  ]
}
```

Replace placeholders and revision with actual inspected values. Each request is one
atomic undo unit; a bad step rejects the entire batch. ShowMe generates IDs by default
and returns them. Creation operations may also accept a validated stable `id` when a
later step in the same atomic batch must target the new object. Duplication returns an
old-to-new `idMap`. A `slide.create` or `slide.duplicate` may be the first operation
in a batch and following operations then author that new slide before the single commit.

| Operation | Additional input |
| --- | --- |
| `slide.create` | `afterId`, name/background and optional stable `id`; may be first in a larger batch |
| `slide.duplicate` | Optional `afterId`, name and stable `id`; returns hierarchy `idMap` |
| `slide.delete` / `slide.move` | Delete the request slide, or move it after an explicit slide ID/null |
| `slide.update` | Name, background, hidden state, notes and/or transition override |
| `slide.template.apply` / `slide.make_independent` | Apply an existing Template or detach inherited content |
| `deck.rename` / `deck.dimensions.set` | Presentation name or width/height |
| `deck.transition_defaults.set` | Full default transition kind/duration/easing |
| `deck.stylesheet.set` | Full deck stylesheet source |
| `layer.create/update/delete/reorder` | Manage normal ShowMe Layers, including name/color/hidden/locked |
| `element.insert_text` | Parent, parent-local frame, text, optional name/typography/autosize/stable ID |
| `element.insert_shape` | Parent, rectangle/ellipse, parent-local frame, optional appearance/name/stable ID |
| `element.insert_frame` | Parent-local empty clipping Frame |
| `element.insert_media` | Existing managed `assetId`, parent-local frame, optional name/stable ID |
| `text.set` / `text.style` | Text content and local typography/autosize |
| `text.style.apply/clear_overrides/create/update/rename/delete` | Native Text Style lifecycle |
| `elements.move` / `elements.frame.set` | Explicit parent-local geometry; full frame supports rotation/scale/flip/origin |
| `elements.appearance.patch` | Fill, strokeColor, strokeWidth, opacity and radius |
| `elements.align` / `elements.distribute` | Explicit scope plus native alignment/distribution axis |
| `elements.reorder` | Direct siblings, explicit parent, front/back/forward/backward |
| `elements.duplicate` | Explicit IDs; returns old-to-new `idMap` for duplicated hierarchy |
| `elements.group/ungroup/reparent/remove` | Native structural editing; reparent preserves world appearance |
| `elements.css_classes.set` | Explicit IDs and validated CSS class names |
| `frame.fit/fill/free` | Switch media framing rule |
| `frame.content_transform.set` | Explicit inner media frame/crop transform |
| `frame.content_center/reset` | Native media Center / Reset |
| `media.transform.patch` | Media rotation/flips and rule-dependent zoom/anchors |
| `video.playback.patch` | Volume, mute, loop, autoplay, start/end time |
| `effect.apply_code` | Element, Effect type/affects, source, optional timing/parameters/existing instance |
| `effect.parameter.set` / `effect.enabled.set` / `effect.remove` | Existing Effect instance ID |
| `background.shader.create` | Name + GLSL source; creates an ordinary full-slide Element + generated Effect |
| `motion.add_preset` / `motion.animate` | Existing native Motion stage/property semantics |
| `presence.add` | Native Presence binding on the requested stage |

Text insertion treats frame x/y as the stable top-left anchor. `autoSize:"none"`
keeps the exact frame, `"height"` changes only height, and `"both"` changes
width/height after production DOM/font measurement while preserving x/y. Existing text
preserves typography; resizing uses native text auto-size/Free-media rules.

Only slide-owned content on visible unlocked layers is directly editable. Use
`slide.make_independent` to detach inherited template state when necessary. Use
`showme.inspect` with `target: { "type": "assets", ... }` to discover managed Library
assets before `element.insert_media`; results contain asset IDs, names, media type and
prepared dimensions, never filesystem paths or bytes. Importing a new filesystem file
remains a human/host action. Guest-owned documents and raw transactions remain
unavailable. One request permits at most 32 semantic steps, 128 targeted/affected
elements (including descendants), the native 256-operation limit after expansion, and
256 KiB JSON at the private bridge.

Success includes `changed`, `mutationId`, document/epoch/slide identity, previous and
accepted revision, transaction ID, generated/changed/removed IDs, a compact change set,
warnings and `replayed`. No-op success has no transaction and does not advance revision.
Receipts also include `createdSlideIds`, `updatedSlideIds`, `createdLayerIds`,
`createdTextStyleIds`, duplication `idMap` and `deckChanged`.
Preview the accepted revision after visual edits. Changing human selection/slide does
not retarget the explicit request; deleting a selected object still invokes native
selection cleanup.

### Creative authoring

Call `showme.authoring` instead of guessing ShowMe's shader/CSS/JS ABI. For example:

```text
showme.context
showme.authoring { kind: "background-shader" }
showme.apply { operations: [{ type: "background.shader.create", ... }] }
showme.preview
```

For an existing Effect, pass exact document/epoch/revision/slide plus `elementId` and
`effectInstanceId`. The result includes current source and the same authoring prompt
used by Effect Studio. `showme.context` also reports MCP server version, Effect API
version and capabilities so stale app/helper combinations are diagnosable.

### Build a deck through MCP

Keep the request `slideId` explicit. To build a complete independent slide in one
atomic operation, make `slide.create` the first step and give the new slide and
same-batch elements stable IDs:

```json
[
  { "type": "slide.create", "id": "cover", "afterId": "<existing slide ID>", "name": "A local creative partner", "background": "#152F32" },
  { "type": "element.insert_text", "id": "cover-title", "parentId": "<layer ID>", "frame": { "x": 160, "y": 220, "width": 1000, "height": 160 }, "text": "Create locally.", "autoSize": "none" },
  { "type": "element.insert_shape", "id": "cover-accent", "parentId": "<layer ID>", "shape": "rectangle", "frame": { "x": 1250, "y": 180, "width": 360, "height": 620 } }
]
```

Layer IDs are deck-wide, so they can be obtained from the source slide/deck inspection
before creating the new slide. The returned `createdSlideIds` and `createdIds` confirm
the accepted identities. This does not switch the human editor's slide or selection.
New slides have no template unless `slide.template.apply` is used. MCP never silently
copies or detaches template content. Updating inherited state returns recovery guidance
to use `slide.make_independent`.

`typography` accepts `fontFamily`, `fontSize` (greater than zero through 512, in slide units),
`fontWeight` (100–900), `bold`, `italic`, six-digit hex `color`, `align`, `verticalAlign`,
`lineHeight` (0.5–5) and `letterSpacing` (-100–500). Text style references are preserved
as native local overrides. Auto-size is `both`, `height` or `none`; the production font
measurement path updates auto-sized frames after text/style changes. For a fixed text
box, set `autoSize: "none"`, then use `elements.frame.set` to set its exact frame.
Inspect and preview after layout changes; the API does not automatically fit text to a box.

Keep the **same mutation ID and identical request** after a timeout/disconnection to
recover its result. Concurrent/helper-reconnected retries share the original work;
using that ID with different parameters fails `MUTATION_ID_REUSED`. An accepted retry
returns its original revision/IDs, even if that edit was later undone. It never reapplies
the undone edit. The registry is process-local per document epoch, limited to 1,024
identities/8 MiB of receipt metadata; it refuses new identities when full rather than
evicting accepted identities. Save/reopen, inspect the new epoch and form a new intent
when needed. It is not a durable exactly-once guarantee across process restart.

Turning editing/MCP off cancels work before admission. Once durable writing starts,
the edit can still finish; a dropped response does not mean it was rejected. A known
accepted edit with a later refresh failure returns acceptance plus a refresh warning.
For a rejected edit, inspect/recover its reported state before deliberately forming a
new intent with a new ID. No automatic stale rebase or blind write retry occurs.

The toolbar's **Agent** label has a latest-action tooltip and separate undo/redo buttons.
These user recovery actions remain available with MCP/editing off. Human Ctrl+Z stays
in human history. Authority guards can refuse agent undo after later edits or an active
lease, including structural changes to a shared parent; ShowMe will not overwrite them.

## Availability and recovery

- **APP_UNAVAILABLE:** keep ShowMe open, enable MCP, verify the user-data path and
  check Settings status. Turning MCP off/on retries a failed bridge startup.
- **AMBIGUOUS_INSTANCE:** multiple editors share that user-data directory. Add
  `"--instance", "<Instance ID from the intended editor's Settings>"` to the args.
  This explicit selection lasts for that enable cycle; update it after restart or
  off/on. The helper never silently chooses a different explicit instance.
- **EPOCH_CONFLICT / REVISION_CONFLICT:** read context and inspect again. No automatic
  rebase or retargeting occurs.
- **UI_CONTEXT_CONFLICT:** selection changed; read context and deliberately retry.
- **PAYLOAD_TOO_LARGE:** narrow the scope (at most 128 explicit element IDs), or use
  a smaller preview. Full slide/deck payloads are not silently truncated or paginated.
- **BUSY / PREVIEW_FAILED:** wait for existing work and retry deliberately.

The private bridge binds only `127.0.0.1`, authenticates each read and rejects browser
origins/fetch requests. Tokens rotate on every enable cycle. Disabling MCP immediately
revokes in-flight delivery and removes the current descriptor; ordinary thumbnails
still work. Windows descriptors inherit a restricted current-user directory ACL;
POSIX directory/file permissions are 0700/0600. This grants access to processes running
as the current OS user, not an isolation boundary against that user's own processes.

Crashes may leave descriptor files behind. The helper probes identity/authentication
and ignores unreachable/stale descriptors. A PID alone is never trusted. It will not
delete another instance's descriptor or automatically switch/open a document.
