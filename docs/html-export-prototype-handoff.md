# HTML export prototype handoff

Branch: `chatgpt/html-export-prototype`

Local verification: 2026-10-24, Windows x64, Node 26.3.0.

Status: ready for human review as a Chromium/Firefox prototype; not integrated or pushed. Existing draft PR #21 was not modified. Automatic CI remains paused.

## Direct-start follow-up

The exported HTML now opens directly into the presentation after the existing font/media readiness barrier; initial next-slide shader preparation waits for the first slide to become ready to avoid starving its text worker during automatic startup; there is no Start screen. Escape ends to a blank output and reloading starts again. Export actions and the save dialog are named “Export HTML”. If the browser rejects autoplay, VideoView exposes its existing Play control; presentation shortcuts remain available after interacting with it, while Space/Enter still operate a focused button. The earlier Start-interaction measurements below describe the original verification pass.

Follow-up checks: typecheck, focused ESLint, test audit and the two Chromium HTML browser declarations (including forced autoplay rejection and delayed SVG decoding).

## Architecture retained

One accepted presentation snapshot plus referenced original media, available managed fonts and a frozen prebuilt browser runtime becomes one HTML file. The native export still reads the current DocumentRuntime snapshot and resolves templates through the canonical model. No authority, persistence path, renderer or historical schema was added.

The standalone runtime uses SlideRenderer, presentationSession, Motion/Presence, presenterEffectClockOrigins, useSlideTransition and the existing CSS/text-JS/WebGL Effect pipeline. RenderResources defaults to the normal platform in ShowMe; the HTML host supplies EmbeddedRenderResources. There is no editor import, server, CDN, update fetch, screenshot fallback, html2canvas or slide rasterization.

## Failures found and fixed

- Initial typecheck/build failed: decoded Uint8Array was typed with ArrayBufferLike, incompatible with Blob and FontFace. Its actual ArrayBuffer ownership is now explicit; compiler rules are unchanged.
- A successful Vite library build still crashed at file startup with “process is not defined”. The library build now replaces process.env.NODE_ENV with production, producing the browser React runtime.
- Initial clocks ran before preparation, and navigation mounted incoming content too late. The host now starts with waitForAudience=true, mounts the next presentation slide, keeps the previous pixels while preparing, and releases the canonical audience-ready command only after decoded media, fonts and asynchronous Effect output. AudienceOutput and HTML share the extracted useAudienceReady handshake; there is no new clock or arbitrary readiness timeout. Navigation commands cannot bypass the HTML preparation barrier.
- Shared loading markers covered raster images but omitted SVG decoding and prepared video readiness. They now cover those media paths too. The video stays paused while the HTML host prepares its initial frame, then uses canonical VideoView playback.
- SceneTexture warnings used an incomplete duplicate test. The exporter now compiles the same composition inputs, uses the renderer's extracted compositionIsOwnedMediaOnly predicate, accounts for upstream CSS/shader composition and ignores hidden layers. Warnings identify slide, element and effect instance.
- The global poster cache could return another resource provider's frame for the same asset ID. Posters are scoped by provider; prepared video warmup also checks provider identity. Idle HTML players are released when leaving/disposal occurs. Blob URLs are reference counted and decoded lazily; disposed providers cannot mint new URLs or install a late-loading font.
- Font installation is idempotent by source across presentation restarts without hiding a partially failed installation. The inert payload DOM node is removed after JSON parsing to avoid retaining its text unnecessarily.
- The standalone CSS now includes the renderer's required border-box/font-synthesis defaults, without importing editor styling. Renderer geometry, text, scoped deck styles and Effect styles otherwise come from the shared renderer.
- Vite's public-directory copy is disabled for this runtime. Final dist-html-export contains exactly showme-html-runtime.js (489,362 bytes) and showme-html-runtime.css (1,380 bytes), with no dynamic chunks or normal editor bundle dependency. The assembler rejects multiple runtime JS bundles.
- Temporary branch/PR CI triggers were removed. .github/workflows/ci.yml matches main.

## Functionality actually exercised

The unit tests supply a temporary dummy runtime and do not require a production build. The browser file builds the current HTML runtime once before its declarations, preventing stale-bundle passes.

