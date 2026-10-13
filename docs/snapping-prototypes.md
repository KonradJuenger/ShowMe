# Drag snapping evaluation

Open **Controls → Snapping → Drag prototype**. Soft magnetic is the initial
selection. Switch freely between the two experiments and **Current snapping
(compare)**. Tuning is local to the open editor and captured at gesture start.
It is not saved in presentations. **Reset tuning** restores the selected mode's
defaults. The existing object/guide/slide toggles apply to both prototypes.

| Prototype | Behavior | Controls and defaults |
| --- | --- | --- |
| A · Soft magnetic | Continuous attraction into a small exact alignment zone. Neighbor midpoints limit attraction zones so dense target switches have zero correction at the boundary. | Attraction distance: 12 px; exact alignment zone: 2 px |
| B · Intent latch | Capture when approaching slowly, retain the same target despite competing alignments, ease out when pulling beyond the hold distance. | Capture distance: 3 px; hold distance: 12 px; capture below speed: 600 px/s |
| Current snapping | Existing nearest-target behavior and 10-unit movement grid. | Existing toggles |

For A, the exact zone shrinks to at most 35% of the attraction zone in dense
layouts. For B, capture may correct position by up to the capture distance;
release is continuous, reaching free movement at twice the hold distance.
Speed is measured independently along each selection-scope axis, in screen
pixels, with immediate rejection of fast movement and a 32 ms decay when slowing.
Neither prototype runs a trailing animation or changes position on drop.

Try slow and fast crossings, fine corrections, crowded objects or guides, two-axis
alignment, different zoom levels, a multi-selection and dragging inside a rotated
or scaled frame. Compare ease of acquiring an intended target, unwanted catches,
stability while moving along a guide and ease of pulling away. Hold Alt during an
active drag for free movement. Alt at drag start retains duplicate-drag behavior.

Both prototypes align the start/center/end of aggregate selection bounds to the
current scope's objects, persistent guides, and slide edges/center. Between targets,
movement is continuous without the current 10-unit grid. Resize, rotation, guide
editing and media-content editing retain their existing snapping behavior.

## Implementation and performance

The gesture freezes targets from its starting snapshot, matching the existing
gesture baseline. Sibling bounds are computed directly from their local frames,
avoiding a scene traversal per sibling. The solver compiles, sorts and deduplicates
candidate selection positions once (O(N log N)); each axis query uses a binary
search (O(log N)) or a held-target check (O(1)). Geometry and scope matrices are
cached for the gesture. Pointer events still use the existing animation-frame
coalescing, local preview, lease, commit and rollback paths.

The current EditorSession → DocumentOperation → DocumentAuthority → durable
acceptance path is unchanged. The prototypes introduce no document schema,
recovery, storage, package, collaboration or protocol changes.

Run `node scripts/benchmark-snapping.mjs` to measure preparation separately from
queries for 100, 1,000 and 10,000 targets. It compares solver costs; it excludes
rendering, document previews and the current implementation's repeated scene
target rebuilding. Timing is observational, without CI thresholds.

A local Windows run at 10,000 targets measured median axis queries of 47.658 µs
for current snapping, 0.114 µs for magnetic and 0.072 µs for intent. Prototype
index preparation took about 4.5–4.7 ms per axis. These are solver measurements,
not a claim about total frame latency on every presentation.

For browser profiling, open the app with `?showmePerf=1` and inspect
`window.__showmePerformance()`. `interaction.snap.prepare` measures gesture
preparation, `interaction.snap.query` measures both axis queries and
`interaction.transform` measures the existing complete pointer preview callback.

## Verification

Domain tests cover magnetic continuity and monotonicity, dense target changes,
large indexed target sets, deterministic anchor/source priorities, zoom,
intent capture/hold/release, velocity timing, multi-selection, Alt bypass,
transformed scopes, mirrored sibling geometry and authority commit/undo/redo.

The targeted local Chromium check exercised both modes, tuning and reset,
magnetic preview-to-accepted-position equality, undo, intent capture/hold,
Alt bypass and the current-behavior comparison selector. It recorded no page
errors. This was an ad hoc integration check; the behavioral contracts live in
the deterministic domain tests.

Verification commands: `npm run test:feature -- editor`, `npm test`,
`npm run typecheck`, `npm run lint`, `npm run test:stats`,
`npm run test:audit`, `node scripts/benchmark-snapping.mjs` and
`git diff --check`. Chromium was installed with `npx playwright install chromium`.
Full-suite, release, packaged Electron and manual desktop evaluation are outside
this prototype verification.
