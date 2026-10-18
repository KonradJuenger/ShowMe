# Current ShowMe MCP contract

Server 1.8.0. Document, SME/SMP, effect API and native schedule formats remain public v1. Canonical schemas returned by tools/list and showme.authoring are authoritative.

## Discovery and context

Call showme.context first. Accepted document identity includes id, epoch, revision, savedRevision and dirty. Editor context is ephemeral and includes the human's page, selection and UI epoch. Reading context never flushes drafts or warms the agent runtime.

Capabilities describe supported operations. services.agentRuntime separately reports uninitialized/initializing/ready/failed, queue occupancy and lazy initialization. An uninitialized service can initialize on its first request.

Use showme.authoring with kind=operations for the operation catalog, then family or operation and detail=compact for canonical JSON Schemas, validated examples, limits and target/result rules. Families include template, slide, deck, layer, element, elements, text, frame, media, video, background, effect, motion, presence and timeline. Workspace, preview and delivery have dedicated authoring kinds with canonical request schemas. Unknown operations and mismatched families reject.

Omitting detail preserves earlier guides and full creative-code prompts. Request a shader/CSS/text effect kind with detail=full when writing executable effect source. contractVersion and schemaDigest cover static operation contracts only. Scoped discovery requires documentId, epoch, revision and slideId; its scope/ownership observation is revision-bound and must not be cached as document state by digest.

Raw SDK tools/list retains the canonical nested operation shapes. The SDK adds top-level type=object to the union of request forms. This session cannot directly inspect host normalization internals; a host's unknown nested alternatives are not evidence that the server omitted the schema. Compact discovery is an independent usable path.

## Accepted-state inspection

showme.inspect requires documentId, epoch, revision and a target: deck, slide, elements, selection or assets. Selection additionally requires the observed uiEpoch. Notes, effect source, stylesheet, world transforms, Motion and Presence details are opt-in. Hidden text remains withheld unless requested.

Elements expose owner, parent-local frame, hierarchy, appearance and content. Slide backgroundOwnership identifies inherited template ownership and suggests slide.make_independent. Template-owned content still rejects unauthorized edits. Timeline inspection exposes stable stage/block/track IDs; requested element Motion includes native tracks/blocks/keyframe IDs and Presence includes its block/stage IDs.

## Semantic mutation

showme.apply requires documentId, epoch, expectedRevision, mutationId and request-context slideId, plus exactly one form:

- operations: 1-128 semantic operations on the inspected page. slide.create/duplicate may be first; following operations author the new page.
- pages: 1-8 groups of {slideId, operations}, at most 128 operations and 128 affected elements total. A new group must begin with slide.create whose explicit id equals its group slideId. Existing groups target inspected pages. Deletion/duplication retain the single-page form.

The request/source bridge budget remains 256 KiB; at most 32 renderer effect validations run per transaction. Later page groups see earlier staged layer/style/deck changes. Native semantic commands stage against a detached current document, then one EditorSession submits one transaction through the existing DocumentAuthority and durable recovery. A late failure commits no pages or deck changes. No separately committed writes are presented as atomic.

Exact epoch/revision admission, ownership, assets, leases, cancellation and access generation checks apply to all pages. Human navigation and selection are not moved by construction. Agent history uses the existing mcp-local actor and preserves human history.

Receipts contain historical revision/previousRevision/transactionId, mutationId, changed, replayed, created/changed/removed identities and created timeline IDs. slideId retains request context, duplicated explicitly as requestSlideId. authoredSlideIds identifies transaction page targets; createdSlideIds is authoritative for new pages. Page batches add per-page results. Replaying an identical mutationId returns the original historical transaction plus a separate currentObservation. That observation is not a guarantee that the next write will succeed. Reusing an ID for changed intent rejects. No-ops retain revision and have no transaction ID.

Validation errors include bounded field paths/issues or operation stepIndex; page failures include pageIndex. Errors do not echo full requests or effect source.

## Native timeline authoring

Use Presence for lifecycle/entrances/exits and Motion for property values while present. Parent Frames animate grouped components with child geometry remaining parent-local.

- presence.add accepts stageId or stageIndex, startOffsetMs, end and entrance/exit transitions. presence.update/remove target one blockId and preserve unrelated blocks.
- motion.animate accepts numeric native/effect properties, delayMs, durationMs, named easing and stable stageId. motion.add_preset additionally accepts supported native settings: Move distance/cardinal direction, Scale/Pulse scale, Rotate angle/rotation direction, Fade opacity.
- motion.block.update/remove targets blockId; update can revise delay, duration, easing and destination stageId.
- timeline.stage.create returns a stable stage ID; timeline.stages.reorder requires all stage IDs exactly once and retains entry first. timeline.stage.remove accepts an empty click stage or explicit mergePrevious. Entry cannot be removed.
- effect.schedule.set creates or edits the native trigger of an element/effect instance; effect.schedule.update targets its blockId. Start offset, native stops and progress easing remain separate from effect time and numeric Motion.

