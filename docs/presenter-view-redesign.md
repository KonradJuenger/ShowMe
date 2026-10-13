# Presenter view redesign

Research date: 2026-10-13

## Product decision

ShowMe presenter view will use **Keynote's presenter display as the primary design reference**.

We are not copying Keynote pixel-for-pixel. We are adopting its mental model because it is the clearest under presentation stress:

- current slide and next slide are the visual center
- presenter notes are a large dedicated region
- slide position and time are always visible but visually secondary
- readiness is communicated as presentation state
- navigation is simple and keyboard-first
- secondary functions do not compete with the presentation itself

For now there is **one fixed presenter layout**. Do not add presenter-layout customization, draggable panels, presets, visibility toggles or configuration UI.

Apple's current Keynote presenter display exposes current slide, next slide, presenter notes, a ready-to-advance indicator, clock/timer and slide navigation. Keynote also changes readiness while transitions/builds are active. That basic model is the reference.

Primary source:
- https://support.apple.com/en-hk/guide/keynote/tana4da2681/mac

## Goal

Presenter view is an operational interface used under stress. The presenter should not need to hunt for functionality.

At a glance it must answer:

1. What is the audience seeing now?
2. What comes after this?
3. What happens if I press Space / Advance now?
4. What do I need to say?
5. Am I on time?

Everything else is secondary.

## Reference layout: Keynote, simplified

### Top status strip

A thin strip only.

Left:
- slide position, e.g. `7 / 24`

Center/right:
- elapsed presentation time
- wall clock

Do not add a product title, "Presenter Console" heading or other chrome.

### Readiness indicator

Use Keynote's ready/not-ready idea, but make it more informative for ShowMe.

A thin full-width state indicator should communicate whether the next input can advance cleanly:

- active transition / motion: not ready
- settled: ready
- paused: paused
- audience black: black

Do not require the presenter to read a paragraph to understand this.

Keynote uses a red/green state bar. ShowMe can use the same simple concept, but the exact colors should follow the application's existing palette and accessibility requirements.

### Main visual row

Follow the Keynote spatial model:

- large current slide on the left
- next slide on the right
- both visible simultaneously
- current slide is larger than next slide because it is the most important reference

Target proportion:
- current: about 60-65%
- next: about 35-40%

The labels `Current` and `Next` should be small and visually quiet.

### Notes region

Presenter notes span the width below the slide previews.

This is a deliberate change from the first branch experiment, where notes were placed in the right column.

Reasons:
- matches the Keynote mental model
- gives long notes enough line length and height
- avoids squeezing notes beside the current slide
- lets the presenter's eye move vertically: slides -> notes -> controls

Notes should:
- use a large readable default size
- scroll independently
- provide simple A- / A+ controls
- preserve line breaks
- never resize the slide previews while scrolling

### Controls

Keep permanent controls extremely small in number.

Primary:
- Previous
- Advance

Advance is the dominant action.

Secondary:
- Black screen
- Pause / Resume
- slide navigator

Rare / risky:
- Restart media
- Fullscreen
- End presentation

Rare actions belong behind one `More` control or another clearly separated area.

Do not implement Keynote's presenter-layout customization.

## ShowMe improvement over Keynote

ShowMe has a state that Keynote's generic `next slide/build` model does not explain clearly enough: pressing Advance may trigger another Click Timeline / Motion stage instead of changing slides.

The presenter should never have to infer this from the slide.

The Advance control must state what the next input does.

Examples:

- `Advance`
  `Animation 2 / 3`

- `Advance`
  `Slide 8 / 24`

- `Advance`
  `End`

This is separate from the next-slide preview. The preview answers "what slide follows this one?" while the Advance label answers "what will Space do right now?"

### Ready-to-advance semantics

The readiness indicator and Advance label should agree.

Examples:

- a motion stage is currently running:
  - status = `Animating`
  - Advance remains available according to current runtime semantics
  - next-action label still describes the next stage/slide

- stage settled and another stage exists:
  - status = `Ready`
  - Advance = `Animation 3 / 3`

- final stage settled:
  - status = `Ready`
  - Advance = next slide

- audience black:
  - current preview gets an obvious black-output state
  - status indicates `Audience black`

Do not create a parallel playback model for presenter UI. Derive these states from the existing PresenterState / motion state.

## Interaction principles

- Space / Enter / Right Arrow remain the primary forward controls.
- Left Arrow remains previous.
- Mouse buttons must be large enough to use quickly but should not visually overpower the slides.
- No essential action is hover-only.
- No editor controls appear in presenter mode.
- No hidden modes.
- No layout customization in this iteration.
- Do not change presentation document formats or persistence.
- Do not change audience rendering quality.
- Do not add a second presentation runtime.

## Responsive targets

The fixed design must work at least at:

- 1366 x 768
- 1440 x 900
- 1920 x 1080

At smaller presenter resolutions, preserve priority in this order:

1. current slide
2. next slide
3. notes
4. Advance / Previous
5. elapsed time
6. secondary controls

Do not solve small screens by introducing a configurable layout system.

## Current branch status

Branch: `chatgpt/presenter-view-redesign`

The branch already contains an initial experimental presenter redesign. Treat its implementation as provisional.

Keep useful work from it:
- explicit Advance semantics
- larger note typography
- stronger audience-black indication
- demotion of rare actions
- compact timing
- unchanged presenter/runtime architecture

Revise:
- move from the experimental right-column notes layout to the Keynote-inspired slides-above / notes-below layout
- add a simple readiness indicator
- simplify visual chrome further
- make the result feel like one stable presenter surface, not a dashboard

## Out of scope

Do not add yet:

- customizable presenter layouts
- draggable/resizable presenter panels
- presenter presets
- remote/phone presenter
- laser pointer or drawing tools
- presenter notes editing during playback
- target-duration pacing
- new document schema
- new presentation runtime

## Acceptance criteria

The redesign is successful when a presenter can glance at the screen for less than a second and reliably identify:

- current audience slide
- next slide
- whether the presentation is ready/animating/paused/black
- what Advance will do
- current notes
- elapsed time

The UI should remain understandable with no mouse movement and no opened menus.
