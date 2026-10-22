# General compositor revalidation — 2026-10-23

Validated branch: `chatgpt/general-compositor-fix`  
Validated code HEAD before this report commit: `8ff4fb95ef73e9244ff04781f16bfbaafd593424`

## Result

Working tree was clean before this report was added.

- Merged to `main`: no
- PR created: no
- GitHub Actions used for validation: no
- Production-code correction required: no

No production code change was justified by the review. All Linux/SwiftShader test-harness adjustments used during validation were temporary and restored.

## Local build and static validation

The branch builds successfully.

- `npm run typecheck`: passed.
- `npm run lint`: passed with 0 errors and one unrelated existing unused-variable warning in `tests/feature/media/library-work.test.ts`.
- `npm run test:core`: passed 15/15.
- `npm run test:audit`: passed with 648 active tests in 91 groups.
- `npm run test:stats`: passed and produced no repository diff.
- `npm run build`: passed.
- `tests/feature/effects/composition-plan.test.ts`: passed 13/13.

Five architecture-critical Electron compositor tests passed locally under Xvfb + SwiftShader, 5/5:

1. shared mixed prefix and dependency invalidation
2. same semantic surface across independent regional consumers
3. one failed restoration surface leaves an independent consumer working
4. one materializer failure does not poison an independent retained projection
5. lower-source changes publish one coherent frame without an async bitmap gap

The late-image audience-navigation test passed 1/1 in 4.5 seconds.

The existing 30-slide dense audience stress workload exceeded its hardcoded 120-second timeout on the 2-vCPU validation VM. With only that validation timeout temporarily raised to 300 seconds, the unchanged workload completed and all assertions passed in 2.1 minutes. The source test was then restored. This indicates a validation-host performance limit, not a correctness assertion failure in the workload.

## Architecture review

| Question | Result |
| --- | --- |
| Can two different Effect-entry points accidentally resolve to the same `SceneSurfaceRef`? | **No.** Effect-entry identity includes `effectId`, structural prefix and ordered `paintEffects`. There is also a direct test asserting two same-element effect entry surfaces differ. |
| Is semantic identity independent of crop/region? | **Yes.** Region and density are in `MaterializeRequest`, not `SceneSurfaceRef`. |
| Can unrelated consumers share one retained materialization? | **Yes.** One scene-scoped materializer is mounted per composition runtime. Regional consumers can reuse one retained provider projection. The dedicated sharing test passes. |
| Can a lower-source update expose old pixels under a new composition revision? | **No evidence of this.** Publication copies into a fresh backing canvas before publishing the revision. The coherent-publication test passes. |
| Does one source/materialization failure affect only dependent consumers? | **Yes.** Failure state is tracked per semantic surface, and both direct Electron tests and the MCP failure test confirm isolation. |
| Is `backdropRestoration.ts` genuinely source-agnostic? | **Yes.** It consumes semantic refs, materialized pixels/revisions, regions, Motion samples and resolved material. Image/shader/media/source reproduction knowledge stays elsewhere. |
| Could materialization later return a GPU texture without changing semantic planning? | **Yes.** `MaterializedSurfaceSource` already has a `gpu-texture` variant. Semantic planning has no Canvas2D dependency. |
| Is there still exactly one canonical Motion/effect timing model? | **Yes.** Composition consumes samples from the existing Motion/effect runtime. No compositor-specific clock or playback state machine was introduced. |

I found no architectural issue requiring a refactor.

There are deliberate conservative limits. The current owned provider only materializes complete `element-entry` prefixes. Exact internal `effect-entry` semantic refs exist, but unsupported internal paint falls back rather than being approximated. Browser-owned paint such as CSS classes, deck CSS and unsupported source types also falls back. Overlapping restoration consumers are conservatively excluded where regional equivalence cannot be proven. These are reasonable current boundaries.

Density is an execution-level retained-cache key, so two requests at different pixel densities may use separate backing surfaces. It does not affect semantic surface identity.

## MCP end-to-end test

The real Electron app was launched with a disposable ShowMe profile, MCP and agent editing enabled, then accessed externally through the built `showme-mcp.cjs` stdio server.

The MCP handshake succeeded with:

- server version `1.10.0`
- contract version `3`

