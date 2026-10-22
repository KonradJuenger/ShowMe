# Local general-compositor validation — 2026-10-22

Evaluated branch: `chatgpt/general-compositor-fix`, HEAD
`c91f9d5504f07a22ecc5e1049c0231a449cf90bf`, plus the local corrections
described below. The initial checkout was clean on `main`; the requested existing
remote-tracking branch was checked out locally. During validation, no merge,
commit, push, PR or GitHub-hosted test was performed. All execution was local on
Windows. A subsequent request to update the branch authorizes committing and
pushing the corrections on top of newer remote work, with `[skip ci]`.

Verdict: **functionally promising, requiring more verification; not merge-ready**.
The corrected abstraction is useful, but one image-backed pixel contract still
fails, and accepted unrelated edits replace the renderer's retained runtime.

## Subsequent branch update

The remote branch advanced to `5ca148b` during local validation. The local
corrections were replayed on that newer work rather than replacing it. The newer
scene-scoped runtime API, lazy observer activation, restored publication-test
cleanup and additional failure-isolation coverage were preserved. In particular,
the earlier observation below that runtime activation depends on restoration is
historical: the newer branch owns a lazy materializer for every rendered scene.
The earlier MCP evidence describes the validated candidate, not a fresh MCP pass
against all 29 intervening remote commits.

On the combined branch, `npm run build`, focused ESLint, `npm run test:stats`,
`npm run test:audit` and `git diff --check` passed; registry counts are now 648
tests in 91 groups. The native file is rerun with:
`$env:SHOWME_TEST_FILES='["tests/feature/effects/native-composition.spec.ts"]'; npx playwright test --config playwright.electron.config.ts --output test-results-compositor-branch-update`.
It finished with **15 passed, 1 failed**: the same image-backed comparison still
reports maximum error 13 against limit 3. Both failure-isolation declarations and
the added publication/readiness/reference-clock assertions passed.
The original validation results below remain dated evidence for the original
candidate. Neither the full suite nor the MCP presentation sequence was repeated
merely to update the branch.

## Local verification

The production build succeeded before architecture review and again after the
corrections. `npm run build` includes `verify:typescript` and `tsc --noEmit`, Vite
production output and the Electron/MCP build.

| Command | Result |
| --- | --- |
| `npm run build` | Passed, including TypeScript |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed; one existing unused-import warning in `tests/feature/media/library-work.test.ts` |
| `npm test` | 15 core tests passed |
| `npm run test:feature -- effects` | 105 unit tests passed; browser phase 49 passed, 1 failed; runner stops before Electron |
| `$env:SHOWME_TEST_FILES='["tests/feature/effects/composition-plan.test.ts"]'; npx vitest run` | 13 passed |
| `npm run test:stats` / `npm run test:audit` | Regenerated stale statistics; audit passed, 647 declarations / 91 groups |
| `$env:SHOWME_TEST_FILES='["tests/feature/presenter/audience-navigation.spec.ts"]'; npx playwright test --config playwright.config.ts --output test-results-compositor-audience-browser` | Both dense rendering stress and late-image navigation declarations passed |

The effects browser failure is the prompt wording assertion at
`tests/feature/effects/authoring.spec.ts:507`. Both that file and
`src/core/effectAuthoring.ts` are identical to `main`; the assertion expects a
sentence the current prompt does not contain. It was left unchanged.

The native compositor file initially had 11 passes and four failures: an obsolete
bitmap readiness wait and three pixel comparisons. Updating the wait to the actual
materialization API and honoring the host's display density fixes three of those
failures. The image-backed source-change comparison still reaches a maximum
channel error of **13**, exceeding its unchanged limit of **3**; mean error passes.
The new publication/readiness/density and reference-clock assertions pass.
Final command:
`$env:SHOWME_TEST_FILES='["tests/feature/effects/native-composition.spec.ts"]'; npx playwright test --config playwright.electron.config.ts --output test-results-compositor-final-verification`
finished with **14 passed, 1 failed**. No failed declaration was skipped or its
pixel tolerance increased.

The full/release suites, packaging build and repeated performance benchmarks were
not run. The audience stress run is correctness evidence, not a performance
improvement claim. Initial invocations using the wrong Playwright runtime for the
audience file, and Vitest without its registry selection variable, selected no
meaningful product execution; the corrected commands above executed the tests.

## Architecture review

