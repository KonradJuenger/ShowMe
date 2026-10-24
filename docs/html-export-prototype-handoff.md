# HTML export prototype handoff

Branch: `chatgpt/html-export-prototype`
Status: implementation prototype with a completed static source review. The review found and fixed several concrete integration defects. A real build, TypeScript check, lint, tests, Playwright, Electron run, browser run, packaging, and manual file verification still have not been run because this remote environment cannot clone the repository and connector-created GitHub events did not start the paused Actions workflow.

## Architecture

The prototype adds a browser-target presentation runtime without adding a renderer or presentation state machine.

The HTML runtime reuses:
- `SlideRenderer`
- `presentationSession` (`startSession`, `applyPresentationCommand`, `presentationShortcut`)
- Motion and Presence through the normal renderer/runtime
- Effect clocks through `presenterEffectClockOrigins`
- `useSlideTransition`
- the existing CSS, text-JS, and GLSL Effect execution paths

Renderer media access is now behind the narrow `RenderResources` contract. The normal ShowMe platform is registered as the default provider. The HTML runtime supplies `EmbeddedRenderResources`.

The export assembler embeds the resolved presentation snapshot, referenced original media, selected managed font files, runtime metadata, runtime CSS, and the built IIFE runtime into exactly one HTML file. Media bytes remain base64 in the inert payload until requested; the browser provider then creates Blob URLs lazily and releases them by reference count.

## Diagnostics and browser limits

The exporter warns for:
- missing media
- managed font lookup failure
- used non-portable fonts that could not be embedded
- managed fonts referenced by visible authored CSS when they cannot be embedded
- missing Effect resources
- external CSS resources blocked by the offline CSP
- audible video autoplay that a normal browser may reject
- GLSL content/backdrop inputs that require Electron SceneTexture capture

Generated GLSL and direct neutral image/video GLSL are intended to remain on the existing browser WebGL path.

Electron SceneTexture capture remains unsupported in ordinary browsers because `domRaster.ts` depends on `drawElementImage` / `requestPaint`. No screenshot, html2canvas, Canvas2D renderer, or flattened fallback was added.

## Verification priorities

1. Run TypeScript/typecheck first. Pay particular attention to the new Vite lib configuration and the `RenderResources` structural typing.
2. Build `dist-html-export` and confirm it produces one JS runtime plus the expected CSS with no dynamic chunks.
3. Build Electron and verify `dist-html-export` is present at the path used by `electron/main.ts`, including packaged/as ar layout.
4. Export a minimal text/image deck. Open the single HTML through `file://` in Chromium, Firefox, and Safari where practical.
5. Verify canonical navigation semantics: hidden slides, click stages, previous/next, pause, black, media restart, fullscreen, and transitions.
6. Verify Motion, Presence, CSS Effects, text-JS worker Effects, generated GLSL, and direct image/video GLSL.
7. Verify unsupported SceneTexture Effects produce export warnings and fail visibly rather than silently producing wrong pixels.
8. Verify large video behavior and Blob URL lifetime. The payload is parsed as JSON at startup, while binary media decoding is lazy.
9. Verify managed font matching and FontFace installation for exact family/weight/italic combinations.
10. Verify the HTML host's audience-ready handshake: incoming slides wait for mounted image/video/effect readiness before canonical clocks and transitions are released.
11. Review CSP behavior for Blob workers and authored Effect execution from a local HTML file.
12. Check export serialization with hostile strings such as `</script>`, U+2028, and U+2029.

## Known prototype gaps / uncertainty

- No HTML-specific prepared-image cache. The portable runtime deliberately renders embedded originals.
- No browser SceneTexture provider.
- Runtime build output and packaged Electron/asar paths have not been executed. The Vite 8 configuration was checked against current Vite/Rolldown documentation and uses `rolldownOptions.output.codeSplitting=false`.
- Cross-browser autoplay/fullscreen behavior has not been executed. Audible autoplay has a fallback Play control and export warning.
- CSS font discovery covers explicit `font-family` declarations, not every possible CSS `font` shorthand or computed stylesheet case.
- The audience-ready host waits for mounted image/video/effect readiness, but does not implement the desktop prepared-image cache/prewarming window.
