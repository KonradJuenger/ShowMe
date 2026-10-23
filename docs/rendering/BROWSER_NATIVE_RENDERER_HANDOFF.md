# Browser-Native Renderer Handoff

Branch: `experimental/browser-native-renderer`

Handoff baseline before this document: `7c8c8f37bb4683abd529593acd037f91605377d9`

Do not merge this branch into `main`. Do not create a pull request unless explicitly requested later.

## Goal

The architectural target is:

> A ShowMe slide is a DOM tree rendered by Chromium. ShowMe owns presentation semantics and timing. Custom pixel capture exists only behind one explicit SceneTexture boundary for Effects that genuinely need rendered scene pixels.

The normal renderer should remain explainable as:

> ShowMe builds a DOM tree. Chromium renders it. Motion changes native properties. Shaders own their pixels. Only explicit scene-pixel shaders call SceneTexture.

Do not broaden the compositor or introduce another general rendering abstraction.

## Required reading

Read before changing code:

- `AGENTS.md`
- `docs/rendering/BROWSER_NATIVE_RENDERER_EXPERIMENT.md`
- `docs/rendering/GENERAL_COMPOSITOR_PROTOTYPE.md`
- `docs/rendering/GENERAL_COMPOSITOR_VALIDATION.md`
- this handoff document

Then inspect at least:

- `src/components/SlideRenderer.tsx`
- `src/components/EffectSurface.tsx`
- `src/components/effectRuntime.ts`
- `src/components/sceneTexture.ts`
- `src/components/sceneTextureLegacy.ts`
- `src/components/legacyCssBackdropValidation.ts`
- `src/components/compositionSurface.ts`
- `src/components/backdropRestoration.ts`
- `src/components/elementRaster.ts`
- `src/components/useMotionRuntime.ts`
- relevant Effect schemas in `src/core/effects.ts`
- `tests/feature/effects/renderer-architecture.test.ts`
- relevant rendering/effects/presenter tests

## Current branch state

The branch has already crossed the main architectural boundary.

### 1. Normal SlideRenderer is browser-native

`SlideRenderer.tsx` no longer imports or computes `compositionBackendPlan`.

It no longer owns:

- CSS backend selection
- `browserNativeCss` admission
- restoration planning
- native backdrop group qualification
- CSS raster fallback routing
- `CompositionContext`

It still uses `CompositionPlan` for semantic DOM/Effect ordering and nesting. That is acceptable. Do not reintroduce renderer-backend selection there.

The renderer now provides only the scene information needed by explicit SceneTexture consumers through `SceneTextureSceneContext`.

### 2. CSS is unconditional

`EffectSurface.tsx` no longer accepts:

- `backdropMode`
- `compositionDependencies`
- CSS backend mode

Normal CSS mounts as scoped browser CSS. Chromium semantics are canonical, including `backdrop-filter`, opacity, clipping, stacking and blend behavior.

Do not preserve the previous custom glass/restoration semantics through another special case.

### 3. SceneTexture exists as the only explicit rendered-pixel boundary

`src/components/sceneTexture.ts` defines the semantic boundary.

Current API:

- `SceneTextureRequest`
  - `kind: "element"`
  - `kind: "backdrop"`
- `SceneTextureSampling`
- `SceneTextureProvider.prepare(...)`
- `SceneTextureProvider.acquire(...)`
- `SceneTextureProvider.invalidate()`
- `SceneTextureProvider.dispose()`
- `SceneTexture.bind(gl)`

The consumer does not receive Canvas, DOM-capture, primitive raster, compositor-surface or backend details.

Keep this API narrow. Do not move new general compositor behavior into it.

### 4. Legacy capture is behind SceneTexture

`src/components/sceneTextureLegacy.ts` is the temporary adapter.

It currently owns the old implementation details required by explicit rendered-pixel shader inputs, including:

- primitive versus DOM raster choice
- backdrop prefix calculation/filtering
- partial ancestor handling
- dependency flushing/materialization
- source transforms
- retained raster leases
- DOM/media invalidation
- `MutationObserver`
- media events
- shader-output invalidation

