# ShowMe

ShowMe is a desktop presentation editor for macOS and Windows.
It uses web technologies and supports programmable visual effects, reusable presentation assets, and local presentation files.

![ShowMe editor with slide list, geometric shapes and element properties](docs/images/editor.png)

## Features

- CSS, JavaScript and GLSL shader effects
- Central asset library with deduplication across presentations
- Motion, Click Timeline, slide transitions and presenter tools
- Reusable Text Styles and Templates
- Portable `.smp` presentations and managed `.sme` projects
- PowerPoint import/export and PDF export
- Local-first desktop app for macOS and Windows
- Experimental LAN collaboration

## Effects

Elements can use CSS, JavaScript and GLSL fragment shaders. Effects can use continuous time, Click Timeline progress, or both.

![Selected element with an original GLSL shader and Effect timing controls](docs/images/effects.png)

![Effect Editor with fragment shader code and its live visual preview](docs/images/effect-editor.png)

## Motion and Click Timeline

Motion handles element animation. Click Timeline arranges actions into presentation steps; continuous Effects can remain independent of clicks.

![Motion controls and three staged animation blocks in Click Timeline](docs/images/motion.png)

## Assets

The managed asset library uses content-addressed assets and deduplicates the same asset across presentations.

![Asset library with four original geometric SVG assets beside a presentation](docs/images/assets.png)

## Text Styles and Templates

Text Styles provide presentation-wide typography with local overrides. Templates provide shared slide structure.

![Selected text with Heading+ style and typography controls](docs/images/text-styles.png)

## Presenter

The presenter console shows the current slide, next slide, speaker notes and playback controls.

![Presenter console with current and next slides, speaker notes and navigation](docs/images/presenter.png)

## Installation

This is a source-only release. Use Node.js 24 or 26, as specified in `package.json`.

```bash
git clone https://github.com/KonradJuenger/ShowMe.git
cd ShowMe
npm ci
npm run desktop
```

`npm run desktop` builds the app and launches Electron. For browser development with Vite, run `npm run dev`.

To build the renderer and Electron application without launching:

```bash
npm run build
```

## Files

`.sme` uses ShowMe's managed asset library. `.smp` is a portable presentation package.

Fonts are normally not embedded. Typography may differ on another machine if the same fonts are unavailable.

## Collaboration

LAN collaboration is experimental. It is intended for trusted local networks and the connection is not encrypted.

## Status

v0.1.0 — source release. There are currently no official binaries or installers.

## License

[AGPL-3.0-or-later](LICENSE).