The durable fixture uses plain hostile text, a PNG, SVG, WebM, CSS Effects, a Blob-worker text-JS Effect, generated GLSL, direct image/video GLSL, Motion click stages and a fade transition. Chromium and Firefox tests open the assembled file with file:// and network offline, click Start, advance a stage and a slide, verify decoded media and three shader canvases, restart video, navigate back and restart the presentation. No unexpected HTTP(S) requests or page errors occurred. Node/Electron bridges are absent.

A second browser declaration delays SVG decode deliberately. The initial audience-ready barrier stays set, effect time stays zero, and input cannot advance the session until decode is released. Then canonical clocks run. This caught the missing SVG readiness marker rather than relying on an elapsed-time guess.

Additional local exploratory probes exercised:

- Group clipping and group opacity; separate frame/media rotations, media zoom and SVG opacity, confirmed in computed styles and inspected screenshots.
- Deck stylesheet application; Presence hidden before its click and visible afterward; regular, bold and italic managed FontFace variants. A missing family produced font-not-embedded. Unit coverage also checks a missing weight and exact italic/weight source selection.
- Native editor rendering, native HTML export and offline playback from both development output and an unpacked packaged application. The packaged app actually read its runtime from resources/app.asar/dist-html-export via the existing ../dist-html-export path. A separate native probe seeded an isolated ShowMe Library using the production font-library writer and verified all three variants through storage.managedFonts, native export and loaded browser FontFaces.
- An 11,687,220-byte VP9/Opus video (16 seconds, 1280x720, generated with FFmpeg) embedded with fonts into a 19,762,104-byte HTML. Export assembly took about 155 ms and file startup about 519 ms in one exploratory run. No media Blob was created before Start. Only mounted/current/next assets were decoded; binary data is not eagerly decoded for the entire payload. After several restarts/navigation cycles the observed JS heap was about 53.5 MB. These are single dirty-run observations, not comparative benchmarks or a memory bound.
- Muted autoplay; an unmuted source with audio after Start; manual Play/Pause; start/end trim; looping; restart-media; away/back and video-slide transitions. The unmuted player reported playing, mute=false and advancing time; non-looping playback stopped/reset at the trim bound and manual looping resumed inside it. This does not establish every browser/device's audio policy.
- Literal </script>, </style>, U+2028, U+2029, quotes, backslashes and HTML-like text in presentation content, with closing-tag strings in Effect source. JSON round-trips and runtime execution pass. CSP was not loosened: inline bundle, dynamic styles, Blob workers and WebGL execute while connect-src remains none. Embedded source data, rather than external files, backs runtime Blob URLs. Namespace/error-documentation URL strings in bundled code are not network dependencies.
- Unsupported DOM/content SceneTexture: export produced the detailed compatibility warning and browser rendering showed the canonical capture-unavailable error, rather than silently flattening or substituting a different effect.

Screenshots of standalone output, media, fonts, groups, transforms and the native editor were inspected. There is no general screenshot-parity claim for every possible authored deck.

## Exact verification commands and results

Dependencies/browser setup:

~~~powershell
npm ci
npx playwright install chromium
npx playwright install firefox webkit
~~~

Final static/core/unit verification:

~~~powershell
npm run typecheck
npm run lint
npm test
$env:SHOWME_TEST_FILES='["tests/feature/html-export/html-export.test.ts"]'
npx vitest run
Remove-Item Env:SHOWME_TEST_FILES
npm run test:stats
npm run test:audit
npm run build
npx electron-builder --dir --publish never
~~~

All passed. Lint has zero errors and one existing unused-variable warning in tests/feature/media/library-work.test.ts. Core: 15 tests. HTML unit: 5 tests. Registry audit: 683 active declarations / 99 groups. The build retains Vite's benign notice that inlineDynamicImports is ignored for a library build with codeSplitting=false. Packaging produced release/win-unpacked; no installer or signing claim is made.

Rendering gate plus HTML smoke (both audience declarations actually executed):

~~~powershell
$env:SHOWME_TEST_FILES='["tests/feature/presenter/audience-navigation.spec.ts","tests/feature/html-export/html-export.spec.ts"]'
npx playwright test --config playwright.config.ts --output test-results-html-export-final
Remove-Item Env:SHOWME_TEST_FILES
~~~