Schedules keep current versions. Native validation rejects property conflicts, overlapping Presence intervals, deleted/foreign identities and stops referencing an earlier click. Presence slide-end supports Exit None only. Native non-click effect schedules have zero offset; use click start at entry for a delayed slide entrance. Stage-index inputs remain supported under exact revision checks; prefer stable IDs after reordering.

## Text measurement and fit

showme.measure_text requires documentId, epoch, revision and 1-64 items of text, width, optional authored height and typography. It awaits production managed fonts and DOM text layout, including explicit line breaks, without adding document state.

Results retain width/height and add laid-out contentExtent, overflow against the authored box, requested family availability/source and fallback uncertainty. Managed and platform-loadable local families are distinguished. Exact fallback/glyph identity is not established and resolvedFamily is null. A failed local-family load reports unavailable to this renderer; it is not an inventory assertion about every OS face. Font-family lists remain uncertain. No width guessing or second layout engine is used.

## Production preview and deterministic samples

showme.preview requires exact documentId/epoch/revision/slideId and output width/height, each integer 1-2048. Omitted sample returns state=base, an explicitly unsampled authored composition.

sample.mode=timeline supplies presentationOriginMs, activationMs, strictly increasing reached clickTimesMs, captureTimeMs, and optional explicit previousSlideId. Clicks must exist and occur after activation and no later than capture. Native playback navigation derives stages; paused production clocks freeze Motion, Presence, CSS effects, shaders, text workers and raster preparation independently of queue delay.

finite-complete uses the same trace and an explicit reference captureTimeMs at or after known finite deadlines. It never invents future clicks or slide-end events. Unbounded effects are sampled at that reference time and have no promised final frame. This admission requirement is a deliberate refinement of the proposed implicit completion design: one coherent reference time avoids contradictory clocks.

transition supplies distinct previousSlideId, elapsedMs and explicit incoming/outgoing traces sharing presentation origin and capture time. Incoming activation plus elapsedMs equals captureTimeMs, and incoming previousSlideId must identify the actual prior page. Both slides compose through the production audience transition hook. Backward/jump origins are explicit rather than inferred from ordering.

samples requests 1-6 frames, at most 5 megapixels total, under the same cancellation/revision/access checks and native capture queue. Each frame returns image content and resolved metadata. Partial output is discarded on failure. Native capture acknowledgement and readiness checks remain required. Video is a static poster. Numerical shader tolerance is appropriate; cross-GPU byte identity and audience smoothness are not promised.

Preview never navigates the human editor, advances real playback, persists sampled text, adds history or dirties a document.

## Native delivery

showme.deliver requires documentId, epoch, expectedRevision and action=save/save-as/package. It returns a structured written/cancelled result, actual accepted revision, format, destination, overwrite=native-policy and a separate current observation when available.

Save uses an associated destination or native picker for an untitled document. Save As and SMP package export use existing native dialogs; a host may explicitly configure the existing SHOWME_DOCUMENT_DIR destination policy. Arbitrary model-provided filesystem paths, raw serialization and automatic overwrite outside native policy are unavailable.

Delivery never flushes another actor's unaccepted drafts. Exact identity/revision/access/cancellation is checked inside the existing authority persistence lock, after any picker. The accepted snapshot is written by native storage/package services; saving adds no synthetic authoring revision/history. Later accepted edits remain dirty. Cancellation before persistence writes nothing. After admission, native durability may complete even if access changes; clients must refresh context instead of blindly overwriting/retrying.

SME and SMP preserve native animation/effects. SMP is the initial export format. Static PDF/PPTX delivery is not exposed by this tool and must not be described as preserving arbitrary shader/CSS/JS playback.

## Boundaries retained

Transport loss after dispatch of workspace or delivery returns `OUTCOME_UNKNOWN`;
the helper does not resend the operation. Read context and inspect the native
library/destination before deliberately requesting new work. An explicit access
rejection is returned unchanged without resending. Safe reads retain bounded
rediscovery and apply retains native mutation-ID replay. This does not add durable
workspace/delivery receipts or an exactly-once guarantee across process restart.

One current document model, DocumentAuthority, renderer and persistence path. No raw DocumentOperation tool, direct document JSON writes, arbitrary JavaScript execution, filesystem browsing or Electron IPC passthrough. Managed assets are inspected/inserted by authorized asset IDs; importing new files remains a supported human/host workflow.

## Reusable design and native workspace (1.7)

`template.create` starts a batch and subsequent visual operations target its new template. Use the returned `createdTemplateIds`; `template.background.set` edits an existing explicitly targeted template. Inspect `deck.templates`, then inspect the template ID through slide/elements inspection. Apply templates through `slide.template.apply`. Editing their content updates dependent slides through native inheritance; inherited elements remain protected when targeting a slide. Template timelines and slide-only metadata are not accepted. Delete only unused non-default templates with `template.delete`.

`text.style.define` creates or updates a named style directly by ID and typography. Names are unique ignoring case. Apply by stable style ID. Existing native overrides and clear-overrides remain available.