Reviewed `GENERAL_COMPOSITOR_PROTOTYPE.md`, `compositionPlan.ts`,
`compositionSurface.ts`, `compositionRuntime.ts`, `compositionBackendPlan.ts`,
`backdropRestoration.ts`, `elementRaster.ts`, renderer integration, Effect runtime,
media readiness and relevant tests.

| Question | Finding |
| --- | --- |
| 1. Can different same-Element Effect entries collapse? | No in the planner: identity includes point kind, Element ID, Effect ID, structural prefix and ordered Effect dependencies. Current owned materialization deliberately declines internal Effect-entry surfaces. |
| 2. Is identity independent of region? | Yes. Region and density are request/execution fields; neither enters `SceneSurfaceRef.id`. |
| 3. Can independent consumers share? | Yes within one scene runtime and density. Direct regional requests reuse a publication. Live audience diagnostics showed two exact semantic surfaces sharing one retained execution projection after regional culling. |
| 4. Can publication expose old pixels under a new revision? | The new backing-store copy and revision publish together. A separate lifetime defect cleared previously returned canvases; corrected by retaining those canvases until their consumers release references. Source-change correctness still has the documented pixel mismatch, so pixel equivalence is not certified. |
| 5. Are failures isolated? | Rejections are handled by semantic surface, and the independent retained-surface test passes. Unsupported later text can use fallback without making earlier owned paint unsupported. MCP rejects invalid shader code atomically before live mounting; that is admission isolation, not proof of live GPU failure isolation. |
| 6. Is restoration source-agnostic? | Yes: it consumes refs, pixels/revisions, logical bounds/density, crops, native material and canonical Motion samples. Images, media transforms, shader lookup and source invalidation live elsewhere. |
| 7. Can a GPU texture replace the materialized source? | Semantic planning can remain unchanged. The source union already names `gpu-texture`; actual context ownership, synchronization/release and a GPU-capable restoration consumer still require backend work. Current Canvas2D restoration explicitly rejects that source kind. |
| 8. Is there one timing model? | Yes. Motion, Presence, CSS, shaders and text JS use existing native timing. The corrections add readiness cancellation and dependency filtering, not an animation clock. |

The materializer is a standalone module owned once by `mountCompositionRuntime`,
not once per restoration consumer. Production currently activates that runtime
when restoration is selected; standalone API use is possible, while another
production consumer would need explicit activation/lifetime wiring.

Capability and preparation/creation are owned by the same primitive provider.
The provider remains narrow. The standalone materializer now also rejects deck
CSS, matching restoration's conservative admission rule.

Two important limits remain: `SlideRenderer` rebuilds composition/runtime on
accepted scene-object replacement, even for later foreground-only edits; and
retained sources are full-slide allocations with scene-disposal lifetime, rather
than a bounded regional eviction policy. Failure rejection is local, but loading
and sequential restoration preparation are not a proof of independent latency.

## Corrections made

- Preserve earlier published canvases instead of clearing their pixels when a
  newer publication is installed. A regional consumer regression now retains and
  checks the old publication after a lower-source update.
- Wait on existing `waitForSlideImages` markers for the projection's source
  Elements before examining mounted images. Previously, a prepared MediaSurface
  with no mounted image could permanently reject an otherwise supported prefix.
  Disposal cancels the wait. This fixes the observed live-audience image fallback.
- Ignore generated Effect-host reference-clock style writes for retained-source
  invalidation; owned shader output events/revisions remain authoritative. This
  fixes unnecessary repaints even when shader output is static.
- Publish the actual rounded backing-size density, so logical crop coordinates
  match the primitive painter's scale. This does not solve all fractional-display
  image sampling differences.
- Reject deck CSS through the standalone materialization API too.
- Keep the entrance readiness test at the materialization boundary, use actual
  display density in the native harness, extend existing contracts, update their
  registry description and regenerate stale statistics. Pixel tolerances and the
  audience gate are unchanged.

## MCP and real presentations

Inspected the raw MCP tool catalog and protocol/operation/code/preview contracts
before authoring. Used `showme.context`, `inspect`, `authoring`, `workspace`,
`apply`, `preview` and `deliver` over the actual built stdio MCP helper and native
application bridge. Persistent changes followed EditorSession/DocumentAuthority.
No direct document-state writes were used to author the presentations.