This complexity is allowed only because it is behind SceneTexture.

Do not make `compositionSurface.ts`, `elementRaster.ts` or `backdropRestoration.ts` more central.

### 5. Effect runtime no longer owns scene capture

`effectRuntime.ts` now imports the SceneTexture boundary instead of directly importing:

- `elementRaster`
- `domRaster`
- `compositionSurface`
- `backdropRestoration`
- CSS backdrop reconstruction

For fragment shaders:

- `input: "none"` stays GPU-owned and must not create SceneTexture.
- compatible direct shader-to-shader content chaining stays GPU-owned.
- `input: "content"` requests an element SceneTexture when direct GPU chaining cannot satisfy the input.
- `input: "backdrop"` requests a backdrop SceneTexture.

Do not force known image/video sources through SceneTexture if a later direct-media path can supply them explicitly.

### 6. MutationObserver is exceptional

Normal production modules should not depend on `MutationObserver` for rendering correctness:

- `SlideRenderer.tsx`
- `EffectSurface.tsx`
- `effectRuntime.ts`
- `useMotionRuntime.ts`

Observers remain inside exceptional/legacy capture implementation, especially `sceneTextureLegacy.ts`, and may also exist in old raster/compositor modules still used behind that boundary.

Do not introduce new observers into ordinary rendering.

### 7. Legacy CSS compositor code is isolated

CSS-specific old routing is now explicitly named `legacyCssBackdropValidation.ts`.

Old modules such as:

- `compositionSurface.ts`
- `backdropRestoration.ts`
- `compositionRuntime.ts`
- `cssBackdrop.ts`
- related capability/admission code

must not become dependencies of normal browser-native rendering again.

Some remain for retained low-level validation. Delete or shrink them only when their remaining contracts are understood and the SceneTexture boundary is proven.

### 8. Architecture regression test exists

`tests/feature/effects/renderer-architecture.test.ts` currently protects structural boundaries such as:

- normal `SlideRenderer` does not import legacy compositor modules
- CSS has no backend mode
- `effectRuntime` reaches legacy capture only through SceneTexture
- generated shaders do not create SceneTexture
- MutationObserver stays out of normal renderer/runtime files

Keep this test. Strengthen it if useful, but do not rely only on source-string assertions for runtime behavior.

## Recent implementation commits

The relevant sequence immediately before this handoff is:

- `47f1ad0890` Remove legacy CSS compositor wrappers from SlideRenderer
- `10d1449b52` Clarify compositor isolation after native cutover
- `ea79fda5a9` Isolate rendered scene capture behind SceneTexture
- `eb0912c607` Add temporary renderer branch verification
- `861e418604` Fix SceneTexture refactor type errors
- `2affaec51a` Fix temporary renderer verification filters
- `ad64b29b8f` Make legacy compositor unit check capability-neutral
- `7c8c8f37bb` Preserve nested SceneTexture capture dependencies

Treat `7c8c8f37bb4683abd529593acd037f91605377d9` as the implementation baseline for this handoff.

## What still needs to be done

The refactor is not finished merely because the structural boundary exists.

### A. Verify production reachability

Audit imports from normal production rendering and prove that these do not participate unless an explicit SceneTexture request is active:

- `compositionSurface`
- `backdropRestoration`
- `elementRaster`
- old CSS restoration/admission code

The important question is not whether the files still exist. It is whether ordinary DOM/CSS/Motion rendering can reach them.

### B. Complete runtime-level regression coverage

The original requested architecture tests include these contracts:

1. normal CSS does not import/use SceneTexture
2. normal CSS never mounts restoration
3. normal CSS never invokes `compositionSurface`
4. normal Motion on CSS does not invoke scene capture
5. generated `input:none` shaders do not invoke SceneTexture
6. explicit rendered-pixel shader inputs do invoke SceneTexture
7. SceneTexture is the only production entry point to legacy capture
8. Motion/Presence behavior remains unchanged
9. generated GLSL still renders
10. audience rendering still works

The structural test covers several of these, but do not assume all runtime contracts are proven. Inspect existing effect/presenter tests and add the smallest meaningful runtime assertions for gaps.

