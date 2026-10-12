# Click Timeline UX mental model

## Problem

The current Click Timeline exposes several controls that overlap conceptually:

- Play / Pause
- Preview / Edit mode
- Next click
- Space
- block-level Preview
- Edit states

The implementation reflects that overlap. `preview` currently acts as both renderer state and transport state, while its presence is also used as a UI mode flag. Scrubbing or selecting a block can create a paused preview implicitly. The top-level Preview/Edit toggle only adds or removes that state. `Edit states` is a different, real authoring mode.

This makes the UI hard to predict because controls that look like modes, playback commands, and presentation commands are mixed together.

## Mental model

The Click Timeline has click gates and timed intervals.

```
Slide start        Click 1            Click 2
    |-----------------|------------------|
       interval 0         interval 1
```

Each gate triggers the interval to its right. The playhead is always at one exact point in one interval.

There are only three user concepts.

### 1. Playhead

The playhead answers:

> What state of the slide am I looking at?

Clicking a gate, clicking the ruler, or scrubbing moves the playhead. While the Click Timeline is open, the canvas should always show the slide resolved at the playhead.

There is no separate global Preview mode. Opening and interacting with the timeline already means inspecting the authored result.

Closing the Click Timeline returns to ordinary slide editing.

### 2. Transport

Play / Pause answers:

> Let time run from the current playhead.

Play runs only inside the current click interval. It must never fire a click gate automatically.

At the end of the current interval it stops at the gate. Pressing Play again at the end should replay that same interval from its start rather than advancing to another click or wrapping around the slide.

This makes Play a normal timeline transport control.

### 3. Presentation advance

Advance answers:

> Trigger the next presentation click.

The Advance button and Space are exactly the same command.

Advancing:

1. resolves the current interval to its final state,
2. crosses the next click gate,
3. starts the newly triggered interval.

This mirrors presenter behavior without conflating it with Play.

In the editor Click Timeline, the final click should stop at the end of the current slide rather than silently wrap. Whether editor preview should optionally continue to the next slide is a separate feature and should not be hidden inside Play.

## State editing

`Edit states` is not the opposite of Preview.

It is a local authoring mode for a selected Motion block:

> At this playhead position, changes to the element author or modify a Motion state.

Keep it in the Motion block inspector, visually separate from transport.

While Edit states is active:

- scrubbing inside that block may remain available, because choosing another state is part of editing;
- starting playback or advancing to another click should leave Edit states before transport begins;
- the UI must continue to show clearly that document edits are being mapped to Motion states.

## Proposed header

The Click Timeline header should contain:

```
Click Timeline   [Play/Pause] [Advance]   [+ Click]   [Fit] [Zoom]   [Close]
```

Tooltips / accessibility labels:

- Play
- Pause
- Advance to next click (Space)
- Add Click
- Fit timeline
- Timeline zoom
- Close Click Timeline

Remove the global `Preview / Edit mode` toggle.

The gate headers remain:

```
Slide start | Click 1 | Click 2 | ...
```

Clicking one moves the playhead to the start of that interval. It does not imply playback.

## Naming cleanup

Use words according to one meaning only:

- **Play / Pause**: time transport.
- **Advance** or **Next click**: presentation input. Pick one visible term and use it everywhere.
- **Edit states**: authoring Motion states.
- **Play animation** or **Play block**: block-scoped playback. Do not call this simply Preview.
- **Preview**: avoid as a mode name in the Click Timeline. The whole open timeline is already a preview context.

Recommended visible term: **Advance**. Tooltip: **Advance to next click (Space)**. It describes the action rather than the destination and maps well to presenter behavior.

## Current inconsistencies to remove

### Preview state is overloaded

`MotionWorkspace` stores `preview: MotionPreviewState | null`.

Its presence currently means several things:

- the canvas is being resolved through Motion;
- there is a transport position;
- playback may be running or paused;
- the header calls the UI Preview rather than Edit mode.

These should not be encoded through nullability.

Conceptually separate:

```
timelineOpen
cursor = { stageIndex, time }
transport = stopped | playing
editingStates = false | selected block
```

The exact implementation can still reuse `MotionPreviewState`, but the UI must not treat `preview !== null` as a user-facing mode.

### Play currently crosses click gates

At the end of an interval, `play()` advances to the next stage and wraps from the final stage back to the first.

That overlaps with Next click / Space and violates the click-gate model.

Play should remain inside one interval.

### Space and Next click are the same idea but are not presented as one command

The editor already routes Space to `motionWorkspace.next()` while the Click Timeline is open.

Make this relationship explicit in the UI. The button should expose the Space shortcut and both should share the same command path.

### Block Preview collides with global Preview

The block context menu and Motion inspector use Preview to mean play this one animation block.

Rename this to Play animation / Play block.

### Adding Motion auto-previews

Adding Motion currently starts the new block automatically. Existing tests even need to explicitly return to authoring before continuing.

Auto-playing a newly created block can remain useful, but it should be understood as a one-shot `Play block` action, not as entering a persistent Preview mode.

## State machine

### Timeline opens

- canvas shows the current playhead state;
- playhead defaults to Slide start unless a retained cursor exists;
- transport is stopped.

### Seek / scrub

- move playhead;
- transport stops;
- canvas immediately shows the resolved state.

### Play

- if stopped inside an interval, run from current playhead;
- if stopped at interval end, restart that interval from its start;
- stop at interval end;
- never cross a click gate.

### Pause

- freeze at current playhead.

### Advance / Space

- leave Edit states if necessary;
- settle the current interval;
- move to the next click gate;
- start that interval;
- at the final gate/end, remain at the end of the slide.

### Click a gate heading

- seek to time 0 of that gate's interval;
- remain stopped.

### Edit states

- selected block owns the editing context;
- canvas changes author Motion state at the playhead;
- scrub can select another state/time in the block;
- Play or Advance exits state editing before transport starts.

### Close timeline

- stop transport;
- exit state editing;
- return canvas to ordinary editor rendering.

## Why this is simpler

Every control answers a different question:

- playhead: where am I?
- Play: let time run.
- Advance / Space: fire the next click.
- Edit states: change the animation at this point.

There is no fourth concept called Preview that sometimes means rendering, sometimes playback, and sometimes the opposite of editing.
