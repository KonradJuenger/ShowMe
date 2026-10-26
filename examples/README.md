# ShowMe feature presentation

- [Standalone HTML](../docs/showme.html): player, slides and assets in one file.
- [Editable portable deck](showme.smp): open in ShowMe to inspect or change it.

![Overview of the twelve-slide feature presentation](../docs/images/showme-slides.jpg)

The deck covers shared assets, slide editing, animation, CSS/JavaScript/GLSL
effects, presenting, file formats, MCP and collaboration. It includes actual
screenshots of the editor, media library and Click Timeline. Screenshots are
embedded assets, so they work offline too.

## Playback

Download the HTML and open it in a browser. Click the slide, or use the right
arrow or Space, to advance. The left arrow goes back; F toggles fullscreen.
The animation slide has two additional click steps before the next slide.
The shader slides need a browser with WebGL2 support.

The HTML includes its player and assets and works offline.

## Shader example

[Shader source](shaders/vertical-glass.glsl). Adjacent ribs join smoothly with a
periodic lens profile, matching both value and slope. Refraction is horizontal;
the ribs stay vertical. `strength` and `ribSpacing` control the distortion and
rib width. The **Glass shader** Effect block appears in the Click Timeline and
starts on slide entry with a 700 ms duration. The shader uses the block's
progress (`u_p`) to reduce refraction to zero. Changing the block's duration
changes the fade duration. When it finishes, the shader displays the original
image without rib shading. Returning to the slide replays the animation.

The portrait keeps its source aspect ratio and extends past the slide edges.
That allows the shader to sample the image directly in both ShowMe and a normal
browser. The text stays clear: a shader sampling rendered live text would need
ShowMe's native scene capture, which is unavailable in a standard browser.

## Credits

The split compositions, large type and orange/purple palette take direction
from [Deepstack: Generative AI – Pitchdeck](https://dribbble.com/shots/25689795-Deepstack-Generative-AI-Pitchdeck)
by SlabPixel Designer for SlabPixel. The deck uses original layouts and copy;
it contains no Dribbble artwork.

Photos and artwork, under the [Unsplash License](https://unsplash.com/license):

- [MacBook Pro turned on](https://unsplash.com/photos/macbook-pro-turned-on-Bd7gNnWJBkU), Andras Vas.
- [Abstract swirling gradient](https://unsplash.com/photos/abstract-swirling-gradient-of-blue-pink-and-orange-colors-qTZr2TEUNBo), Andrei Castanha. The source description credits “Gradient by Jaquieu.”
- [A man with a beard and a blue shirt](https://unsplash.com/photos/a-man-with-a-beard-and-a-blue-shirt-pbcJrmcLX80), Romello Morris. The glass effect is the deck's shader, not part of the original photo.

These images retain their Unsplash License. ShowMe's screenshots and shader
source are part of this project. Source credits are also in the deck's notes.
