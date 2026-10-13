# Drag snapping evaluation

Open **Controls → Snapping → Drag prototype**. Intent latch is the initial
selection. Switch freely between the two experiments and **Current snapping
(compare)**. Tuning is local to the open editor and captured at gesture start.
It is not saved in presentations. **Reset tuning** restores the selected mode's
defaults. The existing object/guide/slide toggles apply to both prototypes.

| Prototype | Behavior | Controls and defaults |
| --- | --- | --- |
| A · Soft magnetic | Continuous attraction into a small exact alignment zone. Neighbor midpoints limit attraction zones so dense target switches have zero correction at the boundary. | Attraction distance: 12 px; exact alignment zone: 2 px |
| B · Intent latch | Capture nearby semantic alignments when approaching slowly, allow canvas edges to replace weaker latches, release when pulling away. | Capture distance: 6 px; hold distance: 12 px (adjustable down to 0); capture below speed: 600 px/s |
| Current snapping | Existing nearest-target behavior and 10-unit movement grid. | Existing toggles |

For A, the exact zone shrinks to at most 35% of the attraction zone in dense
layouts. For B, sampled deliberate crossings can capture a target within the hold
distance even when neither sampled point lands in the capture zone. Normal release
eases to free movement at twice the hold distance. At **0 px** hold, capture still
works but the next movement on that axis releases immediately; the same alignment
cannot recapture until the pointer leaves its capture zone and approaches again.
A stationary axis can stay aligned while the perpendicular axis moves.
Speed is measured independently along each selection-scope axis, in screen
pixels, with immediate rejection of fast movement and a 32 ms decay when slowing.
Neither prototype runs a trailing animation or changes position on drop.

Try slow and fast crossings, fine corrections, crowded objects or guides, two-axis
alignment, different zoom levels, a multi-selection and dragging inside a rotated
or scaled frame. Compare ease of acquiring an intended target, unwanted catches,
stability while moving along a guide and ease of pulling away. Hold Alt during an
active drag for free movement. Alt at drag start retains duplicate-drag behavior.

Both prototypes align the start/center/end of aggregate selection bounds to the
current scope's objects, persistent guides, and slide edges/center. Intent uses
matching outer edges at canvas boundaries, center-to-center alignment for canvas
and object centers, and edge-to-edge object alignment. Object targets need to
overlap the selection on the perpendicular axis or lie within 24 screen pixels.
Persistent guides remain full-span authored targets. Target priority is explicit
guides, canvas borders, nearby object edges, canvas center, then nearby object
centers. Only a stronger eligible target replaces a held alignment; equally strong
targets remain stable. Between targets,
movement is continuous without the current 10-unit grid. Resize, rotation, guide
editing and media-content editing retain their existing snapping behavior.

## Implementation and performance

The gesture freezes targets from its starting snapshot, matching the existing
gesture baseline. Sibling bounds are computed directly from their local frames,
avoiding a scene traversal per sibling. The solver compiles, sorts and deduplicates
candidate selection positions once (O(N log N)). Magnetic uses binary search;
Intent uses a balanced range tree with bounds on both alignment position and
perpendicular object spans, plus subtree priority bounds. Queries prune distant
objects and weaker targets before examining eligible candidates. Range lookup
depends on local density, with O(N) worst-case work when all bounds overlap.
Geometry and scope matrices are
cached for the gesture. Pointer events still use the existing animation-frame
coalescing, local preview, lease, commit and rollback paths.

The current EditorSession → DocumentOperation → DocumentAuthority → durable
acceptance path is unchanged. The prototypes introduce no document schema,
recovery, storage, package, collaboration or protocol changes.

Run `node scripts/benchmark-snapping.mjs` to measure preparation separately from
queries for 100, 1,000 and 10,000 targets, including dense equal-coordinate stacks
with different perpendicular spans. Intent is measured with semantic targets and
locality queries. It compares solver costs; it excludes
rendering, document previews and the current implementation's repeated scene
target rebuilding. Timing is observational, without CI thresholds.

These are solver measurements, not a claim about total frame latency on every
presentation. Preparation and median/p95 query costs are reported separately.

For browser profiling, open the app with `?showmePerf=1` and inspect
`window.__showmePerformance()`. `interaction.snap.prepare` measures gesture
preparation, `interaction.snap.query` measures both axis queries and
`interaction.transform` measures the existing complete pointer preview callback.

## Verification

Domain tests cover magnetic continuity and monotonicity, dense target changes,
large indexed target sets, deterministic anchor/source priorities, zoom,
intent capture/hold/release, velocity timing, multi-selection, Alt bypass,
transformed scopes, mirrored sibling geometry and authority commit/undo/redo.
The reported screenshot geometry is covered with distant object clutter, left
then bottom capture, and bottom then left capture. Additional contracts cover
stronger canvas-edge handoff, deliberate crossing capture, independent axis
speeds and zero holding distance without immediate recapture.

The targeted local Chromium check exercised both modes, tuning and reset,
magnetic preview-to-accepted-position equality, undo, intent capture/hold,
Alt bypass and the current-behavior comparison selector. It recorded no page
errors. This was an ad hoc integration check; the behavioral contracts live in
the deterministic domain tests.

A follow-up Chromium check reproduced the reported corner geometry, verified
independent left/bottom capture, the Intent default, zero-hold release without
repeated recapture, accepted coordinates and undo. A rebuilt Electron app was
launched with isolated temporary storage; editor startup, native document
projection, the Intent default and the zero minimum in the native controls all
passed without page errors. An interrupted dependency install was repaired with
`npm ci --include=dev`; package manifests and the lockfile were unchanged.

Verification commands: `npm run test:feature -- editor`, `npm test`,
`npm run typecheck`, `npm run lint`, `npm run test:stats`,
`npm run test:audit`, `node scripts/benchmark-snapping.mjs` and
`git diff --check`. After dependency repair, `npm run build` and
`npm run verify:build` also passed. Chromium was installed with
`npx playwright install chromium`.
Full-suite, full release, packaged Electron and manual interaction evaluation are outside
this prototype verification.
