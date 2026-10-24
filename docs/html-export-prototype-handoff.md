# HTML export prototype handoff

Branch: `chatgpt/html-export-prototype`

Status: implementation prototype only. No build, TypeScript check, lint, tests, Playwright, Electron run, browser run, packaging, or manual verification has been performed in this pass.

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
- missing Effect resources
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
10. Review initial presentation readiness. The prototype starts the canonical session with `waitForAudience=false`; unlike `AudienceOutput`, it does not currently perform the audience-ready preparation handshake before clocks begin.
11. Review CSP behavior for Blob workers and authored Effect execution from a local HTML file.
12. Check export serialization with hostile strings such as `</script>`, U+2028, and U+2029.

## Known prototype gaps / uncertainty

- No audience-ready handshake or prewarming window equivalent to desktop `AudienceOutput`.
- No HTML-specific prepared-image cache. The portable runtime deliberately renders embedded originals.
- No browser SceneTexture provider.
- Runtime build output naming/path behavior has not been checked against Vite 8 or packaged Electron/asar.
- Cross-browser autoplay/fullscreen details have not been checked. The explicit Start interaction is intended to provide user activation.
- The SceneTexture diagnostic mirrors the ordinary direct-media eligibility rules conservatively, but composition edge cases should be compared against the production renderer during verification.
