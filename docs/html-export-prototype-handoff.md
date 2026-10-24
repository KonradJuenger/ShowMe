# HTML export prototype handoff

Branch: `chatgpt/html-export-prototype`

Status: implementation prototype with a completed static source review. The review found and fixed concrete compile, architecture and browser-runtime defects. A real build, TypeScript check, lint, test, Playwright, Electron run, browser run, packaging run and manual exported-file verification have still not been executed. This remote environment cannot clone the repository, and connector-created GitHub events did not start the repository's intentionally paused Actions workflow.

## Architecture

The prototype adds a browser-target presentation runtime without adding a renderer or presentation state machine.

The HTML runtime reuses:

- `SlideRenderer`
- `presentationSession` (`startSession`, `applyPresentationCommand`, `presentationShortcut`)
- Motion and Presence through the normal renderer/runtime
- Effect clocks through `presenterEffectClockOrigins`
- `useSlideTransition`
- the existing CSS, text-JS and GLSL Effect execution paths
- the existing composition planner for browser-direct GLSL qualification

Renderer media access is behind the narrow `RenderResources` contract. The normal ShowMe platform registers itself through the core resource registry. The HTML runtime supplies `EmbeddedRenderResources`.

The export assembler embeds the resolved presentation snapshot, referenced original media, selected managed font files, runtime metadata, runtime CSS and the built IIFE runtime into exactly one HTML file. Media bytes remain base64 in the inert payload until requested; the browser provider then creates Blob URLs lazily and releases them by reference count.

The embedded snapshot contains only presented slides and strips speaker notes. Hidden-layer media/fonts are not embedded. Hidden layer element data remains inside otherwise visible slide snapshots so Motion/effect target topology is not destructively rewritten in this prototype; the normal renderer still excludes those layers.

## Static review fixes

The review found and corrected:

- a real compile error in `useAssetUrl` where a removed `platform` import was still referenced
- renderer-resource ownership leaks in video warmup/pooling
- direct `SlideRenderer` harnesses throwing when no resource provider was installed
- platform importing a React component solely to register resources; the registry now lives in `core`
- duplicated SceneTexture/direct-media qualification; export diagnostics now use the same composition rules as `SlideRenderer`
- Vite 8 single-bundle configuration, now using Rolldown `codeSplitting: false`
- missing build invariants for `dist-html-export`
- browser font-face failures aborting the presentation; they are now nonfatal runtime warnings
- duplicate embedded font installation after presentation restart
- missing renderer base CSS relevant to geometry/typography
- browser autoplay rejection leaving authored autoplay video stuck with no control; a fallback Play control is shown
- clocks/transitions starting before current media/effects were ready; the HTML host now uses the canonical `audience-ready` command and renderer loading state
- image-only loading diagnostics; renderer loading state now covers all media
- silent readiness degradation; timeout/effect-preparation problems now surface runtime warnings before playback is released
- hidden slides, notes and hidden-layer resources being unnecessarily included in the portable output
- all-hidden decks prompting for a save path before failing
- non-embedded relative/network/file CSS resources being silently blocked by the offline CSP
- SVG resources with sibling/network/file references being silently blocked
- managed fonts referenced only through visible authored `font-family` CSS being omitted
- vague/duplicated font warning locations
- hardcoded HTML format-version validation

## Diagnostics and browser limits

The exporter warns for:

- missing media
- managed font lookup failure
- used non-portable fonts that cannot be embedded
- managed fonts referenced by visible authored CSS when they cannot be embedded
- missing Effect resources
- non-embedded CSS resources
- non-embedded SVG resources
- audible video autoplay that a browser may reject
- GLSL content/backdrop inputs that require Electron SceneTexture capture

Generated GLSL and direct neutral image/video GLSL remain on the existing browser WebGL path.

Electron SceneTexture capture remains unsupported in ordinary browsers because `domRaster.ts` depends on `drawElementImage` / `requestPaint`. No screenshot, html2canvas, Canvas2D renderer or flattened fallback was added.

## Verification priorities

1. Run `npm run typecheck`.
2. Run `npm run lint`.
3. Run `npm run build`.
4. Run `npm run verify:build`; this now checks that `dist-html-export` contains exactly one JS bundle and at most one CSS bundle.
5. Run the rendering gate, preferably `npm run test:feature -- presenter`, ensuring `tests/feature/presenter/audience-navigation.spec.ts` actually executes and passes.
6. Export a minimal text/image deck and open the one HTML file through `file://`.
7. Verify hidden slides/layers and notes are absent from playable/exported resources as intended.
8. Verify canonical navigation semantics: click stages, previous/next, pause, black, media restart, fullscreen and transitions.
9. Verify Motion, Presence, CSS Effects, text-JS worker Effects, generated GLSL and direct image/video GLSL.
10. Verify unsupported SceneTexture Effects produce an export warning and visible runtime failure rather than incorrect pixels.
11. Verify initial/incoming slide readiness waits for image/video/effect preparation and then releases `audience-ready`.
12. Verify audible autoplay fallback, normal manual video controls and restart-media behavior.
13. Verify large-video Blob URL lifetime and memory behavior.
14. Verify managed font matching/installation for text and explicit CSS `font-family` references.
15. Check serialization with hostile strings such as `</script>`, U+2028 and U+2029.
16. Test the single HTML file in Chromium, Firefox and Safari where practical.
17. Verify packaged Electron can read `dist-html-export` from the final asar layout.

## Known prototype limitations / uncertainty

- No browser SceneTexture provider.
- No HTML-specific prepared-image cache or desktop-style lookahead/prewarming window. The portable runtime renders embedded originals.
- Media readiness has a 12-second bounded wait. It releases with a visible runtime warning instead of hanging indefinitely.
- CSS font discovery covers explicit `font-family` declarations, not every `font:` shorthand, CSS variable or computed stylesheet case.
- Hidden layer element data remains in visible slide JSON even though hidden-layer resources are not embedded or rendered.
- Relative/external CSS and SVG resources are diagnosed but not recursively embedded.
- Runtime build output and packaged Electron/asar paths have not been executed.
- Cross-browser Blob worker, OffscreenCanvas/WebGL2, fullscreen and `file://` behavior have not been executed.
- Large exports are assembled in memory as JSON/base64/HTML; no arbitrary size limit was introduced.
- System fonts are never scraped or embedded; only ShowMe-managed font bytes are eligible.
