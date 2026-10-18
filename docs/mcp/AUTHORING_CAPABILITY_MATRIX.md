# MCP authoring capability matrix

This matrix records the normal persistent authoring actions available in the current
ShowMe editor and the corresponding model-facing semantic operation. Interaction-only
UI mechanics such as mouse handles, hover state and snapping indicators are
intentionally not MCP operations.

| Area | Human editor capability | MCP semantic surface | State |
| --- | --- | --- | --- |
| Slides | Create a slide | `slide.create` | Implemented |
| Slides | Duplicate a slide | `slide.duplicate` + hierarchy `idMap` | Implemented |
| Slides | Delete a slide | `slide.delete` | Implemented |
| Slides | Reorder a slide | `slide.move` | Implemented |
| Slides | Rename / hide / unhide | `slide.update` | Implemented |
| Slides | Background | `slide.update.background` | Implemented; template-owned background requires independence first |
| Slides | Presenter notes | `slide.update.notes`; inspect with `includeNotes` | Implemented |
| Slides | Per-slide transition | `slide.update.transition` | Implemented |
| Slides | Presentation transition defaults | `deck.transition_defaults.set` | Implemented |
| Slides | Apply Template / detach Template | `slide.template.apply`, `slide.make_independent` | Implemented |
| Deck | Presentation dimensions | `deck.dimensions.set` | Implemented |
| Elements | Text | `element.insert_text` | Implemented |
| Elements | Rectangle / ellipse | `element.insert_shape` | Implemented |
| Elements | Empty clipping Frame | `element.insert_frame` | Implemented |
| Elements | Image / SVG / video | `element.insert_media` using a ShowMe-managed asset ID | Implemented |
| Media library | Discover managed assets | `showme.inspect` target `assets` with bounded query/paging | Implemented; returns IDs/names/type/dimensions, never paths/bytes |
| Geometry | x/y/width/height | `elements.frame.set`, `elements.move` | Implemented, parent-local |
| Geometry | Rotation / scale / flip / origin | `elements.frame.set` | Implemented |
| Geometry | Derived world geometry | `showme.inspect(...includeWorldTransform:true)` | Implemented, read-only derived state |
| Geometry | Alignment / distribution | `elements.align`, `elements.distribute` | Implemented through native commands |
| Appearance | Fill / stroke / stroke width / opacity / radius | `elements.appearance.patch` | Implemented |
| Text | Content + typography + autosize | `text.set`, `text.style` | Implemented with production measurement |
| Text Styles | Apply / clear local overrides | `text.style.apply`, `text.style.clear_overrides` | Implemented |
| Text Styles | Create / update / rename / delete | `text.style.create/update/rename/delete` | Implemented |
| Structure | Front/back/forward/backward | `elements.reorder` | Implemented |
| Structure | Duplicate hierarchy | `elements.duplicate` + `idMap` | Implemented |
| Structure | Group / ungroup | `elements.group`, `elements.ungroup` | Implemented using ShowMe's neutral Frame semantics |
| Structure | Reparent / nested editing | `elements.reparent` | Implemented, preserves world appearance |
| Structure | Delete | `elements.remove` | Implemented |
| Frames/media | Fit / fill / free | `frame.fit`, `frame.fill`, `frame.free` | Implemented |
| Frames/media | Crop/content frame | `frame.content_transform.set` | Implemented |
| Frames/media | Center / reset | `frame.content_center`, `frame.content_reset` | Implemented |
| Frames/media | Rotation / flips / zoom / anchors | `media.transform.patch` | Implemented where the current media rule supports the property |
| Video | Volume / mute / loop / autoplay / in-out time | `video.playback.patch` | Implemented |
| Layers | Create / rename / visibility / lock / color | `layer.create`, `layer.update` | Implemented |
| Layers | Delete / reorder | `layer.delete`, `layer.reorder` | Implemented |
| Layers | Move content between editable layers | `elements.reparent` | Implemented |
| Creative | Deck CSS / element classes | Existing stylesheet/class operations | Implemented |
| Creative | GLSL / CSS / text-JS Effects | Existing Effect operations + `showme.authoring` | Preserved |
| Creative | Native Motion / Presence | Existing Motion/Presence operations | Preserved |

## Coordinate and hierarchy contract

Persistent Element geometry is parent-local. World bounds and transforms are derived
inspection data and are never persisted as a second coordinate source. Layer IDs and
container Element IDs are the valid authoring parents. Reparenting, grouping,
ungrouping and duplication call the same core commands as the human editor.

A `slide.create` or `slide.duplicate` may be the first operation of an atomic
batch. Following operations can author that new slide before the single commit.
Creation can use an optional validated stable ID when later operations in the same
batch must refer to the object. Normal creation still generates IDs by default.

## Intentionally not exposed

- Arbitrary filesystem paths, raw media bytes and direct Library imports. MCP can
  inspect the managed Library and insert an existing asset ID, but importing a new
  filesystem asset remains a human/host action.
- Raw `DocumentOperation[]`, direct `.sme` editing, Electron IPC passthrough,
  renderer DOM mutation or arbitrary JavaScript execution.
- Mouse/handle gestures, hover state, temporary snapping indicators and other
  interaction-only UI state. MCP expresses the resulting authoring intent.
- A second document model, second authority or alternate preview renderer.
- Element types or appearance controls that the current ShowMe editor does not expose.

The invariant remains: MCP is another ShowMe editor client, not a privileged scripting
API over ShowMe internals.
