# Codex plan: Keynote-inspired presenter view

## Objective

Refine the presenter view on `chatgpt/presenter-view-redesign` using the decisions in `docs/presenter-view-redesign.md`.

Use Keynote's presenter display as the primary reference:
- current and next slide as the main visual row
- notes below, spanning the available width
- minimal status/timing chrome
- simple readiness indication

Improve it for ShowMe by explicitly communicating what the next Advance input will do.

Do not add customization.

## Before editing

1. Read `AGENTS.md`.
2. Read `docs/presenter-view-redesign.md` completely.
3. Inspect:
   - `src/components/PresenterConsole.tsx`
   - `src/components/PresentationControls.tsx`
   - `src/components/usePresenterController.ts`
   - `src/core/presentationSession.ts`
   - `src/core/motionPlayback.ts`
   - `src/presentation.css`
   - presenter feature tests
4. Inspect the current branch diff against `main`. Preserve useful existing work rather than restarting blindly.
5. Do not modify `main`.

## Phase 1: derive presenter state cleanly

Create a small presenter-specific view-model/helper if useful. Avoid embedding increasingly complex playback logic directly in JSX.

It should derive, from existing state only:

- visible slide position
- next slide position
- whether another motion/click stage remains
- what Advance will do:
  - another animation stage
  - next slide
  - end
- readiness state:
  - ready
  - animating
  - paused
  - audience black
  - preparing audience if relevant

Important:
- reuse existing PresenterState / motion timing
- do not invent a second playback state machine
- do not change persistence or document formats
- if exact readiness cannot be derived from current state, identify the smallest missing runtime signal instead of approximating from arbitrary timers

Add focused unit tests for this derivation if a helper is introduced.

## Phase 2: rebuild the layout around Keynote

Update `PresenterConsole.tsx` and CSS.

Fixed layout:

1. thin top status strip
   - slide number
   - elapsed time
   - wall clock

2. thin readiness/status indicator

3. main preview row
   - current slide left, about 60-65%
   - next slide right, about 35-40%
   - preserve aspect ratios
   - current is visually dominant
   - minimal labels

4. notes region below previews
   - spans full content width
   - large readable text
   - independent scrolling
   - A- / A+ controls
   - must not resize previews while scrolling

5. bottom controls
   - Previous
   - dominant Advance with explicit sublabel
   - Black screen
   - Pause / Resume
   - slide navigation
   - rare actions under More

Do not create layout settings or customization controls.

## Phase 3: readiness behavior

Keynote uses a simple ready/not-ready presentation indicator. Implement the ShowMe equivalent.

The presenter should immediately understand:

- motion/transition currently active
- ready for next input
- paused
- audience output black

The state should be visual first, textual second.

Keep accessibility:
- do not encode state by color alone
- expose useful accessible labels/status text

Do not disable Advance merely because something is animating unless the existing presentation semantics require it. Presenter UI must reflect runtime behavior, not invent new behavior.

## Phase 4: Advance semantics

The primary control must accurately describe the next input.

Examples:

`Advance`
`Animation 2 / 3`

`Advance`
`Slide 8 / 24`

`Advance`
`End`

Check edge cases:

- slide with no motion
- first motion stage
- middle motion stage
- final motion stage
- final slide
- previous navigation through motion
- paused state
- black audience output
- empty/no-visible-slide state
- audience preparation state

The button label and keyboard Space/Enter behavior must correspond to the same existing command semantics.

## Phase 5: responsive behavior

Manually or with browser tests inspect at:

- 1366x768
- 1440x900
- 1920x1080

At 1366x768, all of these must remain visible without document-level scrolling:

- current slide
- next slide
- useful notes region
- readiness
- primary navigation

Notes may scroll internally.

Avoid CSS breakpoints that cause controls to disappear unexpectedly. If secondary controls must collapse, collapse only secondary/rare actions.

## Phase 6: verification

Run the smallest relevant checks:

- `npm run test:feature -- presenter`
- `npm run typecheck`
- relevant browser/component test if available

If CSS/layout behavior has no useful automated coverage, do not add brittle pixel tests. Report the resolutions manually inspected.

Run `npm test` only if production logic outside the presenter component changes meaningfully.

## Deliverable

When complete:

- keep all work on `chatgpt/presenter-view-redesign`
- summarize the UI/state changes
- list exact tests run and results
- list manual resolutions checked
- identify anything still uncertain
- report final commit SHA
- stop and wait for explicit authorization before merging to `main`
