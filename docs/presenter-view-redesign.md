# Presenter view redesign

Research date: 2026-10-13

## Goal

Presenter view is an operational interface used under stress. It should optimize for recognition at a glance, large targets, predictable navigation and minimal mode hunting.

The presenter should be able to answer four questions immediately:

1. What is the audience seeing now?
2. What happens when I advance?
3. What do I need to say?
4. Am I on time?

Everything else is secondary.

## Market research

### PowerPoint

Presenter View centers on current slide, next slide, speaker notes, elapsed time/current time and previous/next navigation. It also exposes slide overview, black screen, pen/laser, zoom and notes text-size controls.

Useful ideas:
- current + next + notes are the permanent core
- notes font can be enlarged
- black screen is a first-class presentation action
- slide overview is available without permanently occupying space

Sources:
- https://support.microsoft.com/en-us/powerpoint/training/start-the-presentation-and-see-your-notes-in-presenter-view
- https://support.microsoft.com/en-gb/powerpoint/training/use-presenter-view-in-powerpoint

### Keynote

Keynote keeps current slide, next slide, presenter notes, clock/timer and a ready-to-advance status visible. The presenter display can be customized and notes can be resized.

Useful ideas:
- very low visual chrome
- readiness is a presentation state, not an editor concept
- current/next/notes hierarchy can be adapted to the presenter

Source:
- https://support.apple.com/en-nz/guide/keynote/tana4da2681/mac

### Pitch

Pitch Speaker View can show/hide current slide, next slide, slide navigator, speaker notes, progress line, clock and timer. The slide navigator expands to a grid when needed.

Useful ideas:
- hide secondary information until needed
- a slide navigator belongs behind one clear action
- progress is useful but should not compete with notes or slide previews

Source:
- https://help.pitch.com/en/articles/4056889-present-using-speaker-view

### Google Slides

Presenter view separates speaker notes from the audience output and provides presenter navigation. The product is comparatively sparse.

Useful idea:
- minimal permanent controls reduce hunting

Source:
- https://support.google.com/docs/answer/1696787

### Canva

Presenter View uses a separate presenter window with notes, timer, upcoming slides and controls. Remote control can expose notes on a second device.

Useful ideas:
- upcoming slides and notes are the essential private context
- remote control is valuable later, but should not complicate the desktop presenter UI

Sources:
- https://www.canva.com/help/presentation-modes/
- https://www.canva.com/help/presenting-designs/

### LibreOffice Impress

Presenter Console shows current slide, upcoming slide, optional notes and a timer.

Useful idea:
- the same basic information hierarchy has survived across very different presentation products

Source:
- https://help.libreoffice.org/latest/is/text/simpress/guide/presenter_console.html

## ShowMe-specific problem

ShowMe's Next command does not always mean "next slide". If the current slide has Click Timeline / Motion stages, the same command advances the next stage first.

The presenter UI must therefore make the next action explicit.

Examples:

- `Advance · animation 2 / 3`
- `Advance · slide 8 / 24`
- `Advance · end of presentation`

The next-slide preview should still show the next slide. This separates "what the next button does" from "what slide follows this one".

## Initial layout

### Header

One compact status row only:

- slide position
- elapsed presentation time, visually strongest time value
- wall clock

Remove the title/eyebrow chrome. It uses valuable vertical space without helping the presenter.

### Main area

Two-column layout:

- left, about 62-66%: large current audience slide
- right, about 34-38%:
  - next slide preview
  - speaker notes filling the remaining height

Speaker notes use substantially larger default type than the existing console. Provide small +/- controls beside the Notes label.

If the audience is black, show a strong overlay on the current preview. Do not rely on a small status sentence below the slide.

### Control dock

Always visible at the bottom.

Primary:
- Previous
- Advance, the largest control, with explicit next-action text

Secondary:
- Black screen
- Pause / Resume
- slide jump

Rare / risky actions:
- Restart media
- Fullscreen
- End presentation

These should be visually demoted and separated from Advance.

Keyboard navigation remains unchanged.

## Design rules

- No editor controls in presenter view.
- No hover-only essential controls.
- Do not make all actions visually equal.
- Core controls need large click targets.
- Labels should describe effects, not implementation terminology.
- Current audience state must be obvious.
- Errors and display warnings must remain visible without displacing the main UI.
- The layout should work at common laptop resolutions, especially 1366x768 and 1440x900.
- Keep current slide rendering and audience-quality image reuse unchanged.

## Phase 1 implemented on this branch

- restructure the presenter console around current / next / notes
- increase notes prominence and add local note-size controls
- make Advance the dominant action
- show whether Advance will trigger another animation stage or the next slide
- make black-screen state visually obvious
- compact the timing/header area
- move rare controls away from the primary navigation path
- keep presenter state, rendering, keyboard shortcuts and display architecture unchanged

## Later candidates

Only after testing the basic layout:

- slide navigator overlay/grid instead of a permanent select
- presenter layout presets
- ready-to-advance indicator for long-running animations
- optional countdown / target-duration pacing
- phone/remote presenter view
- laser/pointer tools
- presenter notes editing during playback