PASS: 4/4, including the dense animated rendering stress declaration and the late-image navigation declaration. The gate ran against the final shared renderer/readiness code. Subsequent edits affected test PNG generation, runtime public-file copying and this report, not that shared code. A focused earlier gate also passed 2/2.

Final standalone runs after switching the representative image to a real PNG:

~~~powershell
$env:SHOWME_TEST_FILES='["tests/feature/html-export/html-export.spec.ts"]'
npx playwright test --config playwright.config.ts --output test-results-html-export-browser-final
npx playwright test --config playwright.config.ts --browser firefox --output test-results-html-export-firefox-final
Remove-Item Env:SHOWME_TEST_FILES
~~~

PASS: Chromium 2/2; Firefox 2/2.

Normal Electron/PDF check, with an isolated first-launch root:

~~~powershell
$env:SHOWME_TESTING='1'
$env:SHOWME_TEST_ROOT_SELECTION=(Resolve-Path test-results-html-export-manual).Path
$env:SHOWME_TEST_FILES='["tests/feature/persistence/pdf-rendering.spec.ts"]'
npx playwright test --config playwright.config.ts --output test-results-html-export-pdf-final
Remove-Item Env:SHOWME_TEST_FILES
Remove-Item Env:SHOWME_TEST_ROOT_SELECTION
Remove-Item Env:SHOWME_TESTING
~~~

PASS: 1/1; native PDF shader output at both display densities and physical page size. Initial attempts without SHOWME_TESTING/root configuration timed out waiting for a window because native first-launch root selection was pending; no production behavior was changed to accommodate that setup.

The generated-video command was:

~~~powershell
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 16 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 10M -c:a libopus -y test-results-html-export-manual/large-audible.webm
~~~

Exploratory scripts/fixtures remain local and ignored in .scratch and test-results-html-export-*; they are not added as a large maintenance suite. They were bundled with npx esbuild --bundle --platform=node --format=esm --external:playwright and run with node:

- .scratch/html-probe-bundled.mjs (large media, fonts, CSS, group clipping, Presence and playback variants).
- .scratch/transform-scene-probe-bundled.mjs (transforms and unsupported capture diagnostics).
- .scratch/native-html-probe-bundled.mjs and the same command with --packaged (real native export/font path; packaged runtime location).
- .scratch/cross-browser-probe.mjs (supplementary Firefox/WebKit file checks with HTTP(S) routes blocked).

## Browser limits and remaining review scope

Chromium and Firefox passed the executed offline smoke coverage. No branded Chrome/Edge, macOS Safari, mobile browser or hardware matrix was run.

The Windows Playwright WebKit run used:

~~~powershell
$env:SHOWME_TEST_FILES='["tests/feature/html-export/html-export.spec.ts"]'
npx playwright test --config playwright.config.ts --browser webkit --output test-results-html-export-webkit
Remove-Item Env:SHOWME_TEST_FILES
~~~

Result: 1 passed / 1 failed. Delayed SVG readiness passed; the offline media smoke hit “WebKit encountered an internal error” at file navigation. A supplementary file run without Playwright's offline switch, with HTTP(S) blocked instead, opened text but displayed “Text effect is unavailable” and did not expose a playable video. WebKit support is not claimed; these were not worked around by relaxing CSP or adding another renderer.

DOM/backdrop SceneTexture remains deliberately unsupported in ordinary browsers. Generated GLSL and eligible direct media GLSL use the existing WebGL path. Deck CSS or upstream composition can make an otherwise plain media input require capture; warnings now use actual composition semantics. The current canonical capture error still mentions an Electron runtime even when displayed in a browser.

The exported payload is still base64 JSON parsed at startup. Removing its DOM node reduces one avoidable retained copy, but large/long-deck peak memory is not exhaustively characterized. The existing three-second preview-null retry remains; inspection and runs showed no repeated video decoding from that retry, so no new poster-storage or capability abstraction was introduced.

No full/release suite, installer, macOS build, signed package or comprehensive codec matrix was run. Frozen runtime versioning, offline single-file behavior and the current document compatibility baseline are retained. Human review should focus on representative real decks and the documented browser/capture boundaries before any later integration into main.
