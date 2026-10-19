# Native media fixture

`prepared-red.webm` is a 160×90, half-second constant-red VP9 WebM generated with:

```sh
ffmpeg -f lavfi -i "color=c=red:s=160x90:d=0.5:r=10" -c:v libvpx-vp9 -an prepared-red.webm
```

The native MCP import/package regression checks that production enrichment creates a drawable red poster and that a cold package in a fresh library renders embedded video content. FFmpeg is not required when running tests. The pixel checks protect the first-frame preparation contract, including the offscreen Chromium black-frame regression.
