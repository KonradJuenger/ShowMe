# Click Timeline UX mental model

## Core model

The Click Timeline has two explicit canvas modes:

- **Edit**: show the raw authored slide. Motion does not alter the canvas.
- **Playback**: show the presentation state resolved at the playhead.

This is separate from transport. Play, Pause and Advance are actions, not modes.

The timeline itself is still structured as click gates with timed intervals:

```
Slide start        Click 1            Click 2
    |-----------------|------------------|
       interval 0         interval 1
```

The playhead always identifies one exact point in one interval.

## Edit

Edit answers:

> Show me the slide I am authoring.

In Edit:

- elements render from their authored document state;
- Motion, Presence and Effect timeline state do not alter the canvas;
- ordinary element editing behaves normally;
- the playhead position is retained but does not change what the canvas shows.

"Initial state" means the raw authored element state before Motion is resolved. It is not necessarily the same as presentation time 0.

Closing the Click Timeline returns to Edit.

## Playback

Playback answers:

> Show me what the audience sees at this playhead position.

In Playback:

- the canvas resolves Motion at the current playhead;
- clicking a click heading seeks to that gate;
- clicking the ruler or dragging the playhead seeks continuously;
- keyboard playhead movement seeks in the same way.

Any explicit playhead seek automatically enters Playback. Scrubbing should never require a separate Preview action first.

Switching Edit -> Playback preserves the playhead. Switching Playback -> Edit also preserves the playhead, but the canvas immediately returns to the raw authored state.

## Transport

### Play / Pause

Play means:

> Let time run from the current playhead.

Play automatically enters Playback.

Play runs only inside the current click interval. It never fires another click gate and never wraps to another interval.

At the end of an interval, Play restarts that same interval from its beginning.

Pause freezes the playhead where it is.

### Advance / Space

Advance means:

> Trigger the next presentation click.

The Advance button and Space are the same command.

Advance automatically enters Playback and exits local Motion-state authoring.

Advance is the only transport command that crosses a click gate. It moves to the next click and starts the newly triggered interval.

At the final click it does not wrap.

## Header

The primary Click Timeline controls are:

```
Click Timeline   [ Edit | Playback ]   [Play/Pause] [Advance]   [+ Click]   [Fit] [Zoom]   [Close]
```

Accessibility / tooltip labels:

- Edit
- Playback
- Play
- Pause playback
- Advance to next click (Space)
- Add Click
- Fit timeline
- Timeline zoom
- Close Click Timeline

The previous global Preview / Edit mode toggle should not exist.

## Block playback

A block-level playback command is different from the global canvas mode.

Use **Play animation** for the block context-menu and Motion-inspector action. Do not call this Preview.

Playing a block enters Playback and starts that block from its authored range.

Adding a new Motion block may continue to auto-play it as immediate feedback. If the Click Timeline is closed, that hidden one-shot returns to Edit when the created block ends. If the timeline is open, Playback remains visible and persistent.

## Edit states

`Edit states` remains a local Motion-authoring tool and is not the opposite of global Playback.

It means:

> Map direct element edits at this playhead position into the selected Motion block.

While Edit states is active:

- the canvas is necessarily showing a resolved Motion state;
- its local state scrubber can change the current Motion time;
- direct edits author Motion state changes;
- Play or Advance exits Edit states before transport begins.

The global distinction stays simple:

- Edit = raw document state.
- Playback = resolved presentation state.

## Implementation state

The user-facing mode must not be inferred from `preview !== null`.

Conceptually the workspace has:

```
canvasMode = edit | playback
cursor = { stageIndex, time }
transport = stopped | playing
editingStates = false | selected Motion block
```

`MotionPreviewState` can remain an internal playback/rendering structure, but the editor renderer receives it only while `canvasMode === "playback"`.

A stopped Playback may resolve directly from the retained cursor even when no transport preview is running.

## Interaction rules

### Seek / scrub

- move the cursor;
- enter Playback;
- stop transport at the requested point;
- render that exact presentation state.

### Edit button

- preserve the cursor;
- stop transport;
- exit Edit states;
- render the raw authored slide.

### Playback button

- preserve the cursor;
- exit Edit states;
- render the presentation state at the cursor.

### Play

- exit Edit states;
- enter Playback;
- run from the cursor within the same interval;
- stop at the interval end;
- never cross a click gate.

### Advance / Space

- exit Edit states;
- enter Playback;
- move to the next click gate;
- start the next interval;
- ignore held-key repeats;
- never wrap at the final click.

### Close timeline

- stop transport;
- exit Edit states;
- return to Edit rendering.

## Naming

Use each term for one concept:

- **Edit**: raw authored canvas.
- **Playback**: presentation state at playhead.
- **Play / Pause**: time transport inside one interval.
- **Advance**: trigger the next click.
- **Edit states**: author a Motion block at a particular state.
- **Play animation**: block-scoped playback.

This keeps canvas mode, transport, presentation input and Motion authoring distinct.
