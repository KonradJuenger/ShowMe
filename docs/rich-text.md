# Inline text weights

Document and presentation file version 2 store text as normalized `runs`, replacing
the version 1 `text` string. Each run contains `text` and an optional numeric
`fontWeight` (100–900). Plain text is derived by joining the runs. Empty text is
`[]`; empty runs, adjacent equal-weight runs and carriage returns are not canonical.
The existing total 100,000 UTF-16-unit text limit remains in force.

Box typography and Text Style references remain unchanged. A run without a weight
inherits the existing resolved box weight, including its established `bold` rule.
An explicit run weight overrides it; 400 therefore remains regular inside a bold
box. Selection Bold makes a mixed selection bold, retaining weights above 700;
toggling an entirely bold selection off applies 400. Outside editing, the box
control retains its existing behavior and explicit inline overrides remain explicit.

The contenteditable surface owns only the active local draft, DOM selection and
composition. Pending caret formatting is local until text is inserted. Normal
input, clipboard commands and formatting produce semantic content changes through
the existing EditorSession, authority, durable recovery and actor history path.
Native browser undo does not create a competing document history. Selection offsets
are UTF-16 and semantic replacements/formatting expand to grapheme boundaries.
Text clipboard interchange remains plain text; element and slide transfers retain
the full run content. Arbitrary pasted HTML is never persisted.

Display, editing and measurement use inline text flow. Font collection includes
every effective run weight. SVG export prepares each face and verifies shaped
fragments against Chromium layout, retaining existing explicit fallback warnings
for unsupported shaping, missing glyphs or synthetic styles. PowerPoint preserves
regular/bold runs; richer numeric weights retain PowerPoint's existing bold-weight
approximation. Weight-only PowerPoint imports use runs; other unsupported inline
typography retains the existing editable-fragment import.

String Effects preserve run weights for unchanged text and prefix/suffix reveals.
Arbitrary generated replacement strings inherit box typography. These are runtime
projections and do not change authored runs.

## Supported upgrade

Persistent boundaries accept public version 1 and current version 2. Version 1 text
becomes one inheriting run (or no runs for empty text), preserving box formatting
and style references. Conversion retains unrelated properties so strict current
validation still rejects unknown or malformed fields. Mixed document component
versions are rejected. No older development formats are accepted.

SME, SMP, browser storage, recovery checkpoints/journals and v1 element/slide
transfers use this conversion. Old recovery journals replay before a current
checkpoint is published on the next append. The package and recovery envelope
versions remain 1: their structures are unchanged and the nested document version
identifies the text representation. Package manifests declare document version 2
and readers verify that it matches the contained file before upgrading.

Element clipboard and slide-transfer payloads write version 2. Collaboration
protocol/document versions are 2; incompatible peers fail the version handshake.
Older ShowMe versions cannot read version 2 documents. No downgrade is provided.
