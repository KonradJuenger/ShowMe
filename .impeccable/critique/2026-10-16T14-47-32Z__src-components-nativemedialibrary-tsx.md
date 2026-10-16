---
target: media tab
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:D:\\local_programming\\ShowMe-1\\src\\components\\NativeMediaLibrary.tsx"
target_fingerprint: "sha256:2ffbbb42c53d6e3e0e104063673d1b27f1e5cd58dd36b6fd897c0e79af692cde"
target_path: "D:\\local_programming\\ShowMe-1\\src\\components\\NativeMediaLibrary.tsx"
timestamp: 2026-10-16T14-47-32Z
slug: src-components-nativemedialibrary-tsx
---
Method: dual-agent (A: media_design_review · B: media_detector_review)

# Media tab analysis

Target: `src/components/NativeMediaLibrary.tsx`, with the AssetLibrary and RightSidebar CSS context.

## Design specificity and overall impression

Borderless, content-first previews suit ShowMe's expressive presentation workflow. Organization controls feel like a generic file manager squeezed into a narrow sidebar. The main opportunity is dependable spatial continuity: selection must not move the content being selected.

## Design health

| Heuristic | Score | Key evidence |
|---|---:|---|
| Visibility of system status | 3/4 | Selection outline/count, breadcrumbs, loading placeholders and alerts exist. |
| Match system / real world | 3/4 | Familiar folder operations; Cleanup protection needs context. |
| User control and freedom | 2/4 | Close/Cancel/Done exist; Escape only clears explicit selection mode. |
| Consistency and standards | 2/4 | Files/folders select on click; effects apply on click; activation differs. |
| Error prevention | 3/4 | Destination filtering exists; moving hit targets undermine activation. |
| Recognition rather than recall | 1/4 | Folder names hidden at rest; activation gesture undisclosed. |
| Flexibility and efficiency | 2/4 | Drag and bulk selection exist; Enter cannot open folders or insert media. |
| Aesthetic and minimalist design | 2/4 | Clean previews lose priority to an administrative block after selection. |
| Error recovery | 2/4 | Alerts remain in context but raw failure strings lack recovery guidance. |
| Help and documentation | 1/4 | Tooltips and accessible labels exist; activation/protection poorly explained. |
| Total | 21/40 | Significant improvement needed. |

## Strengths

- Borderless previews prioritize presentation content without permanent filename clutter.
- Type filtering and folder breadcrumbs provide a simple organizational model.
- Drag insertion and bulk selection support repeated media reuse.

## Priority issues

1. **[P1] Selection shifts the entire grid.** `NativeMediaLibrary.tsx:551` inserts the action region before the list in normal flow. Folder selection displaced the grid 115–179px across Assessment B's 280/320/360px hosts. Assessment A's 284px sidebar fixture measured 147px for image selection and 179px for folder selection. A normal Playwright double-click failed to enter a folder after the first click moved the target; direct double-click event dispatch worked. This demonstrates a fixture interaction hazard, not a confirmed native Electron failure. **Fix:** selection must preserve grid position; use an anchored menu or stable action region. Command: `impeccable layout`.

2. **[P1] Folders have no visible identity at rest.** `NativeMediaLibrary.tsx:814` uses the shared hidden filename overlay, styled in `style.css:771` and revealed through `NativeMediaLibrary.css:338`. Folder glyphs compute to 28×28px in 80–107px tiles in Assessment B. Names exist in accessible button labels, but are visually hidden until hover/focus. **Fix:** persistent readable folder names and stronger folder icons; preserve borderless media thumbnails and hover-only media filenames. Command: `impeccable clarify`.

3. **[P2] Management controls overwhelm browsing.** `NativeMediaLibrary.tsx:599` exposes four equally weighted folder commands. `NativeMediaLibrary.css:162` supplies a real 4px gap: zero spacing was not reproduced. `RightSidebar.css:134` and `:397` produce actual 12px text, 28px height and 4px/6px padding, overriding parts of the local styling. Long labels wrap into two to four rows, making a large administrative block. **Fix:** secondary organization commands in a coherent item menu; deliberate control sizing and spacing within the existing visual language. Commands: `impeccable distill`, then `impeccable polish`.

4. **[P2] Keyboard activation is incomplete.** `NativeMediaLibrary.tsx:799` opens folders/inserts media only through double-click. Enter selects and opens management actions without completing navigation/insertion. **Fix:** keyboard activation while preserving intended selection, drag insertion and effect application. Command: `impeccable harden`.

5. **[P2] Item ellipsis opens distant controls.** The `native-library-more` button selects the item, exposing the same in-flow action panel instead of a nearby menu. **Fix:** make the ellipsis open an anchored, dismissible action menu; keep batch actions in a stable location. Command: `impeccable layout`.

## Cognitive load and emotional journey

Moderate load: visual hierarchy, spatial memory and task focus fail after selection. Four folder commands plus dismissal compete with the user's intention to navigate. The calm initial grid becomes a moving target and an administrative surface. Successful insertion can restore confidence, but the activation path is poorly communicated.

## Persona red flags

- Power user: repeated placement loses spatial continuity; double-click can chase a moving target.
- Keyboard/low-vision user: names unavailable visually at rest; Enter cannot open or insert. Accessible names and focus outlines are useful foundations.
- First-time user: selecting a folder presents protection/move/delete before explaining how to open it.

## Minor observations

- Protection wording is long and lacks contextual explanation of cleanup.
- Raw failure strings do not consistently suggest a recovery action.
- Initial asynchronous listing can briefly look like an empty folder.
- The library details menu lacks explicit close-on-action handling.

## Recommended direction and decisions

Keep the grid stable, label folders persistently, make folder silhouettes legible, and move item management into an anchored menu. Retain content-first previews, filtering, breadcrumbs, virtualization/pagination, drag insertion, effect application, cleanup semantics and the current document/storage architecture. Do not reintroduce search or change persistence as part of this UI pass.

Decisions for the refactor: labeled folder tiles versus full-width folder rows; anchored item menus versus a fixed bottom action area. These are interface choices, not reasons to replace the product's visual identity.

## Detector evidence

Source detector command: `impeccable.cmd detect --json src/components/NativeMediaLibrary.tsx src/components/AssetLibrary.tsx`. Exit 0, JSON `[]`, zero findings. The clean mechanical result does not cover the reproduced interaction defects.

Headless browser detector injection succeeded. It reported two low-contrast findings in the underlying editor shell (Saved: 4.3:1; Click Timeline: 4.49:1), outside this target. No media-target detector findings. There is no user-visible browser overlay.

## Evidence boundaries

Independent headless Chromium reviews used real components/global/sidebar CSS with synthetic inventory. No live Electron library, filesystem operations, native dialogs, screen-reader session or document insertion was verified. A and B did not see each other's results. Screenshots and computed evidence are intentionally retained under `.agenttmp/media-critique-a/` and `.agenttmp/media-critique-b/`. Production files remain unchanged.