`effect.resource.capture` names an existing instance's definition on its native page. `effect.resource.attach` creates another independent instance of that resource on the same page. `effect.resource.update` validates new source once and updates its users atomically, respecting editable scopes and native parameter Motion invariants. Sources remain page-owned; shared template elements provide cross-slide reuse. Opt into `includeEffectResources` on slide inspection to read page resources. Native per-page resource and per-element instance bounds remain in force.

A reusable slide recipe is an ordinary authored slide. `slide.duplicate` accepts `textReplacements`, keyed by source slide-owned text element IDs. It preserves template/style references and native motion, returns cloned element `idMap`, and rejects a missing/non-text slot atomically. No parallel recipe schema is persisted.

`budget: "expanded"` explicitly raises admission to 32 page groups, 256 semantic operations and 512 affected elements. Standard remains 8/128/128. Both enforce the native 256-operation transaction, 32 renderer validations and 256KiB transport bounds. Expanded limits do not guarantee that a complex semantic intent fits the native transaction; split coherent intents when necessary. New template groups, like new slide groups, start with their create operation and matching explicit ID.

`showme.workspace` requires current documentId/epoch/expectedRevision and editing opt-in. Actions: create(name), open(optional path), close, import-assets(optional paths). Save before create/open/close; it never discards dirty content. Supplied paths must resolve inside the user-selected root, including symlink resolution. Omitted paths invoke native pickers. Create/open notify the existing editor and require a fresh context; the first observation can be loading. Open reuses an already loaded runtime. Close drains the native authority and closes the editor after its receipt. Import uses native managed storage and prepares raster dimensions when Electron decodes the image; unsupported metadata still needs native preparation before insertion. Library imports do not add an authoring revision and are not an atomic document transaction.

CSS effects support scoped `@supports`, including privately scoped keyframes, in addition to `:scope` and `@keyframes`. Global/descendant selectors and other at-rules remain unsupported. There is no reduced-motion cap; ShowMe supplies the full authored clocks.


## Diagnostics, receipts and native preparation (1.8)

SDK input admission returns bounded structured INVALID_REQUEST errors (at most eight issues, 300-character paths and 200-character messages). Canonical Standard Schema JSON metadata remains unchanged in tools/list. SDK 2.3 converts schema failures to text-only results, so the adapter retains the canonical advertised schemas and validates through those same Zod schemas in the callback before bridge dispatch. Matching operation/form schemas supply field diagnostics; full request refinements remain authoritative. Unknown operations identify the type path. No input source is echoed.

Workspace create/open return result.document (id, name, epoch, revision, savedRevision, dirty), initialPageIds.slides/templates, and readiness guidance. Authority readiness does not imply editor acknowledgement. Poll context until availability=ready and editor.documentId matches the receipt; replace the COMPLETE document identity after every open, including SMP's new native ID. Accepted dirty state, unaccepted editor work, focused editing and active leases block lifecycle switches. No draft is flushed. Native open/create recheck admission before activation; close rechecks after authority draining.

For action=package, optional packageOptions requires both mediaLocked:boolean and speakerNotes:include/remove. Choices use the existing package writer and authority admission lock; omission preserves human native questions. Native destination/overwrite policy still applies. Explicit unattended choices return fontWarnings instead of opening informational font questions. They do not embed unavailable font licenses or alter source notes. Package options on save/save-as reject.

Import uses production media enrichment in the isolated native runtime for raster, SVG and video, including browser orientation, dimensions, duration and prepared video posters. The isolated surface returns preparation data; native storage persists catalog/poster updates after admission. It has only scoped asset/font read IPC, no catalog write capability. Imported assets can outlive a failed request: result.atomic=false, result.items preserves indexed imported/failed/not-attempted receipts, preparation state, managed asset identity when available, and recovery errors. result.assets includes successful imports even if preparation failed. Retry only the indicated items. These are library operations, not atomic document transactions.

Inspection adds slide.pageKind/displayName and element.ownerPageKind/inherited without changing native page ownership or the relative source field. Native templates retain ordinal labels; their display name includes label and authored ID. No new persisted naming field is introduced. slide.recipe.slots derives owned text IDs, element names and withheld-safe previews; inherited text is excluded. Native duplication preserves notes; use slide.update with notes to replace them.

Apply receipts add authoredPages (id and slide/template kind) and resourceChanges (owning page, resource ID, created/changed/removed kind and current element users). Replays retain these historical changes. Resource capture removes its previous definition only if the renamed instance was its last user, preserving instance IDs and parameter Motion. effect.resource.prune removes other unused page definitions through native slide.effects.set and native animation validation. Referenced definitions are retained.

Style-name collisions include conflictingStyle.id/name and remediation: reuse that ID or choose a unique name. Full native typography still owns its color; no separate color-role or global resource model is implied.

Production static previews prepare native video posters before mounting/capture. Offscreen media preparation waits for a seek-completed drawable frame, avoiding black posters captured immediately at loadeddata. Video remains a static poster in sampled previews; no live playback performance claim follows.
