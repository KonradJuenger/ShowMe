# Intent drag snapping

Object and multi-selection dragging uses one Intent snapping solver. Controls →
Snapping provides Capture distance (default 5 px), Hold distance (default 8 px,
minimum 0) and Capture below speed (default 600 px/s). Reset tuning restores these
values. Tuning is editor-local and is not saved in presentations.

Canvas borders accept matching outer selection edges, centers align with centers,
and object edges align with edges. Object targets must overlap the perpendicular
selection bounds or be within 24 screen pixels. Persistent guides remain full-span
targets. Explicit guides and canvas edges can replace weaker held object targets.
The two axes acquire and release independently. Deliberate sampled crossings can
capture a target; fast passes stay free. Zero hold releases on the next movement
on that axis without repeatedly recapturing the same target.

Targets, scope transforms and geometry are prepared once per gesture. A balanced
range tree prunes candidates by coordinate, perpendicular span and strength;
worst-case lookup depends on overlapping local density. Frame-coalesced previews,
leases, cancellation, semantic operations and DocumentAuthority persistence use
the existing paths. Resize, rotation, guide and media-content editing retain their
current behavior. Alt bypass and duplicate-drag behavior remain available.

Run node scripts/benchmark-snapping.mjs to observe preparation and median/p95
lookup costs for spread and stacked semantic targets. Domain tests protect zoom,
multi-selection, corner capture, target strength, object locality, sampled
crossings, independent axis speeds, zero hold and authority commit/undo/redo.
