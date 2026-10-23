# Direct GPU renderer and separated workloads

Branch: `experimental/browser-native-renderer`. PR #18 remains unmerged.

## Current ownership

```text
Normal content:             ShowMe DOM → Chromium
Motion:                     semantic values → bound CSS/native properties
Generated shader:           GLSL → visible WebGL canvas → Chromium
Compatible shader chain:    GPU texture → GLSL → texture / visible canvas
Qualified image/video:      owned media → GPU texture → GLSL
Flattened DOM/backdrop:     SceneTexture → GPU texture → GLSL
```

One WebGL2 context belongs to each mounted visible shader chain. Compatible
intermediate stages allocate framebuffer textures in that context; the terminal
stage draws into its canvas's default framebuffer. There is no terminal Canvas2D
presentation copy and no additional presentation clock. The drawing buffer is
preserved so static shader pixels remain available to later explicit SceneTexture
consumers. This has a GPU storage/presentation cost; direct output is not a claim
that Chromium's own composition has no copies.

Four independent animated chains and twelve simultaneous visible chains have
dedicated workload coverage. Existing audience residency limits bound the dense
workload to four resident slides. Context counts beyond twelve simultaneous
chains, browser-specific context limits and very large authored shader counts
remain limits of this model; there is no cross-element GPU compositor or atlas.

Context restoration recreates programs, buffers, output framebuffer textures and
input uploads. A lost chain waits for restoration instead of drawing with lost
resources. A failed upstream stage diagnoses its unavailable output rather than
recursively retrying through an unbounded Promise loop. Fault injection waits for
the browser render phase: immediate synthetic loss inside native capture's paint
task caused a Chromium native crash before delivery of the loss event.

## Semantic versus exceptional work

Shader sampling uses logical dimensions and semantic world transforms supplied
by Motion. Effect flush order is bound once for each mounted tree, so ordinary
Motion samples do not rediscover Effect descendants. Media nodes are bound at
mount or registered by their explicit load events, rather than queried each frame.

Transport (position/scale/rotation/alpha/Presence) updates native properties.
Changes to text, typography, fill/stroke and Effect paint invalidate contributing
pixels. Child/source/topology/font/stylesheet changes invalidate capture structure
or paint. The capture adapter retains observers and media/animation discovery
for arbitrary DOM/CSS. Its stable-style shortcut is used only when the callback
actually qualifies the scene; merely having a callback must not disable arbitrary
CSS animation discovery. Arbitrary document stylesheets can author dimensions
outside the model and retain explicit computed-dimension reads.

Direct media qualification is deliberately narrow: an unstyled rectangular,
undecorated, full-frame image/video with unit content opacity and neutral media
transform. Cropping, different media geometry, children, rounded decoration,
intervening CSS and arbitrary document stylesheets remain SceneTexture inputs.
The persisted `none | content | backdrop` schema is unchanged.

## Retained SceneTexture

Static, stylesheet-free, motion-free sources without video or other contributing
Effects use a shared eight-idle-entry cache. Keys include semantic source kind,
element identity, contributing serialized scene/text-style revision and logical
and sampled dimensions. Compatible consumers share source pixels; an unchanged
static source survives unmount/revisit. GPU uploads are recreated for another
context or invalid texture after restoration. Active non-static sources use
renderer-scoped leases and conservative invalidation. Dynamic sources are not
promised zero-capture revisits. Existing audience preparation warms mounted
upcoming slides; there is no new arbitrary-scene pre-rendering subsystem.

## Measurement contract

The unused general CSS compositor was deleted: `compositionSurface.ts`,
`compositionRuntime.ts`, `backdropRestoration.ts`, `cssBackdrop.ts`,
`cssBackdropOutput.ts` and `legacyCssBackdropValidation.ts`, together with tests
that explicitly selected those abandoned backends. Production import checks prove
their absence; current native composition/continuity and SceneTexture pixel tests
remain. `compositionPlan.ts` still owns semantic paint order. `elementRaster.ts`
and `domRaster.ts` remain only behind explicit SceneTexture capture.

`npm run benchmark:renderer -- --runs 3 --output <directory>` runs native,
generated, explicit SceneTexture and the unchanged dense mixed workload. Native
and generated CPU/style/layout measurements start after fixture construction and
warmup, and finish before teardown. Actual Canvas2D `drawImage`, WebGL texture
allocation/compilation, selector calls, computed styles and canvas construction
are instrumented during the sampled frames. CDP provides CPU/style/layout totals.
These tools add measurement overhead and do not measure physical display latency.

The mixed workload is version 3: all 30 slides, text, image pixels, CSS/GLSL,
Motion, navigation and residency checks remain. Dimensioned gradient/checker
PNGs are constructed before audience mounting, never during timed navigation.
Earlier one-pixel fixture measurements are not comparable.

The same fixture/harness can measure main with `--measure-baseline`; candidate
invariants apply to the candidate and baseline measurements retain baseline costs.
Unavailable baseline-specific diagnostics are labeled, not interpreted as measured
zeros. Paired report comparison rejects dirty commits, different harness digests,
schemas, run counts, CPU/platform, browser and viewport/DPR. Headless software
results must remain separate from visible Electron/hardware-GPU evidence.

Measurement results and exact verification commands are recorded below after the
clean candidate and paired baseline runs complete.
