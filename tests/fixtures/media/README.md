# Native media fixture

`prepared-red.webm` is a 160×90, half-second constant-red VP9 WebM generated with:

```sh
ffmpeg -f lavfi -i "color=c=red:s=160x90:d=0.5:r=10" -c:v libvpx-vp9 -an prepared-red.webm
```

The native MCP import/package regression checks that production enrichment creates a drawable red poster and that a cold package in a fresh library renders embedded video content. FFmpeg is not required when running tests. The pixel checks protect the first-frame preparation contract, including the offscreen Chromium black-frame regression.

`native-motion.webm` is an 80×40, one-second, silent VP9 fixture: a white stripe
moves across a red background at 30 fps. It is generated entirely from colors;
there is no external copyrighted media. The native continuity tests use it inside
animated glass alongside JS text and a generated shader. Generate it once with:

```sh
ffmpeg -f lavfi -i "color=c=red:s=80x40:d=1:r=30" -f lavfi -i "color=c=white:s=4x40:d=1:r=30" -filter_complex "[0:v][1:v]overlay=x=mod(t*80\,80):y=0:shortest=1" -c:v libvpx-vp9 -pix_fmt yuv420p -an native-motion.webm
```

FFmpeg is not required to run this test.