### C. Validate the shader input split

Keep these concepts distinct:

- generated shader: no external pixel input
- direct GPU-owned input: known shader/media source
- rendered scene input: SceneTexture

The current schema still uses `none | content | backdrop`. Do not make a disruptive persisted-schema change unless necessary.

Document internally that `content` can currently mean rendered element pixels when direct owned input is unavailable. Future image/video direct texture input should be able to bypass SceneTexture.

### D. Validate Motion hot path

For ordinary playback, verify there is no new:

- React render caused by the clock
- DOM query/tree traversal per frame
- scene planning per frame
- Canvas allocation
- scene rasterization
- image decode
- shader compilation
- general invalidation pass

Keep the existing canonical Motion/Presence/Effect timing system. Do not add another clock.

### E. Difficult presentation / MCP validation

This remains the most important missing end-to-end check against the final SceneTexture refactor.

Use a representative presentation containing, where practical:

- background image
- text
- nested frame
- video
- CSS glass
- CSS+JS
- text JS
- generated shader
- Motion
- Presence
- overlapping foreground
- at least one explicit rendered-pixel shader

Verify:

- normal DOM/CSS/media paths remain Chromium/browser-native
- generated shader remains GPU-owned
- only the explicit rendered-pixel shader crosses SceneTexture
- ordinary Motion does not trigger SceneTexture capture
- editor/preview/audience stay coherent

If the ShowMe MCP can exercise this without bypassing the renderer, use it. Record exactly what was and was not validated.

## Likely next cleanup

Do not delete modules just to reduce line count.

After runtime and presentation validation is green, the safest cleanup sequence is:

1. identify CSS-only legacy restoration/admission code with no remaining product consumer
2. remove or move those tests/helpers into clearly legacy validation scope
3. shrink or delete `compositionBackendPlan` if it has no non-legacy production consumer
4. reduce `backdropRestoration` / `cssBackdrop` if they are validation-only
5. keep `elementRaster` and `domRaster` only as temporary SceneTexture implementation details while explicit scene-pixel shaders still depend on them
6. later add direct owned-media texture input for image/video shaders
7. then reduce SceneTexture's legacy adapter further

Do not broaden `sceneTexture.ts` into another general compositor while doing this.

## Verification discipline

Run the smallest relevant tests first, then broaden because this is a cross-cutting renderer boundary.

At minimum inspect/run the relevant effects architecture/runtime tests and the audience navigation gate. Follow `AGENTS.md` for exact commands and registry requirements.

If adding or changing tests:

- register them in `tests/registry.json`
- run `npm run test:stats`
- run `npm run test:audit`

Do not claim a test was run unless it actually executed.

Do not weaken pixel tolerances or skip failing renderer tests to make the branch green.

## Known validation caveat

Earlier compositor validation documented an image-backed pixel mismatch in the old retained compositor path. Do not accidentally interpret old custom-compositor pixel equivalence as a requirement for normal CSS. Browser-native CSS semantics are now canonical.

SceneTexture rendered-pixel shaders still require correctness validation because they intentionally consume flattened/rendered pixels.

## Working rule for every change

Ask:

> Does this make the normal renderer easier to explain?

If a change makes ordinary rendering require compositor planning, raster reconstruction, CSS capability admission or general scene capture again, it is moving in the wrong direction.

## Handoff completion target

The work is ready for final report when it can be stated and demonstrated that:

> Normal ShowMe rendering is DOM + Chromium, normal shaders own their pixels, and there is exactly one narrow explicit SceneTexture doorway into legacy scene capture.

The final report should include:

1. branch and final commit SHA
2. files changed
3. resulting renderer architecture
4. what was removed from `SlideRenderer`
5. what was removed from CSS Effect routing
6. SceneTexture API
7. which code sits behind SceneTexture
8. which old compositor modules remain production-reachable
9. remaining MutationObservers and purpose
10. Motion hot-path behavior
11. tests run and results
12. real presentation/MCP validation
13. remaining architectural complexity
14. next safest deletion/refactor step

Do not merge the branch.