MCP has deterministic production preview sampling but no playback-control tool.
Actual presentation navigation used native UI controls and audience keyboard
shortcuts through Playwright. Compositor counters not exposed by MCP were read
from the running browser for diagnostics, without mutating renderer state.

No saved stress-named SME/SMP was found in the checkout/parent or configured
presentation root. The existing six-slide **ShowMe — Ideas in motion** deck was
therefore opened through MCP first. Its 18 timeline frames (0, 400, 2200 ms per
slide) had no warnings and were visually reviewed as a contact sheet. All six
slides were also advanced in actual audience mode. The repository's separate
synthetic dense stress presentation was exercised by the passing audience test.

The dedicated three-slide portable presentation contains:

1. Two checker images, translucent ellipse, generated GLSL, two disjoint rounded
   glass consumers, later text and a moving/fading foreground object. Glass has
   staggered Left/Right Move In and Up/Down exits; foreground Motion is click-driven.
2. Two backdrop-sensitive CSS Effects on the same Element with intervening
   magenta paint, overlapping glass, nested frame text, generated GLSL, a backdrop
   channel-rotation shader, programmable CSS+JS text, Scale In, Rotate In, Move In
   from above, directional exits and click-driven scale Motion.
3. An earlier owned glass consumer and a later consumer whose prefix includes
   browser-owned text. Invalid GLSL was deliberately submitted and safely rejected
   with `EFFECT_VALIDATION_ERROR`, leaving accepted state unchanged.

Both-Effect versus second-Effect-only MCP screenshots visibly differ as expected;
the magenta incoming paint is present only when Effect 1 is enabled. The existing
planner unit tests separately establish distinct semantic Effect-entry identities.

Fourteen dedicated timeline frames covered entry, stagger, settled state,
click-driven exit and completion. After the image-readiness correction all 14 had
zero warnings. Their images, contact sheet, metadata and mutation receipts are
in `artifacts/compositor-validation-2026-10-22/`. Audience screenshots additionally
exercise entrances, exit clicks, slide change and returning. Screenshots establish
sampled correctness; they do not exclude every possible single-frame flash.

Lower image content-transform changes and lower shader-parameter changes were
authored through MCP during playback, then sampled through production preview.
The lower image was also atomically replaced with the other managed checker image
and restored through MCP removal/insertion/reordering, retaining its paint order.
Both replacement previews had no warnings and visibly used the new source.
Their source changes repaint. An unrelated later foreground edit is accepted but
replaces the live composition runtime: the retention requirement is not yet met
across document revisions. Within a stable runtime, after the clock invalidation
fix, the canonical Move In sample interval had **one build, zero invalidations**
throughout while reuse rose from 5 to 305, with two semantic refs / one source.

The independent runtime-failure test passes, but the supported MCP authoring path
does not let invalid shader code reach a live source. Do not describe its atomic
validation rejection as an induced live compositor failure.

The portable artifact is
`artifacts/compositor-validation-2026-10-22/Compositor validation.smp` and a copy
is under the configured `showme-examples/compositor-validation-assets-2026-10-22`
directory. Native save/package delivery was verified. An earlier default-user
Save picker timed out with `OUTCOME_UNKNOWN`; it was not blindly retried. The
reviewable artifact was subsequently delivered using a separate test-user native
destination policy and saved through MCP.

## Remaining merge work

1. Reduce and resolve the remaining image-backed source-change pixel error of 13
   versus the required maximum 3 on this Windows/display configuration. Keep the
   pixel contract intact and distinguish image sampling from publication timing.
2. Preserve dependency-valid materializations across accepted document revisions;
   prove a later foreground edit leaves the earlier retained runtime/pixels intact
   through the MCP path, not only by changing fixture DOM styles.
3. Rerun the full native compositor file green, the relevant MCP source-change
   cases, and both audience declarations against the final candidate. The unrelated
   prompt-text assertion needs separate acknowledgement or maintenance.
4. Recheck failure/loading isolation and conservative regional admission at the
   intended supported boundary. Unsupported browser paint must remain on fallback.

Still intentionally unsupported by the owned provider: internal Effect-entry
materialization, text/video/browser CSS paint, text JS source paint,
content/backdrop-input shaders as lower owned sources, partial ancestor prefixes,
overlapping restoration consumers and unsupported transforms/effect stacks. Those
cases continue through established fallback paths. No new document schema,
authority, persistence path, timing system or GPU scene graph was introduced.