There is no loadable `.sme`/`.smp` stress-test presentation in the repository. Existing stress coverage is the synthetic `audienceStressScene.ts` / audience-navigation harness, which was exercised separately.

Through MCP, a dedicated presentation was created containing:

- two imported managed images
- nested frame/image content
- transparency
- overlapping shapes
- generated GLSL
- a backdrop GLSL shader
- CSS backdrop effects
- text-JS
- multiple Effects on the same element
- multiple glass consumers
- overlapping consumers
- Motion
- click stages
- Presence

The important same-element stack was:

`generated GLSL -> CSS glass Effect 1 -> CSS glass Effect 2`

MCP inspection confirmed those three effects exist in that order on the same element. The direct semantic-plan test separately confirms the two CSS effect-entry surfaces have distinct semantic identities.

## MCP rendering results

Six deterministic timeline states were sampled:

- slide entry at 0 ms
- slide entry at 400 ms
- slide entry at 1500 ms
- click 1 at 400 ms
- click 1 at 1200 ms
- click 2 at 800 ms

All six rendered successfully with zero warnings. Returned metadata followed the canonical stage and clock model: stage 0, `click-1`, then `click-2`.

Visual inspection showed no missing layers, blank frames or effect resets across clicks.

### Lower generated-shader source change

A lower generated shader was updated through MCP. The identical timeline sample rendered coherently with no warnings.

Approximately 10% of RGB samples changed, as expected.

### Nested media source replacement

A nested image source was replaced while preserving the element identity and parent. The next render was coherent with no warnings.

Approximately 4.4% of RGB samples changed.

### Consumer-only Motion

`glass-a` was animated while its incoming scene remained unchanged. At the identical timeline instant, all meaningful differences were confined to the consumer's old/new bounds.

Outside that union:

- mean difference: `0.0019`
- maximum channel difference: `1`
- channels differing by more than 3: `0%`

This matches the intended behavior: move the consumer while reusing the incoming scene.

### Unrelated later paint

Only the final foreground object's fill was changed. An earlier glass-consumer region remained exactly identical:

- mean difference: `0`
- maximum difference: `0`

This is strong end-to-end evidence that later unrelated paint does not contaminate an earlier consumer.

### Failure isolation

The text-JS effect was deliberately changed so that it throws after 2.2 seconds.

MCP preview remained `ok: true` and returned one scoped `EFFECT_FALLBACK` warning naming only `text-js`.

An independent glass-only region remained byte-identical:

- mean difference: `0`
- maximum difference: `0`

The valid text effect was then restored, and the final revision rendered with zero warnings.

## MCP limitations found

The current MCP does not expose compositor materializer diagnostics such as retained build/reuse counts or `SceneSurfaceRef` values. Those assertions therefore came from the direct compositor tests, while MCP verified resulting pixels and runtime behavior.

The MCP also does not expose a presentation `start` / `advance` command. `showme.preview` does expose deterministic canonical timeline sampling, which was used for the playback verification in this pass. `showme.deliver` exposes save, save-as and package.

The current authoring contract exposes `shader`, `css` and `text-js`. It does not expose a separate generic CSS+JS Effect type. This is an MCP capability gap, not a compositor defect.

## Bugs found / fixed

No compositor correctness bug was found that warranted changing production code on this branch.

Problems encountered during testing were validation-host issues:

- missing Chromium/Electron GUI libraries
- no X server
- no native WebGL2
- software-GPU pixel differences
- insufficient CPU to satisfy the 120-second stress timeout

These were handled only in the disposable environment and were not committed.

The initial MCP authoring batch also correctly rejected modifying a template-owned slide background and explicitly instructed the client to use `slide.make_independent`. This was expected behavior.

## Assessment

**Architecturally sound.**

The branch is not fully verification-complete yet because two environment-sensitive checks remain:

1. Run the complete `native-composition.spec.ts` on a representative Windows/macOS machine or another host with real WebGL2, without SwiftShader, especially the pixel/timing-sensitive Presence cases.
2. Run the dense audience stress test under its original 120-second timeout on representative hardware.

The workload itself passed all assertions on this validation host once the slow-VM timeout was relaxed.

No architecture or production-code correction emerged from this revalidation.
